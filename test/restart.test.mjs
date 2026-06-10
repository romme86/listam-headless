// Phase 13 acceptance: a restart preserves identity, storage, and status.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './helpers/cli.mjs'
import { readStatus } from '../src/status.mjs'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

test('restart preserves identity, storage, and status', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-restart-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    // First life: create the base and content.
    const first = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await first.ready()
    await first.request('add', { text: 'Milk' })
    await first.request('add-item', { text: 'Bread' }) // plan-name alias
    const beforeDump = await first.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })
    const beforeStatus = await first.request('status')
    assert.ok(beforeStatus.baseId, 'status exposes a base identity fingerprint')
    await first.stop()

    // Status file survives shutdown and is marked stopped + stale-able.
    const stoppedStatus = readStatus(fs, dir)
    assert.equal(stoppedStatus.stopped, true)

    // Second life: same storage dir must come back as the same peer with the
    // same content.
    const second = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await second.ready()
    const afterDump = await second.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 60_000 })
    const afterStatus = await second.request('status')

    assert.equal(afterStatus.baseId, beforeStatus.baseId, 'base identity is preserved across restart')
    assert.deepEqual(
        afterDump.items.map((item) => [item.id, item.text]).sort(),
        beforeDump.items.map((item) => [item.id, item.text]).sort(),
        'items rebuild from disk with identical stable ids',
    )

    // One-shot status command reads the live snapshot.
    const statusCli = await runOneShot(['status', '--storage', dir])
    assert.equal(statusCli.parsed?.ok, true)
    assert.equal(statusCli.parsed.status.baseId, beforeStatus.baseId)
    assert.equal(statusCli.parsed.status.stale, false)

    await second.stop()
})

test('the storage lease still guards the headless root: a second instance is refused', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-lease-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    const first = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await first.ready()

    const second = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await assert.rejects(() => second.ready(), /exited before ready/)
    assert.match(second.stderr, /storage lease/i)

    await first.stop()
})
