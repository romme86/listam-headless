// Storage quota for an always-on helper: a periodic scan of the storage root
// with callbacks when usage crosses the configured ceiling. The plan's
// store-and-forward/relay-for-others roles are deferred past milestone 1, so
// the quota here bounds this instance's own replicated storage; queue quotas
// arrive with the async-message helper.
export function directorySizeBytes(fs, root) {
    let total = 0
    const stack = [root]
    while (stack.length > 0) {
        const dir = stack.pop()
        let entries = []
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            const path = `${dir}/${entry.name}`
            if (entry.isDirectory()) {
                stack.push(path)
            } else if (entry.isFile()) {
                try {
                    total += fs.statSync(path).size
                } catch {}
            }
        }
    }
    return total
}

export function createQuotaMonitor({ fs, path, maxBytes, intervalMs = 30_000, onExceeded, onRecovered }) {
    if (!fs || !path) throw new Error('A filesystem adapter and path are required')
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('A positive maxBytes quota is required')

    let exceeded = false
    let timer = null

    function check() {
        const usedBytes = directorySizeBytes(fs, path)
        const over = usedBytes > maxBytes
        if (over && !exceeded) {
            exceeded = true
            onExceeded?.({ usedBytes, maxBytes })
        } else if (!over && exceeded) {
            exceeded = false
            onRecovered?.({ usedBytes, maxBytes })
        }
        return { usedBytes, maxBytes, exceeded }
    }

    function start() {
        stop()
        timer = setInterval(check, intervalMs)
        timer?.unref?.()
        return check()
    }

    function stop() {
        if (timer) {
            clearInterval(timer)
            timer = null
        }
    }

    return {
        check,
        start,
        stop,
        isExceeded: () => exceeded,
    }
}
