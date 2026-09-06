// Blind-relay server: the owner's always-on peer as a TURN-style relay for
// devices that cannot hole punch (2026-08-26 field failure — three phones, all
// on carrier-grade NAT, none of them paired). hyperdht aborts a double-random
// NAT pair without even attempting a punch, so the only way those devices ever
// meet is a third box with a reachable address relaying the UDX stream between
// them. A relaying peer dials this address and hands its raw stream to
// blind-relay's client (hyperdht/lib/connect.js relayConnection); everything
// here is the matching server half.
//
// "Blind" is literal: the relay pairs two peers on a token they exchanged
// through the DHT and pumps bytes between the two raw streams. It terminates no
// encryption and holds no list key — it is not a member of anything it relays,
// which is why it can be pointed at by strangers' clients without widening the
// C2 credential boundary.
import nodeFs from 'node:fs'
import DHT from 'hyperdht'
import b4a from 'b4a'
import z32 from 'z32'
import { randomBytes } from 'hypercore-crypto'
import { Server as BlindRelayServer } from 'blind-relay'
import { createFileSecretStore } from '@listam/secrets'
import { writeStatus } from './status.mjs'

const RELAY_SEED_KEY = 'listam.relay.v1.serverSeed'
export const RELAY_KEYS_FILE = 'headless-relay-keys.json'
// Unattended and silent by design, so log a heartbeat the operator can grep in
// journald. Five minutes is short enough to see a relay that stopped pairing
// and long enough not to drown the journal on a quiet box.
export const DEFAULT_STATS_INTERVAL_MS = 300_000
const STATUS_INTERVAL_MS = 5_000
const ROUTINE_DISCONNECTS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE'])

export function relayKeysPath(storageDir) {
    return `${storageDir}/${RELAY_KEYS_FILE}`
}

// The relay address is baked into client builds and handed out to people the
// owner will never talk to again, so it must survive restarts, reinstalls and
// storage moves: derive it from a seed persisted beside the other device-local
// service material (same convention as the owner-control identity in
// control.mjs). Rotating it silently would strand every client that already
// has the old key.
export async function loadRelayKeyPair({ fs = nodeFs, storageDir }) {
    fs.mkdirSync(storageDir, { recursive: true })
    const keyStore = createFileSecretStore({ fs, path: relayKeysPath(storageDir) })
    let seedHex = await keyStore.getItem(RELAY_SEED_KEY)
    if (!seedHex) {
        seedHex = randomBytes(32).toString('hex')
        await keyStore.setItem(RELAY_SEED_KEY, seedHex)
    }
    return DHT.keyPair(b4a.from(seedHex, 'hex'))
}

export function relayPublicKeyZ32(publicKey) {
    return z32.encode(publicKey)
}

export async function startRelay({
    fs = nodeFs,
    storageDir,
    logger,
    bootstrap = null,
    statsIntervalMs = DEFAULT_STATS_INTERVAL_MS,
    now = Date.now,
}) {
    if (!storageDir) throw new Error('A storageDir is required')

    const keyPair = await loadRelayKeyPair({ fs, storageDir })
    const dht = new DHT(bootstrap ? { bootstrap } : {})
    const startedAt = now()
    let sessionErrors = 0

    const relay = new BlindRelayServer({
        // blind-relay only matches tokens and pumps bytes; the raw UDX streams
        // it hands to each side come from the DHT node so their ids stay unique
        // within this process (hyperdht's RawStreamSet owns that bookkeeping,
        // and its `firewall` hook is the one blind-relay passes in).
        createStream: (opts) => dht.createRawStream(opts),
    })

    const server = dht.createServer((socket) => {
        // A relay is only useful if it is boringly durable. The peers it serves
        // are by definition on flaky mobile links, so a socket dying mid-pairing
        // is the normal case, not an exception — and an unhandled 'error' on
        // either the encrypted socket or the relay session takes the whole
        // process down with it.
        socket.on('error', () => {})
        let session = null
        try {
            session = relay.accept(socket, { id: socket.remotePublicKey })
        } catch (error) {
            logger?.log?.('[ERROR] Relay session could not be accepted:', error)
            socket.destroy()
            return
        }
        session.on('error', (error) => {
            sessionErrors++
            // A peer on a mobile link dropping its socket is the expected end of
            // a relayed session, not an incident: log only the unexpected kinds,
            // or a busy relay drowns its own journal in ECONNRESET lines. The
            // counter in the periodic stats line still shows the volume.
            if (!ROUTINE_DISCONNECTS.has(error?.code)) {
                logger?.log?.('[WARNING] Relay session error:', error)
            }
        })
        socket.on('close', () => session.destroy())
    })

    try {
        await server.listen(keyPair)
    } catch (error) {
        await relay.close().catch(() => {})
        await dht.destroy().catch(() => {})
        throw error
    }

    function stats() {
        // The `active` entries are getters over the cumulative counters; spread
        // them into a plain snapshot so callers can serialize it.
        return {
            sessions: { ...relay.stats.sessions },
            pairings: { ...relay.stats.pairings },
            streams: { ...relay.stats.streams },
            sessionErrors,
            dht: {
                punches: { ...dht.stats.punches },
                relaying: { ...dht.stats.relaying },
                socketPool: {
                    ...dht.stats.socketPool,
                    active: dht.stats.socketPool.socketsAdded - dht.stats.socketPool.socketsRemoved,
                },
            },
            uptimeMs: now() - startedAt,
        }
    }

    function snapshot() {
        return {
            role: 'relay',
            // status.mjs otherwise carries fingerprints only. This one key is
            // public by construction — it is the address clients dial and the
            // operator has to copy out of this box — so the status file is the
            // convenient place to read it back without stopping the service.
            publicKey: relayPublicKeyZ32(keyPair.publicKey),
            relay: stats(),
        }
    }

    // Same status file every peer role writes, which is why a relay wants its
    // own storage dir: co-locating it with `run` would leave the two services
    // overwriting each other's snapshot (the installer gives it one).
    const statusTimer = setInterval(() => writeStatus(fs, storageDir, snapshot(), now()), STATUS_INTERVAL_MS)
    statusTimer?.unref?.()
    writeStatus(fs, storageDir, snapshot(), now())

    let statsTimer = null
    if (statsIntervalMs > 0) {
        statsTimer = setInterval(() => logger?.log?.('[INFO] Relay stats', stats()), statsIntervalMs)
        statsTimer?.unref?.()
    }

    let closing = null
    async function close() {
        if (closing) return closing
        closing = (async () => {
            clearInterval(statusTimer)
            if (statsTimer) clearInterval(statsTimer)
            try {
                await relay.close()
            } catch (error) {
                logger?.log?.('[ERROR] Relay session teardown failed:', error)
            }
            try {
                await server.close()
            } catch {}
            await dht.destroy()
            writeStatus(fs, storageDir, { ...snapshot(), stopped: true }, now())
        })()
        return closing
    }

    return {
        publicKey: keyPair.publicKey,
        publicKeyZ32: relayPublicKeyZ32(keyPair.publicKey),
        publicKeyHex: b4a.toString(keyPair.publicKey, 'hex'),
        stats,
        close,
    }
}
