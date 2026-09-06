import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import { startBlindHelper } from '../src/blind.mjs'

async function until(predicate) {
    const end = Date.now() + 10_000
    while (!predicate()) {
        if (Date.now() > end) throw new Error('replication condition timed out')
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

test('quota pauses existing replication and resumes after storage recovers', { timeout: 30_000 }, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'listam-blind-quota-'))
    const net = await createTestnet(3)
    const owner = new Corestore(join(root, 'owner'))
    const source = owner.get({ name: 'source' })
    await source.ready()
    await source.append(Buffer.from('before-quota'))
    const swarm = new Hyperswarm({ bootstrap: net.bootstrap })
    swarm.on('connection', (conn) => { conn.on('error', () => {}); owner.replicate(conn) })
    swarm.join(source.discoveryKey)
    const storageDir = join(root, 'blind')
    fs.mkdirSync(storageDir)
    const helper = await startBlindHelper({
        fs, storageDir, logger: { log() {} }, quotaIntervalMs: 25,
        config: { bootstrap: net.bootstrap, pins: [source.key.toString('hex')], maxStorageBytes: 1024 * 1024 },
    })
    t.after(async () => {
        await helper.shutdown(); await swarm.destroy(); await owner.close(); await net.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    })
    await until(() => helper.snapshot().pins[0].contiguousLength === 1)
    fs.writeFileSync(join(storageDir, 'quota-padding'), Buffer.alloc(2 * 1024 * 1024))
    await until(() => helper.snapshot().quota.exceeded && helper.snapshot().peerCount === 0)
    await source.append(Buffer.from('after-quota'))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(helper.snapshot().pins[0].contiguousLength, 1, 'an existing download must stop at quota')
    fs.unlinkSync(join(storageDir, 'quota-padding'))
    await until(() => !helper.snapshot().quota.exceeded)
    await until(() => helper.snapshot().pins[0].contiguousLength === 2)
})
