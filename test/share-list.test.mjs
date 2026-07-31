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
        const builtinTodo = await node.request('share-list', { listId: 'default', type: 'todo' })
        assert.equal(builtinTodo.ok, false, 'only the default grocery surface is shareable')
        assert.equal(builtinTodo.message, 'cannot-share-builtin')
    } finally {
        await node.stop()
    }
})

test('default grocery is re-IDed and joins as an additional list', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const ownerDir = mkdtempSync(join(tmpdir(), 'listam-headless-default-owner-'))
    const guestDir = mkdtempSync(join(tmpdir(), 'listam-headless-default-guest-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(ownerDir, { recursive: true, force: true })
        rmSync(guestDir, { recursive: true, force: true })
    })

    assert.equal((await runOneShot(['setup', '--storage', ownerDir, '--role', 'participant'])).parsed?.ok, true)
    assert.equal((await runOneShot(['setup', '--storage', guestDir, '--role', 'participant'])).parsed?.ok, true)

    const bootstrap = bootstrapFlag(testnet)
    const owner = runHeadless(['run', '--storage', ownerDir, '--bootstrap', bootstrap])
    const guest = runHeadless(['run', '--storage', guestDir, '--bootstrap', bootstrap])
    await Promise.all([owner.ready(), guest.ready()])
    try {
        // The owner has grocery + legacy sibling content in the multiplexed
        // default bucket. The guest already has its own unrelated grocery.
        await owner.request('add', { text: 'Owner milk', listId: 'default', listType: 'shopping' })
        await owner.request('add', { text: 'Owner reminder', listId: 'default', listType: 'todo' })
        await guest.request('add', { text: 'Guest bread', listId: 'default', listType: 'shopping' })
        await owner.waitFor((r) => r.items?.some((i) => i.text === 'Owner milk') && r.items?.some((i) => i.text === 'Owner reminder'), { op: 'dump', timeoutMs: 30_000 })
        await guest.waitFor((r) => r.items?.some((i) => i.text === 'Guest bread'), { op: 'dump', timeoutMs: 30_000 })

        const shared = await owner.request('share-list', {
            listId: 'default',
            type: 'shopping',
            name: 'Groceries',
        })
        assert.equal(shared.ok, true, `default share ok: ${JSON.stringify(shared)}`)
        assert.match(shared.listId ?? '', /^list-[0-9a-f]{64}$/)
        assert.notEqual(shared.listId, 'default')
        assert.match(shared.baseKey ?? '', /^[0-9a-f]{64}$/)
        assert.ok(shared.invite, `default share returned no invite: ${JSON.stringify(shared)}\n${owner.stderr.slice(-4000)}`)

        const ownerDump = await owner.waitFor((r) => (
            r.items?.some((i) => i.text === 'Owner milk' && i.listId === shared.listId && i.baseKey === shared.baseKey) &&
            r.items?.some((i) => i.text === 'Owner reminder' && i.listId === 'default' && !i.baseKey) &&
            !r.items?.some((i) => i.text === 'Owner milk' && i.listId === 'default' && !i.baseKey)
        ), { op: 'dump', timeoutMs: 30_000 })
        assert.ok(ownerDump.items.some((i) => i.text === 'Owner reminder' && i.listType === 'todo'), 'default todo was not swept into the grocery share')

        // Recovery origin + owner-device hide marker are durable personal meta.
        const exported = await owner.request('export')
        assert.ok(exported.export?.items?.some((i) => (
            i.regKind === 'shared-source' &&
            i.sourceTargetListId === shared.listId &&
            i.sourceListId === 'default' &&
            i.sourceListType === 'shopping'
        )), 'source identity persisted for orphan recovery')
        assert.ok(exported.export?.items?.some((i) => (
            i.listType === 'builtinvisibility' &&
            i.surfaceKey === 'default:shopping' &&
            i.builtinHidden === true
        )), 'owner devices receive the default-grocery hide marker')

        const joined = await guest.request('join-list', { invite: shared.invite })
        assert.equal(joined.ok, true, `join-list ok: ${JSON.stringify(joined)}`)
        assert.equal(joined.listId, shared.listId)
        assert.equal(joined.baseKey, shared.baseKey)

        const guestDump = await guest.waitFor((r) => (
            r.items?.some((i) => i.text === 'Guest bread' && i.listId === 'default' && !i.baseKey) &&
            r.items?.some((i) => i.text === 'Owner milk' && i.listId === shared.listId && i.baseKey === shared.baseKey)
        ), { op: 'dump', timeoutMs: 60_000 })
        assert.equal(guestDump.items.filter((i) => i.text === 'Guest bread').length, 1)
        assert.equal(guestDump.items.filter((i) => i.text === 'Owner milk').length, 1)

        // The returned canonical id is immediately writable and routes into the
        // shared base, proving the added list is not merely a read-only mount.
        const add = await guest.request('add', { text: 'Shared cheese', listId: shared.listId, listType: 'shopping' })
        assert.equal(add.ok, true)
        await owner.waitFor(
            (r) => r.items?.some((i) => i.text === 'Shared cheese' && i.listId === shared.listId && i.baseKey === shared.baseKey),
            { op: 'dump', timeoutMs: 60_000 },
        )
    } finally {
        await Promise.all([owner.stop(), guest.stop()])
    }
})
