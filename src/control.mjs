// P2P owner-control server (H1, Phase 14).
//
// The headless instance listens on a persistent hyperdht keypair (the control
// address). Trusted devices — paired once through an operator-minted,
// single-use, short-lived code — send signed command envelopes over the
// encrypted stream as JSON lines. Every envelope is authorized by
// @listam/owner-control: registered (not revoked) device key, valid
// signature, fresh timestamp, strictly increasing per-device sequence, and a
// capability grant matching the command. Capabilities are fixed by the
// pairing code the operator created; clients cannot request broader scopes.
// The device registry (public keys, grants, seq high-water marks) persists
// across restarts; unredeemed pairing offers do not.
import DHT from 'hyperdht'
import b4a from 'b4a'
import { randomBytes } from 'hypercore-crypto'
import readline from 'node:readline'
import {
    applyRotation,
    authorizeCommand,
    createDeviceRegistry,
    createPairingOffer,
    deviceIdFromPublicKey,
    verifyPairingRequest,
} from '@listam/owner-control'
import { createFileSecretStore, secretFingerprint } from '@listam/secrets'

const CONTROL_SEED_KEY = 'listam.control.v1.serverSeed'
const AUDIT_RING_MAX = 100

export async function startOwnerControl({ fs, storageDir, config, executor, onShutdownRequested, logger, now = Date.now }) {
    if (typeof executor !== 'function') throw new Error('An executor(command, payload, device) is required')

    // The control identity is device-local service material, independent of
    // any list encryption keys — a blind helper may hold it without crossing
    // the C2 boundary.
    const keyStore = createFileSecretStore({ fs, path: `${storageDir}/headless-control-keys.json` })
    let seedHex = await keyStore.getItem(CONTROL_SEED_KEY)
    if (!seedHex) {
        seedHex = randomBytes(32).toString('hex')
        await keyStore.setItem(CONTROL_SEED_KEY, seedHex)
    }
    const serverKeyPair = DHT.keyPair(b4a.from(seedHex, 'hex'))

    const registryPath = `${storageDir}/headless-devices.json`
    const registry = createDeviceRegistry(readRegistry(fs, registryPath))
    const pairingOffers = new Map()
    const audit = []

    function record(entry) {
        audit.push({ at: now(), ...entry })
        if (audit.length > AUDIT_RING_MAX) audit.shift()
        logger?.log?.('[AUDIT] owner-control', {
            ...entry,
            deviceId: entry.deviceId ? secretFingerprint(entry.deviceId) : undefined,
        })
    }

    function persistRegistry() {
        try {
            fs.writeFileSync(registryPath, JSON.stringify(registry.toJSON(), null, 2), { mode: 0o600 })
        } catch (error) {
            logger?.log?.('[ERROR] Failed to persist owner-control device registry:', error)
        }
    }

    const dht = new DHT(config.bootstrap ? { bootstrap: config.bootstrap } : {})
    const server = dht.createServer((socket) => {
        socket.on('error', () => {})
        const rl = readline.createInterface({ input: socket })
        rl.on('line', async (line) => {
            let message = null
            try {
                message = JSON.parse(line)
            } catch {
                socket.write(JSON.stringify({ ok: false, reason: 'malformed' }) + '\n')
                return
            }
            const reply = message?.type === 'pair'
                ? handlePairing(message)
                : await handleEnvelope(message)
            try {
                socket.write(JSON.stringify(reply) + '\n')
            } catch {}
            if (reply.willShutdown) {
                setTimeout(() => onShutdownRequested?.(), 150)
            }
        })
    })
    await server.listen(serverKeyPair)

    function handlePairing(request) {
        const offer = typeof request?.secretHashHex === 'string' ? pairingOffers.get(request.secretHashHex) : null
        const verified = verifyPairingRequest(request, offer ?? { used: true }, { now: now() })
        if (!verified.ok) {
            record({ event: 'pair-rejected', reason: verified.reason, deviceId: request?.deviceId })
            return { type: 'pair-result', deviceId: request?.deviceId, ok: false, reason: verified.reason }
        }

        offer.used = true
        pairingOffers.delete(request.secretHashHex)
        const added = registry.addDevice({ ...verified.device, now: now() })
        if (!added.ok) {
            record({ event: 'pair-rejected', reason: added.reason, deviceId: verified.device.deviceId })
            return { type: 'pair-result', deviceId: verified.device.deviceId, ok: false, reason: added.reason }
        }
        persistRegistry()
        record({ event: 'paired', deviceId: added.device.deviceId, capabilities: added.device.capabilities })
        return {
            type: 'pair-result',
            deviceId: added.device.deviceId,
            ok: true,
            name: added.device.name,
            capabilities: added.device.capabilities,
        }
    }

    async function handleEnvelope(envelope) {
        const authorized = authorizeCommand(registry, envelope, { now: now() })
        if (!authorized.ok) {
            record({ event: 'command-rejected', reason: authorized.reason, command: envelope?.command, deviceId: envelope?.deviceId })
            return { commandId: envelope?.commandId ?? null, ok: false, reason: authorized.reason }
        }
        persistRegistry() // the seq high-water mark advanced

        if (envelope.command === 'rotate') {
            const rotated = applyRotation(registry, envelope, { now: now() })
            persistRegistry()
            record({ event: rotated.ok ? 'device-rotated' : 'rotation-rejected', deviceId: envelope.deviceId, reason: rotated.ok ? undefined : rotated.reason })
            return { commandId: envelope.commandId, ok: rotated.ok, ...(rotated.ok ? { newDeviceId: rotated.device.deviceId } : { reason: rotated.reason }) }
        }

        try {
            const result = await executor(envelope.command, envelope.payload ?? null, authorized.device)
            record({ event: 'command', command: envelope.command, deviceId: envelope.deviceId, ok: result?.ok !== false })
            return { commandId: envelope.commandId, ok: result?.ok !== false, ...result }
        } catch (error) {
            record({ event: 'command-failed', command: envelope.command, deviceId: envelope.deviceId })
            return { commandId: envelope.commandId, ok: false, reason: error?.message ?? 'command failed' }
        }
    }

    return {
        publicKeyHex: deviceIdFromPublicKey(serverKeyPair.publicKey),
        createPairingCode(capabilities) {
            const { code, offer } = createPairingOffer({
                serverPublicKey: serverKeyPair.publicKey,
                capabilities,
                now: now(),
            })
            pairingOffers.set(offer.secretHashHex, offer)
            record({ event: 'pairing-offer-created', capabilities: offer.capabilities })
            return { code, capabilities: offer.capabilities, expiresAt: offer.expiresAt }
        },
        listDevices() {
            return registry.listDevices()
        },
        revokeDevice(deviceId) {
            const revoked = registry.revokeDevice(deviceId, now())
            if (revoked.ok) persistRegistry()
            record({ event: revoked.ok ? 'device-revoked' : 'revoke-rejected', deviceId, reason: revoked.ok ? undefined : revoked.reason })
            return revoked
        },
        recentAudit() {
            return [...audit]
        },
        async close() {
            try {
                await server.close()
            } catch {}
            try {
                await dht.destroy()
            } catch {}
        },
    }
}

function readRegistry(fs, path) {
    try {
        return JSON.parse(fs.readFileSync(path, 'utf8'))
    } catch {
        return null
    }
}
