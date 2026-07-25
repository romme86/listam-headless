// The user-facing API must never expose the reserved buckets the backend rides
// through the ordinary item pipeline.
//
// Regression: `dump` returned the raw projection, so a presence heartbeat showed
// up as a third "item" after a restart and the restart acceptance tests timed
// out waiting for two. Persistence was never broken — the projection was.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { META_LIST_TYPES, VOLATILE_META_LIST_TYPES } from '@listam/domain/meta'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

test('dump and export never leak reserved-bucket records', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-projection-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    const first = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await first.ready()
    await first.request('add', { text: 'Milk' })
    await first.request('add', { text: 'Bread' })
    await first.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })
    await first.stop()

    // A restart is what surfaces the bug: the heartbeat this node published in
    // its first life is durable, so it comes back out of the view on reopen.
    const second = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await second.ready()
    const dump = await second.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 60_000 })

    const leaked = dump.items.filter((item) => META_LIST_TYPES.has(item?.listType))
    assert.deepEqual(leaked, [], `dump leaked reserved records: ${JSON.stringify(leaked)}`)
    assert.deepEqual(dump.items.map((i) => i.text).sort(), ['Bread', 'Milk'])

    // itemCount is the same projection; a mismatch means one of them regressed.
    const status = await second.request('status')
    assert.equal(status.status?.itemCount ?? status.itemCount, 2, 'itemCount must count user rows only')

    const exportPath = join(dir, 'export.json')
    const exported = await second.request('export', { path: exportPath })
    assert.equal(exported.ok !== false, true)
    const payload = JSON.parse(readFileSync(exportPath, 'utf8'))
    const volatile = payload.items.filter((item) => VOLATILE_META_LIST_TYPES.has(item?.listType))
    assert.deepEqual(volatile, [], 'an export must not carry presence or credential records')
    assert.deepEqual(payload.items.map((i) => i.text).filter(Boolean).sort(), ['Bread', 'Milk'])

    await second.stop()
})
