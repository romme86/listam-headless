import test from 'node:test'
import assert from 'node:assert/strict'
import { directorySizeBytes, createQuotaMonitor } from '../src/quota.mjs'

// Fake fs over a path->size map; directories are inferred from prefixes.
function createFakeFs(files) {
    return {
        files,
        readdirSync(dir) {
            const children = new Map()
            for (const path of Object.keys(files)) {
                if (!path.startsWith(`${dir}/`)) continue
                const rest = path.slice(dir.length + 1)
                const name = rest.split('/')[0]
                children.set(name, rest.includes('/') ? 'dir' : 'file')
            }
            return [...children.entries()].map(([name, kind]) => ({
                name,
                isDirectory: () => kind === 'dir',
                isFile: () => kind === 'file',
            }))
        },
        statSync(path) {
            if (!(path in files)) throw new Error('ENOENT')
            return { size: files[path] }
        },
    }
}

test('directory sizes sum nested files', () => {
    const fs = createFakeFs({
        '/data/a.bin': 100,
        '/data/sub/b.bin': 50,
        '/data/sub/deep/c.bin': 25,
    })
    assert.equal(directorySizeBytes(fs, '/data'), 175)
    assert.equal(directorySizeBytes(fs, '/data/sub'), 75)
    assert.equal(directorySizeBytes(fs, '/missing'), 0)
})

test('quota monitor fires on exceed and on recovery, once per transition', () => {
    const files = { '/data/a.bin': 100 }
    const fs = createFakeFs(files)
    const events = []
    const monitor = createQuotaMonitor({
        fs,
        path: '/data',
        maxBytes: 150,
        onExceeded: ({ usedBytes }) => events.push(`exceeded@${usedBytes}`),
        onRecovered: ({ usedBytes }) => events.push(`recovered@${usedBytes}`),
    })

    assert.deepEqual(monitor.check(), { usedBytes: 100, maxBytes: 150, exceeded: false })

    files['/data/b.bin'] = 100
    monitor.check()
    monitor.check() // second check over quota must not re-fire
    assert.equal(monitor.isExceeded(), true)

    delete files['/data/b.bin']
    monitor.check()

    assert.deepEqual(events, ['exceeded@200', 'recovered@100'])
})

test('quota monitor validates its inputs', () => {
    assert.throws(() => createQuotaMonitor({ fs: null, path: '/x', maxBytes: 1 }))
    assert.throws(() => createQuotaMonitor({ fs: {}, path: '/x', maxBytes: 0 }))
})
