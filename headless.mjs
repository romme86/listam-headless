#!/usr/bin/env node
// Listam headless personal server (Phase 13).
//
//   node headless.mjs setup  --storage <dir> --role participant|blind-storage
//                            [--base-key <hex>] [--bootstrap host:port,...]
//                            [--max-storage-bytes <n>] [--force]
//   node headless.mjs run    --storage <dir> [--bootstrap host:port,...]
//   node headless.mjs status --storage <dir>
//   node headless.mjs relay  --storage <dir> [--bootstrap host:port,...]
//                            [--port <udp-port>] [--stats-interval <seconds>] [--print-key]
//   node headless.mjs install   --storage <dir> [--role participant|blind-storage|relay]
//                               [--base-key <hex>] [--invite <key>] [--port <relay-udp-port>]
//                                                  (Linux: systemd user unit)
//   node headless.mjs uninstall --storage <dir> [--role ...]
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

    if (command === 'relay-check') {
        const { checkRelay } = await import('./src/relay-check.mjs')
        const { DEFAULT_RELAY_KEYS } = await import('@listam/backend/lib/relay.mjs')
        const keys = typeof args.key === 'string' ? [args.key] : DEFAULT_RELAY_KEYS
        const results = []
        for (const key of keys) results.push(await checkRelay({ key, timeoutMs: args.timeout ? Number(args.timeout) : 45000, bootstrap: parseBootstrap(args.bootstrap) }))
        const report = { ok: results.every((result) => result.ok), updatedAt: Date.now(), results }
        fs.mkdirSync(storageDir, { recursive: true })
        fs.writeFileSync(`${storageDir}/relay-health.json`, JSON.stringify(report, null, 2))
        out(report)
        process.exit(report.ok ? 0 : 1)
    }

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
            // Scheduled-backup knobs (participant-only). --no-backup-schedule
            // persists the schedule off; --backup-password seeds the encryption
            // password so a fresh box gets rolling backups non-interactively.
            // Prefer LISTAM_BACKUP_PASSWORD env to keep secrets out of argv/history.
            backupScheduled: args['no-backup-schedule'] === true ? false : undefined,
            backupPassword: typeof args['backup-password'] === 'string' ? args['backup-password'] : undefined,
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

    // The blind relay is a peer of nothing: no config, no base, no list keys —
    // just a reachable hyperdht address that pairs two NAT-stuck peers and
    // pumps bytes between them. It therefore takes no `setup` step; the only
    // state it keeps is the seed behind its stable public key.
    if (command === 'relay') {
        const { startRelay, loadRelayKeyPair, relayPublicKeyZ32 } = await import('./src/relay.mjs')

        // Key-only mode: the operator has to copy this key into client builds,
        // and asking them to start (and then kill) a long-lived service to read
        // it is how keys end up transcribed wrong. Creates the seed if this is
        // a fresh storage dir, so the key can be minted before first serve.
        if (args['print-key'] === true) {
            const keyPair = await loadRelayKeyPair({ fs, storageDir })
            out({ ok: true, publicKey: relayPublicKeyZ32(keyPair.publicKey) })
            return
        }

        // A relay box may also carry a participant config; honour its bootstrap
        // so a private testnet does not need the flag repeated.
        const bootstrap = parseBootstrap(args.bootstrap) ?? loadConfig(fs, storageDir)?.bootstrap ?? null
        // A valueless `--stats-interval` parses to `true`, and Number(true) is 1:
        // taking it would turn the five-minute heartbeat into a per-second
        // journald flood on a box meant to run unattended for months.
        const statsSeconds = typeof args['stats-interval'] === 'string' ? Number(args['stats-interval']) : NaN
        const relay = await startRelay({
            fs,
            storageDir,
            logger,
            bootstrap,
            port: args.port,
            ...(Number.isFinite(statsSeconds) && statsSeconds > 0 ? { statsIntervalMs: statsSeconds * 1000 } : {}),
        })

        // stdout stays machine-readable for scripts; the banner on stderr is for
        // the human who has to retype this key somewhere else.
        out({ event: 'relay-ready', publicKey: relay.publicKeyZ32, storage: storageDir })
        process.stderr.write(
            '\n  Listam blind relay is listening.\n' +
            '  Give this public key to clients as their relayThrough address:\n\n' +
            `      ${relay.publicKeyZ32}\n\n`,
        )

        let relayStopping = false
        const stopRelay = async () => {
            if (relayStopping) return
            relayStopping = true
            // Same reasoning as the service shutdown below: a teardown blocked
            // against an unreachable DHT must not outlive the stop request.
            const watchdog = setTimeout(() => {
                logger.log('[ERROR] Relay shutdown did not complete within 5s; forcing exit')
                process.exit(0)
            }, 5_000)
            watchdog.unref?.()
            try {
                await relay.close()
            } catch (error) {
                logger.log('[ERROR] Relay shutdown error:', error)
            }
            process.exit(0)
        }
        process.on('SIGINT', () => void stopRelay())
        process.on('SIGTERM', () => void stopRelay())
        // No stdin op surface (nothing to operate), so unlike `run` the relay
        // does not treat EOF as a stop: it is driven entirely by signals, which
        // is what lets the systemd unit start it without a control FIFO.
        return
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
            port: args.port,
        })
        out(result)
        process.exit(result.ok ? 0 : 1)
    }

    if (command === 'uninstall') {
        const { uninstallService } = await import('./src/install.mjs')
        const result = uninstallService({ fs, storageDir, role: args.role ?? 'participant' })
        out(result)
        process.exit(result.ok ? 0 : 1)
    }

    if (command !== 'run') fail(`unknown command ${command} (expected setup, run, relay, status, install, or uninstall)`)

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
    const executor = async (command, payload, device) => {
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
            case 'backup-schedule':
                // Observe (no payload.enabled) or toggle the rolling backup
                // schedule remotely. A blind-storage peer holds no decryptable
                // data, so there is nothing to back up.
                if (config.role === 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                if (payload && typeof payload.enabled === 'boolean') {
                    return instance.handleOp({ op: 'set-backup-schedule', enabled: payload.enabled })
                }
                return instance.handleOp({ op: 'list-backups' })
            case 'topics':
                if (config.role !== 'blind-storage') return { ok: false, reason: 'not-supported-for-role' }
                if (payload?.action === 'manifest') {
                    return instance.handleOp({ op: 'mirror-manifest', manifest: payload.manifest, owner: device.deviceId })
                }
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
