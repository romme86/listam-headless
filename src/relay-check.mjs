import DHT from 'hyperdht'
import { parseRelayKey, relayFingerprints } from '@listam/backend/lib/relay.mjs'

// Synthetic encrypted echo with direct hole punching disabled. No Listam
// database or user content is opened. Run from another host for reachability.
export async function checkRelay({ key, bootstrap = null, timeoutMs = 45000 }) {
    const publicKey = parseRelayKey(key)
    if (!publicKey) throw new Error('invalid relay public key')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('invalid relay check deadline')
    const host = new DHT(bootstrap ? { bootstrap } : {})
    const guest = new DHT(bootstrap ? { bootstrap } : {})
    const identity = DHT.keyPair()
    const expected = Buffer.from(`listam-relay-health:${Date.now()}`)
    const started = Date.now()
    let socket, timer, stopped = false
    const server = host.createServer({ relayThrough: publicKey, holepunch: false, shareLocalAddress: false }, (connection) => {
        connection.on('error', () => {})
        connection.on('data', (data) => connection.write(data))
    })
    try {
        await Promise.race([
            (async () => {
                await server.listen(identity)
                if (stopped) throw new Error('relay check stopped')
                socket = guest.connect(identity.publicKey, { relayThrough: publicKey, localConnection: false })
                await new Promise((resolve, reject) => {
                    let received = Buffer.alloc(0)
                    socket.on('error', reject)
                    socket.on('close', () => reject(new Error('relay closed before echo')))
                    socket.on('data', (data) => {
                        received = Buffer.concat([received, data])
                        if (received.length < expected.length) return
                        if (!received.equals(expected)) reject(new Error('relay returned unexpected bytes'))
                        else resolve()
                    })
                    socket.write(expected)
                })
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('relay check timed out')), timeoutMs) }),
        ])
        return { ok: true, relay: relayFingerprints([publicKey])[0], elapsedMs: Date.now() - started, bytes: expected.length }
    } catch (error) {
        return { ok: false, relay: relayFingerprints([publicKey])[0], elapsedMs: Date.now() - started, reason: error?.message ?? 'relay check failed' }
    } finally {
        stopped = true
        clearTimeout(timer)
        socket?.destroy()
        await server.close().catch(() => {})
        await Promise.allSettled([guest.destroy(), host.destroy()])
    }
}
