import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { checkRelay } from '../src/relay-check.mjs'
import { startRelay } from '../src/relay.mjs'

test('health check proves a relayed echo and bounds an unavailable relay', { timeout: 20000 }, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'listam-relay-health-'))
    const net = await createTestnet(3)
    const relay = await startRelay({ storageDir: root, bootstrap: net.bootstrap, statsIntervalMs: 0 })
    t.after(async () => { await relay.close(); await net.destroy(); fs.rmSync(root, { recursive: true, force: true }) })
    const good = await checkRelay({ key: relay.publicKey, bootstrap: net.bootstrap, timeoutMs: 5000 })
    assert.equal(good.ok, true, JSON.stringify(good))
    assert.ok(relay.stats().pairings.matched >= 1, 'direct connectivity cannot satisfy the check')
    const bad = await checkRelay({ key: DHT.keyPair().publicKey, bootstrap: net.bootstrap, timeoutMs: 500 })
    assert.equal(bad.ok, false)
    assert.ok(bad.elapsedMs < 3000)
})
