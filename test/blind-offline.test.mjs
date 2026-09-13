import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import { collectMirrorKeys } from '@listam/backend/lib/blind-manifest.mjs'
import { startBlindHelper } from '../src/blind.mjs'

const requireBackend = createRequire(import.meta.resolve('@listam/backend'))
const Autobase = requireBackend('autobase')

async function until(check, label, timeout = 20000) {
    const deadline = Date.now() + timeout
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 30))
    }
}

test('a restarted blind helper serves the complete multiwriter view with both writers offline', { timeout: 90000 }, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'listam-blind-offline-'))
    const network = await createTestnet(3)
    const peers = []
    let helper
    const encryptionKey = Buffer.alloc(32, 7)
    async function peer(name, key = null) {
        const store = new Corestore(join(root, name))
        const base = new Autobase(store, key, {
            encryptionKey, encrypt: true, valueEncoding: 'json',
            open: (views) => views.get({ name: 'view', valueEncoding: 'json' }),
            async apply(nodes, view, host) {
                for (const node of nodes) {
                    if (node.value.writer) await host.addWriter(Buffer.from(node.value.writer, 'hex'))
                    else await view.append(node.value)
                }
            },
        })
        await base.ready()
        const swarm = new Hyperswarm({ bootstrap: network.bootstrap })
        swarm.on('connection', (socket) => { socket.on('error', () => {}); store.replicate(socket) })
        swarm.join(base.discoveryKey)
        const instance = { store, base, swarm, closed: false }
        peers.push(instance)
        return instance
    }
    async function closePeer(p) {
        if (p.closed) return
        p.closed = true
        await p.swarm.destroy(); await p.base.close(); await p.store.close()
    }
    t.after(async () => {
        if (helper) await helper.shutdown()
        for (const p of peers) await closePeer(p)
        await network.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    })
    const first = await peer('first')
    const second = await peer('second', first.base.key)
    await first.base.append({ writer: second.base.local.key.toString('hex') })
    await until(() => second.base.writable, 'second writer admitted')
    await first.base.append({ text: 'first writer secret' })
    await second.base.append({ text: 'second writer secret' })
    await until(() => first.base.view.length >= 2 && second.base.view.length >= 2, 'both writers converge')
    await first.base.append(null)
    await second.base.append(null)
    await until(() => first.base.view.signedLength >= 2, 'view becomes signed')
    const baseKey = first.base.key.toString('hex')
    const keys = [...new Set([...collectMirrorKeys({ autobase: first.base }), ...collectMirrorKeys({ autobase: second.base })])].sort()
    const expected = new Map()
    for (const p of [first, second]) {
        for (const core of [p.base.local, p.base.core, p.base.view]) {
            const key = core.key.toString('hex')
            expected.set(key, Math.max(expected.get(key) ?? 0, core.signedLength))
        }
    }
    const storageDir = join(root, 'helper')
    fs.mkdirSync(storageDir)
    const options = { fs, storageDir, logger: { log() {} }, config: { bootstrap: network.bootstrap, relayKeys: [], pins: [baseKey], maxStorageBytes: 100000000 } }
    helper = await startBlindHelper(options)
    await helper.handleOp({ op: 'mirror-manifest', manifest: { version: 1, baseKey, revision: 1, keys } })
    await until(() => {
        const pins = helper.snapshot().pins
        return pins.length === keys.length && pins.every((p) => p.length === p.contiguousLength) &&
            pins.reduce((sum, p) => sum + p.contiguousLength, 0) >= [...expected.values()].reduce((a, b) => a + b, 0)
    }, 'all writer and view blocks mirrored').catch((error) => { console.error(JSON.stringify({ keys, expected: [...expected], snapshot: helper.snapshot() })); throw error })
    await closePeer(first); await closePeer(second)
    await helper.shutdown(); helper = null
    helper = await startBlindHelper(options)
    assert.equal(helper.snapshot().pins.length, keys.length, 'the full manifest survives restart')
    const reader = await peer('reader', Buffer.from(baseKey, 'hex'))
    await until(() => reader.base.view.length >= 2, 'fresh reader recovers through helper')
    const values = []
    for (let i = 0; i < reader.base.view.length; i++) values.push((await reader.base.view.get(i)).text)
    assert.ok(values.includes('first writer secret'))
    assert.ok(values.includes('second writer secret'))
    assert.equal(helper.snapshot().encryptionKey, 'never-held')
    assert.equal(fs.existsSync(join(storageDir, 'headless-secrets.json')), false)
})
