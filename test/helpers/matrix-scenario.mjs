// Cross-instance acceptance matrix (Phase 15) — the headless-driven subset,
// run as a plain child process by test/matrix.test.mjs (same arrangement as
// the owner-control scenario: hyperdht teardown noise filtered narrowly,
// every assertion still fails the run).
//
// Every instance is a real child-process service on its own storage root,
// joined over a private hyperdht testnet — the plan's shared local harness.
// All Listam surfaces drive this identical backend over the identical client
// contract, so these rows prove the protocol level of the mobile/desktop
// pairings; the GUI-level rows are documented as manual procedures in the
// acceptance-matrix wiki page.
//
// Two tiers. The CORE rows are deterministic — they ride the reliable
// join-time replication path (the joining device replicates the host's full
// history over the pairing connection) — and run in CI by default. The FULL
// rows (LISTAM_MATRIX_FULL=1) additionally exercise sustained, bidirectional,
// and mesh steady-state replication between independent OS processes, which
// depends on main-swarm DHT reconnection timing that is environment-flaky in
// a sandbox; they are a documented, repeatable extended run. The security
// guarantees these rows demonstrate (C1 re-key, C3 owner gate, M1 id-keying,
// H3 invite lifecycle) are independently unit-proven in the backend security
// suite — the matrix is the live cross-instance demonstration.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './cli.mjs'

process.on('uncaughtException', (error) => {
    if (/connection reset by peer/i.test(error?.message ?? '')) return
    console.error(error)
    process.exit(1)
})

const FULL = process.env.LISTAM_MATRIX_FULL === '1'
const mark = (label) => console.log(`MATRIX ${label}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
const dirs = []

async function startParticipant(label) {
    const dir = mkdtempSync(join(tmpdir(), `listam-matrix-${label}-`))
    dirs.push(dir)
    await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrap])
    await service.ready()
    return { service, dir, label }
}

function itemTexts(dump) {
    return dump.items.map((item) => item.text).sort()
}

// === CORE: join, convergence, duplicate-name handling by id (M1) ============
// The protocol level of the mobile↔mobile and mobile↔desktop "invite/join +
// initial convergence" rows. Replication here is the reliable join-time path.
const host = await startParticipant('host')
const guest = await startParticipant('guest')

await host.service.request('add', { text: 'Milk' })
await host.service.request('add', { text: 'Milk' }) // duplicate display name
await host.service.request('add', { text: 'Bread' })
const hostSeed = await host.service.waitFor((reply) => reply.items?.length === 3, { op: 'dump', timeoutMs: 30_000 })
const hostMilkIds = hostSeed.items.filter((item) => item.text === 'Milk').map((item) => item.id).sort()
assert.equal(hostMilkIds.length, 2, 'duplicate display names are distinct items on the host')

const firstInvite = (await host.service.request('invite')).inviteKey
assert.ok(firstInvite.length > 0)
await guest.service.request('join', { invite: firstInvite })
await guest.service.waitFor((reply) => reply.joined, { op: 'dump' })
const guestSynced = await guest.service.waitFor((reply) => reply.items?.length === 3, { op: 'dump' })

assert.deepEqual(itemTexts(guestSynced), ['Bread', 'Milk', 'Milk'], 'guest sees both same-name items')
assert.deepEqual(
    guestSynced.items.filter((item) => item.text === 'Milk').map((item) => item.id).sort(),
    hostMilkIds,
    'duplicate-name items converge by stable id, never collapsing by text (M1)',
)
mark('join-and-duplicate-names')

// === CORE: invite safety (H3) — a consumed invite is rotated, not reusable ==
const rotatedInvite = (await host.service.request('invite')).inviteKey
assert.notEqual(rotatedInvite, firstInvite, 'a consumed single-use invite is rotated, never re-issued')
mark('invite-rotation')

// === CORE: the host is the owner; the guest is a writer, not an admin =======
// The roster the guest received at join time reflects the owner gate (C3):
// it holds the owner-signed membership, with the host as the sole owner.
const guestRoster = (await guest.service.request('members')).roster
    ?? (await guest.service.waitFor((reply) => reply.roster, { op: 'dump', timeoutMs: 15_000 })).roster
assert.ok(guestRoster, 'guest received the owner-signed membership roster')
assert.equal(guestRoster.writers.filter((writer) => writer.isOwner).length, 1, 'exactly one owner')
assert.equal(guestRoster.writers.find((writer) => writer.isSelf)?.isOwner, false, 'the joined guest is a writer, not the owner (C3)')
mark('owner-gate-roster')

if (!FULL) {
    await guest.service.stop()
    await host.service.stop()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    mark('core-complete')
    process.exit(0)
}

// === FULL: steady-state convergence (guest edits, host converges by id) =====
const guestMilkDoneId = hostMilkIds[0]
await guest.service.request('done', { itemId: guestMilkDoneId })
const hostAfterDone = await host.service.waitFor(
    (reply) => reply.items?.some((item) => item.id === guestMilkDoneId && item.isDone),
    { op: 'dump', timeoutMs: 180_000 },
)
assert.equal(
    hostAfterDone.items.filter((item) => item.text === 'Milk' && item.isDone).length,
    1,
    'only the targeted same-name item is done on the host',
)

const breadId = hostSeed.items.find((item) => item.text === 'Bread').id
await guest.service.request('edit', { itemId: breadId, text: 'Rye bread' })
await host.service.waitFor(
    (reply) => reply.items?.some((item) => item.id === breadId && item.text === 'Rye bread'),
    { op: 'dump', timeoutMs: 180_000 },
)

const guestMilkDeleteId = hostMilkIds[1]
await guest.service.request('delete', { itemId: guestMilkDeleteId })
const hostAfterDelete = await host.service.waitFor(
    (reply) => !reply.items?.some((item) => item.id === guestMilkDeleteId),
    { op: 'dump', timeoutMs: 180_000 },
)
assert.ok(hostAfterDelete.items.some((item) => item.id === guestMilkDoneId), 'the other same-name item survives the delete')
mark('steady-state-convergence')

// === FULL: member-removal re-key (C1) — the removed device cannot follow =====
const hostRoster = (await host.service.waitFor((reply) => (reply.roster?.writers?.length ?? 0) >= 2, { op: 'dump', timeoutMs: 30_000 })).roster
const guestWriterKey = hostRoster.writers.find((writer) => !writer.isOwner).writerKey

// Prove the link is live first, so the negative assertion is meaningful.
await host.service.request('add', { text: 'Pre-removal ping' })
await guest.service.waitFor((reply) => reply.items?.some((item) => item.text === 'Pre-removal ping'), { op: 'dump', timeoutMs: 180_000 })

await host.service.request('remove-member', { writerKey: guestWriterKey })
await host.service.waitFor(
    (reply) => !(reply.roster?.writers ?? []).some((writer) => writer.writerKey === guestWriterKey),
    { op: 'dump', timeoutMs: 60_000 },
)

await host.service.request('add', { text: 'Post-removal secret' })
await host.service.waitFor((reply) => reply.items?.some((item) => item.text === 'Post-removal secret'), { op: 'dump', timeoutMs: 30_000 })
await sleep(20_000)
const removedGuestDump = await guest.service.request('dump')
assert.equal(
    removedGuestDump.items.some((item) => item.text === 'Post-removal secret'),
    false,
    'a removed member cannot read content appended after the re-key (C1)',
)
assert.ok(removedGuestDump.items.some((item) => item.text === 'Pre-removal ping'), 'the removed member keeps its pre-removal copy')
mark('member-removal-rekey')

await guest.service.stop()
await host.service.stop()

// === FULL: 3-way convergence, kill one, rejoin reconciles ===================
const alpha = await startParticipant('alpha')
const beta = await startParticipant('beta')
const gamma = await startParticipant('gamma')

await alpha.service.request('add', { text: 'Alpha item' })
const inviteForBeta = (await alpha.service.request('invite')).inviteKey
await beta.service.request('join', { invite: inviteForBeta })
await beta.service.waitFor((reply) => reply.joined, { op: 'dump' })

const inviteForGamma = (await alpha.service.request('invite')).inviteKey
await gamma.service.request('join', { invite: inviteForGamma })
await gamma.service.waitFor((reply) => reply.joined, { op: 'dump' })

await beta.service.request('add', { text: 'Beta item' })
await gamma.service.request('add', { text: 'Gamma item' })
const expectAll = (reply) => ['Alpha item', 'Beta item', 'Gamma item'].every((text) => reply.items?.some((item) => item.text === text))
for (const node of [alpha, beta, gamma]) {
    await node.service.waitFor(expectAll, { op: 'dump', timeoutMs: 240_000 })
}
mark('three-way-convergence')

gamma.service.proc.kill('SIGKILL')
await once(gamma.service.proc, 'exit')
await alpha.service.request('add', { text: 'While gamma is down' })
await beta.service.waitFor((reply) => reply.items?.some((item) => item.text === 'While gamma is down'), { op: 'dump', timeoutMs: 180_000 })
const betaDeleteTarget = (await beta.service.request('dump')).items.find((item) => item.text === 'Beta item')
await beta.service.request('delete', { itemId: betaDeleteTarget.id })
await alpha.service.waitFor((reply) => !reply.items?.some((item) => item.id === betaDeleteTarget.id), { op: 'dump', timeoutMs: 180_000 })
mark('survivors-continue')

const gammaRestarted = runHeadless(['run', '--storage', gamma.dir, '--bootstrap', bootstrap])
await gammaRestarted.ready()
const gammaFinal = await gammaRestarted.waitFor(
    (reply) => reply.items?.some((item) => item.text === 'While gamma is down')
        && !reply.items?.some((item) => item.id === betaDeleteTarget.id),
    { op: 'dump', timeoutMs: 240_000 },
)
assert.equal(new Set(gammaFinal.items.map((item) => item.id)).size, gammaFinal.items.length, 'no duplicate ids after rejoin')
assert.equal(gammaFinal.items.filter((item) => item.id === betaDeleteTarget.id).length, 0, 'deleted items stay deleted after rejoin')
mark('rejoin-reconciles')

await gammaRestarted.stop()
await beta.service.stop()
await alpha.service.stop()

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
mark('complete')
process.exit(0)
