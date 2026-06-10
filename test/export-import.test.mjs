// Export/import round-trip: ids, edits, and done state survive the move into
// a fresh base (the mobile↔headless matrix row's local prerequisite).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

test('export/import preserves item ids, edits, and done state', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dirA = mkdtempSync(join(tmpdir(), 'listam-headless-exp-'))
    const dirB = mkdtempSync(join(tmpdir(), 'listam-headless-imp-'))
    t.after(async () => {
        await testnet.destroy()
        for (const dir of [dirA, dirB]) rmSync(dir, { recursive: true, force: true })
    })

    await runOneShot(['setup', '--storage', dirA, '--role', 'participant'])
    const source = runHeadless(['run', '--storage', dirA, '--bootstrap', bootstrapFlag(testnet)])
    await source.ready()

    await source.request('add', { text: 'Milk' })
    await source.request('add', { text: 'Bread' })
    const seeded = await source.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })
    const bread = seeded.items.find((item) => item.text === 'Bread')
    await source.request('mark-done', { itemId: bread.id })
    await source.request('edit-item', { itemId: seeded.items.find((item) => item.text === 'Milk').id, text: 'Oat milk' })
    const finalDump = await source.waitFor(
        (reply) => reply.items?.some((item) => item.isDone) && reply.items?.some((item) => item.text === 'Oat milk'),
        { op: 'dump', timeoutMs: 30_000 },
    )

    const exportPath = join(dirA, 'export.json')
    const exported = await source.request('export', { path: exportPath })
    assert.equal(exported.export.items.length, 2)
    assert.equal(JSON.parse(readFileSync(exportPath, 'utf8')).version, 1)
    await source.stop()

    // Import into a brand-new base on a different instance.
    await runOneShot(['setup', '--storage', dirB, '--role', 'participant'])
    const target = runHeadless(['run', '--storage', dirB, '--bootstrap', bootstrapFlag(testnet)])
    await target.ready()
    const imported = await target.request('import', { path: exportPath })
    assert.equal(imported.imported, 2)

    const restored = await target.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })
    const byId = new Map(restored.items.map((item) => [item.id, item]))
    for (const original of finalDump.items) {
        const copy = byId.get(original.id)
        assert.ok(copy, `item ${original.text} kept its stable id`)
        assert.equal(copy.text, original.text)
        assert.equal(copy.isDone, original.isDone)
    }

    await target.stop()
})
