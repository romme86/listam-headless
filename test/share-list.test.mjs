// Phase 3 (single-list sharing): the headless service exposes share-list /
// join-list ops that drive RPC_SHARE_LIST / RPC_JOIN_LIST. share-list promotes a
// list into its own base and returns a co-edit invite; the list's items move to
// that shared base (tagged with its baseKey). The cross-peer co-edit itself is
// covered by the backend's in-process + 2-process tests — here we assert the
// headless op wiring and the reply contract.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

test('share-list promotes a list and returns an invite; bad inputs are rejected', { timeout: 120_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-share-'))
    t.after(async () => { await testnet.destroy(); rmSync(dir, { recursive: true, force: true }) })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    const node = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await node.ready()
    try {
        // Only registry-backed NAMED lists are shareable — the built-in
        // surfaces multiplex the reserved listId 'default' and sharing that
        // would sweep all three surfaces into one base (the 2026-06-25
        // multiplexed-default data-loss bug), so the backend refuses it.
        await node.request('add', { text: 'Milk', listId: 'errands', listType: 'shopping' })
        await node.waitFor((r) => r.items?.some((i) => i.text === 'Milk'), { op: 'dump', timeoutMs: 30_000 })

        // Promote the named list into its own shared base.
        const shared = await node.request('share-list', { listId: 'errands' })
        assert.equal(shared.ok, true, `share-list ok: ${JSON.stringify(shared)}`)
        assert.equal(typeof shared.invite, 'string')
        assert.ok(shared.invite.length > 0, 'share-list returned a co-edit invite')
        assert.match(shared.baseKey ?? '', /^[0-9a-f]{64}$/, 'share-list returned a base key')

        // The item now lives in the shared base — it is re-projected tagged with
        // that base key (and survives the tombstone of the personal copy).
        const dump = await node.waitFor(
            (r) => r.items?.some((i) => i.text === 'Milk' && i.baseKey === shared.baseKey),
            { op: 'dump', timeoutMs: 30_000 },
        )
        assert.ok(
            dump.items.some((i) => i.text === 'Milk' && i.baseKey === shared.baseKey),
            'Milk moved into the shared base (tagged with its baseKey)',
        )

        // Malformed / missing inputs are answered, not crashed.
        const badJoin = await node.request('join-list', { invite: 'not-a-real-invite' })
        assert.equal(badJoin.ok, false, 'a malformed invite is rejected')
        const noList = await node.request('share-list', {})
        assert.equal(noList.ok, false, 'share-list requires a listId')
        const builtin = await node.request('share-list', { listId: 'default' })
        assert.equal(builtin.ok, false, 'the built-in default list is never shareable')
        assert.equal(builtin.message, 'cannot-share-builtin')
    } finally {
        await node.stop()
    }
})
