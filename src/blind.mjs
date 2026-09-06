// Blind-storage helper (C2 credential boundary).
//
// A blind helper keeps a durable replica of pinned cores as ciphertext and
// serves them to peers. It is configured with core PUBLIC keys only and never
// receives — and has no code path to accept — the Autobase encryption key:
// there is no Autobase here at all, just Corestore + Hyperswarm. Blocks are
// stored and served exactly as encrypted on the wire; this process cannot
// linearize, decrypt, or read list content. Richer "read but not write"
// tiers are cryptographically unsupported today (finding C2) and must not be
// promised.
//
// v1 pins the base (bootstrap) core key the owner hands over at setup; the
// full writer/view core set syncs over owner-control in Phase 14.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { secretFingerprint } from '@listam/secrets'
import { createStorageLease } from '@listam/backend/lib/storage-lease.mjs'
import { writeStatus } from './status.mjs'
import { createQuotaMonitor } from './quota.mjs'

export async function startBlindHelper({ fs, storageDir, config, logger, now = Date.now, quotaIntervalMs = 30_000 }) {
    const instanceId = Math.random().toString(36).slice(2, 8)
    const lease = createStorageLease({
        fs,
        path: `${storageDir}/lista-blind.lock`,
        instanceId,
        role: 'blind-storage',
    })
    const acquired = lease.acquire()
    if (!acquired.ok) {
        throw new Error('Storage lease is held by another running instance')
    }
    if (acquired.recoveredStale) {
        logger?.log?.('[AUDIT] Recovered a stale blind-helper storage lease')
    }
    lease.startHeartbeat(() => {
        logger?.log?.('[ERROR] Blind-helper storage lease was lost to another instance')
    })

    const store = new Corestore(`${storageDir}/blind-store`)
    await store.ready()

    const swarm = new Hyperswarm(config.bootstrap ? { bootstrap: config.bootstrap } : {})
    let quotaPaused = false
    let peerCount = 0
    swarm.on('connection', (conn) => {
        if (quotaPaused) { conn.on('error', () => {}); conn.destroy(); return }
        peerCount = swarm.connections.size
        conn.on('close', () => {
            peerCount = swarm.connections.size
        })
        conn.on('error', () => {})
        store.replicate(conn)
    })

    const cores = new Map()
    const downloads = new Map()
    function startDownload(keyHex, core) {
        if (quotaPaused || downloads.has(keyHex)) return
        downloads.set(keyHex, core.download({ start: 0, end: -1 }))
        swarm.join(crypto.discoveryKey(b4a.from(keyHex, 'hex')), { server: true, client: true })
    }
    async function pin(keyHex) {
        if (cores.has(keyHex)) return cores.get(keyHex)
        const core = store.get({ key: b4a.from(keyHex, 'hex') })
        await core.ready()
        // Durable storage role: fetch everything, including future appends.
        cores.set(keyHex, core)
        startDownload(keyHex, core)
        logger?.log?.('[INFO] Pinned core for blind replication', { fingerprint: secretFingerprint(keyHex) })
        return core
    }

    for (const keyHex of config.pins ?? []) {
        await pin(keyHex)
    }

    const quota = createQuotaMonitor({
        fs,
        path: storageDir,
        maxBytes: config.maxStorageBytes,
        intervalMs: quotaIntervalMs,
        onExceeded: ({ usedBytes, maxBytes }) => {
            // Leaving discovery alone does not stop already connected peers or
            // outstanding download ranges from continuing to fill the disk.
            quotaPaused = true
            logger?.log?.('[AUDIT] Blind-helper storage quota exceeded; pausing replication', { usedBytes, maxBytes })
            for (const range of downloads.values()) range.destroy()
            downloads.clear()
            for (const conn of swarm.connections) conn.destroy()
            for (const keyHex of cores.keys()) {
                try {
                    swarm.leave(crypto.discoveryKey(b4a.from(keyHex, 'hex')))
                } catch {}
            }
        },
        onRecovered: () => {
            quotaPaused = false
            for (const [keyHex, core] of cores) startDownload(keyHex, core)
            logger?.log?.('[INFO] Blind-helper storage quota recovered; resuming replication')
        },
    })
    quota.start()

    function snapshot() {
        return {
            role: 'blind-storage',
            pins: [...cores.entries()].map(([keyHex, core]) => ({
                fingerprint: secretFingerprint(keyHex),
                length: core.length,
                contiguousLength: core.contiguousLength,
            })),
            peerCount,
            quota: quota.snapshot(),
            // The boundary the status must state plainly: this helper holds
            // ciphertext only.
            encryptionKey: 'never-held',
        }
    }

    const statusTimer = setInterval(() => writeStatus(fs, storageDir, snapshot(), now()), 5_000)
    statusTimer?.unref?.()
    writeStatus(fs, storageDir, snapshot(), now())

    async function handleOp(request) {
        switch (request.op) {
            case 'status':
                return snapshot()
            case 'pin': {
                const keyHex = typeof request.key === 'string' ? request.key.trim().toLowerCase() : ''
                if (!/^[0-9a-f]{64}$/.test(keyHex)) return { ok: false, message: 'pin requires a 64-hex core key' }
                await pin(keyHex)
                return snapshot()
            }
            case 'peek': {
                // Test/diagnostic primitive: return the locally stored block as
                // hex. On a blind helper this is ciphertext by construction.
                const core = [...cores.values()][0]
                if (!core) return { ok: false, message: 'no pinned core' }
                const block = await core.get(request.index ?? 0, { wait: false, valueEncoding: 'binary' }).catch(() => null)
                return { block: block ? b4a.toString(block, 'hex') : null, length: core.length }
            }
            case 'dump':
                return snapshot()
            case 'shutdown':
                return { shutdown: true }
            default:
                return { ok: false, message: `unknown op ${request.op}` }
        }
    }

    async function shutdown() {
        clearInterval(statusTimer)
        quota.stop()
        writeStatus(fs, storageDir, { ...snapshot(), stopped: true }, now())
        try {
            await swarm.destroy()
        } catch {}
        try {
            await store.close()
        } catch {}
        lease.release()
    }

    return { handleOp, shutdown, snapshot }
}
