#!/usr/bin/env node
// Listam headless personal server (Phase 13).
//
//   node headless.mjs setup  --storage <dir> --role participant|blind-storage
//                            [--base-key <hex>] [--bootstrap host:port,...]
//                            [--max-storage-bytes <n>] [--force]
//   node headless.mjs run    --storage <dir> [--bootstrap host:port,...]
//   node headless.mjs status --storage <dir>
//   node headless.mjs install   --storage <dir> [--role ...] [--base-key <hex>]
//                               [--invite <key>]   (Linux: systemd user unit)
//   node headless.mjs uninstall --storage <dir>
//
// `run` is the long-lived owned peer. It accepts the scriptable harness
// primitives as JSON lines on stdin (status, invite/print-invite, join,
// add/add-item, edit/edit-item, done/mark-done, delete/delete-item,
// dump/dump-list, export, import, shutdown — plus pin/peek in blind mode)
// and answers one JSON line per request. The owner-control P2P channel is
// Phase 14; until then stdin (under the operator's shell/SSH) is the only
// control surface, and nothing is exposed on the network beyond replication.
import fs from 'node:fs'
import process from 'node:process'
import readline from 'node:readline'
import { createLogger } from '@listam/logging'
import { buildConfig, loadConfig, saveConfig, parseBootstrap, configPath } from './src/config.mjs'
import { readStatus } from './src/status.mjs'
import { startHeadlessService } from './src/service.mjs'
import { startBlindHelper } from './src/blind.mjs'
import { startOwnerControl } from './src/control.mjs'

const logger = createLogger({ app: 'headless', write: (line) => process.stderr.write(line + '\n') })

function parseArgs(argv) {
    const args = { _: [] }
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]
        if (token.startsWith('--')) {
            const key = token.slice(2)
            const next = argv[i + 1]
            if (next !== undefined && !next.startsWith('--')) {
                args[key] = next
                i++
            } else {
                args[key] = true
            }
        } else {
            args._.push(token)
        }
    }
    return args
}

function out(message) {
    process.stdout.write(JSON.stringify(message) + '\n')
}

function fail(message) {
    out({ ok: false, message })
    process.exit(1)
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const command = args._[0] ?? 'run'
    const storageDir = typeof args.storage === 'string' ? args.storage : null
    if (!storageDir) fail('--storage <dir> is required')

    if (command === 'setup') {
        if (loadConfig(fs, storageDir) && args.force !== true) {
            fail(`config already exists at ${configPath(storageDir)} (use --force to overwrite)`)
        }
        const built = buildConfig({
            role: args.role ?? 'participant',
            baseKeyHex: args['base-key'],
            bootstrap: args.bootstrap,
            maxStorageBytes: args['max-storage-bytes'] ? Number(args['max-storage-bytes']) : undefined,
            name: typeof args.name === 'string' ? args.name : undefined,
        })
        if (!built.ok) fail(built.reason)
        saveConfig(fs, storageDir, built.config)
        out({ ok: true, config: built.config, path: configPath(storageDir) })
        return
    }

    if (command === 'status') {
        const snapshot = readStatus(fs, storageDir)
        if (!snapshot) fail('no status file; is the service set up and running?')
        out({ ok: true, status: snapshot })
        process.exit(snapshot.stale ? 1 : 0)
    }

    // The installer pulls in child_process/systemd plumbing the long-lived
    // service never needs; load it only for these commands.
    if (command === 'install') {
        const { installService } = await import('./src/install.mjs')
        const result = await installService({
            fs,
            storageDir,
            role: args.role ?? 'participant',
            baseKeyHex: typeof args['base-key'] === 'string' ? args['base-key'] : null,
            inviteKey: typeof args.invite === 'string' ? args.invite : null,
        })
        out(result)
        process.exit(result.ok ? 0 : 1)
    }

    if (command === 'uninstall') {
        const { uninstallService } = await import('./src/install.mjs')
        const result = uninstallService({ fs, storageDir })
        out(result)
        process.exit(result.ok ? 0 : 1)
    }

    if (command !== 'run') fail(`unknown command ${command} (expected setup, run, status, install, or uninstall)`)

    const config = loadConfig(fs, storageDir)
    if (!config) fail(`no valid config at ${configPath(storageDir)}; run setup first`)
    // A --bootstrap flag overrides the stored one (the test harness passes a
    // private testnet here).
    const bootstrapOverride = parseBootstrap(args.bootstrap)
    if (bootstrapOverride) config.bootstrap = bootstrapOverride

    const instance = config.role === 'blind-storage'
        ? await startBlindHelper({ fs, storageDir, config, logger })
        : await startHeadlessService({ fs, storageDir, config, logger })

    // The H1 owner-control channel: remote commands run through the same op
    // surface, but only after the signed-envelope/capability authorization in
    // src/control.mjs. The executor narrows what each role offers remotely.
    let control = null
    const executor = async (command, payload) => {
        switch (command) {
            case 'status':
                return { status: instance.snapshot() }
            case 'diagnostics':
                return { status: instance.snapshot(), audit: control?.recentAudit() ?? [] }
            case 'invite':
                if (config.role === 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                return instance.handleOp({ op: 'invite' })
            case 'export':
                if (config.role === 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                // Remote exports return data only; nothing is written server-side.
                return instance.handleOp({ op: 'export' })
            case 'import':
                if (config.role === 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                return instance.handleOp({ op: 'import', data: payload?.data })
            case 'topics':
                if (config.role !== 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                if (payload?.action !== 'pin') return { ok: false, reason: 'unknown-topics-action' }
                return instance.handleOp({ op: 'pin', key: payload.key })
            case 'shutdown':
                return { willShutdown: true }
            default:
                return { ok: false, reason: 'unknown-command' }
        }
    }
    control = await startOwnerControl({
        fs,
        storageDir,
        config,
        executor,
        onShutdownRequested: () => void shutdown(0),
        logger,
    })

    out({ event: 'ready', role: config.role, controlPublicKey: control.publicKeyHex })

    let shuttingDown = false
    async function shutdown(code = 0) {
        if (shuttingDown) return
        shuttingDown = true
        // A wedged teardown (e.g. the P2P stack blocked against an unreachable
        // DHT, or an autobase append that cannot complete) must not keep the
        // process alive after the operator asked it to stop. Corestore writes
        // are crash-safe, so forcing the exit loses nothing a SIGKILL would
        // have preserved.
        const watchdog = setTimeout(() => {
            logger.log('[ERROR] Shutdown did not complete within 5s; forcing exit')
            process.exit(code)
        }, 5_000)
        watchdog.unref?.()
        try {
            await control?.close()
        } catch {}
        try {
            await instance.shutdown()
        } catch (error) {
            logger.log('[ERROR] Shutdown error:', error)
        }
        process.exit(code)
    }

    process.on('SIGINT', () => void shutdown(0))
    process.on('SIGTERM', () => void shutdown(0))

    const rl = readline.createInterface({ input: process.stdin })
    // stdin EOF means the controlling process (operator shell or harness) is
    // gone; shut down instead of lingering as an orphan. Detached/daemon runs
    // are an owner-control concern (Phase 14).
    rl.on('close', () => void shutdown(0))
    rl.on('line', async (line) => {
        if (!line.trim()) return
        let request = null
        try {
            request = JSON.parse(line)
        } catch {
            out({ ok: false, message: 'requests must be JSON lines' })
            return
        }
        try {
            const result = await handleOperatorOp(request)
            out({ id: request.id, ok: result?.ok !== false, ...result })
            if (result?.shutdown) await shutdown(0)
        } catch (error) {
            out({ id: request.id, ok: false, message: error?.message ?? String(error) })
        }
    })

    // Owner-control management stays on the operator surface (local shell /
    // SSH): minting pairing codes, listing devices, and revoking them are not
    // remote capabilities.
    async function handleOperatorOp(request) {
        switch (request.op) {
            case 'control-info':
                return { controlPublicKey: control.publicKeyHex, devices: control.listDevices() }
            case 'control-pair':
                return control.createPairingCode(request.capabilities ?? [])
            case 'control-devices':
                return { devices: control.listDevices() }
            case 'control-revoke':
                return control.revokeDevice(request.deviceId)
            case 'control-audit':
                return { audit: control.recentAudit() }
            default:
                return instance.handleOp(request)
        }
    }
}

main().catch((error) => {
    logger.log('[ERROR] Headless service failed to start:', error)
    out({ ok: false, message: error?.message ?? String(error) })
    process.exit(1)
})
