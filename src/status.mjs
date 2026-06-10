// Status snapshot file: the running service refreshes it on a short interval
// so `headless.mjs status` (and, later, owner-control clients) can inspect a
// live instance without attaching to its stdin. Contains identifiers as
// redacted fingerprints only — never raw keys.
export const STATUS_STALE_MS = 60_000

export function statusPath(storageDir) {
    return `${storageDir}/headless-status.json`
}

export function writeStatus(fs, storageDir, snapshot, now = Date.now()) {
    try {
        fs.writeFileSync(statusPath(storageDir), JSON.stringify({
            ...snapshot,
            updatedAt: now,
        }, null, 2))
        return true
    } catch {
        return false
    }
}

export function readStatus(fs, storageDir, now = Date.now()) {
    try {
        const snapshot = JSON.parse(fs.readFileSync(statusPath(storageDir), 'utf8'))
        if (!snapshot || typeof snapshot !== 'object') return null
        return {
            ...snapshot,
            stale: typeof snapshot.updatedAt !== 'number' || now - snapshot.updatedAt > STATUS_STALE_MS,
        }
    } catch {
        return null
    }
}
