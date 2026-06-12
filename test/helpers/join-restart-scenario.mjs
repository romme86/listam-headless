// Regression guard for the joined-base persistence hole (2026-06-12): a guest
// whose writer was authorized during pairing took the "already writable"
// shortcut, which skipped waitForWritable's save path — the joined base and
// encryption keys were never persisted, so a restart silently booted the
// guest's previous own base (with mixed post-join epoch keys). Runs as a
// plain child process (see matrix.test.mjs for why).
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import createTestnet from 'hyperdht/testnet.js'
import { createFileSecretStore, secretFingerprint } from '@listam/secrets'
import { runHeadless, runOneShot } from './cli.mjs'

process.on('uncaughtException', (error) => {
    if (/connection reset by peer/i.test(error?.message ?? '')) return
    console.error(error)
    process.exit(1)
})

const mark = (label) => console.log(`JOIN-RESTART ${label}`)

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
const dirs = []

async function startParticipant(label, dir = null) {
    if (!dir) {
        dir = mkdtempSync(join(tmpdir(), `listam-join-restart-${label}-`))
        dirs.push(dir)
        await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    }
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrap])
    await service.ready()
    return { service, dir, label }
}

const host = await startParticipant('host')
let guest = await startParticipant('guest')

await host.service.request('add', { text: 'Milk' })
await host.service.request('add', { text: 'Bread' })
await host.service.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })
const hostStatus = await host.service.request('status')
assert.ok(hostStatus.baseId, 'host exposes its base fingerprint')

const invite = (await host.service.request('invite')).inviteKey
assert.ok(invite.length > 0)
await guest.service.request('join', { invite })
await guest.service.waitFor((reply) => reply.joined, { op: 'dump', timeoutMs: 60_000 })
const liveDump = await guest.service.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 60_000 })

// The persistence fix is observable before any restart: the joined base key
// must land in the guest's on-disk secret store (the running service's
// status fingerprint is a join-time cache, so read the store directly).
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function storedBaseFingerprint(dir) {
    const store = createFileSecretStore({ fs, path: join(dir, 'headless-secrets.json') })
    const stored = await store.getItem('listam.secret.v1.autobaseKey')
    return stored ? secretFingerprint(stored) : null
}
let persisted = null
const persistDeadline = Date.now() + 30_000
while (Date.now() < persistDeadline) {
    persisted = await storedBaseFingerprint(guest.dir)
    if (persisted === hostStatus.baseId) break
    await sleep(500)
}
assert.equal(persisted, hostStatus.baseId, 'joined base key is persisted to the secret store at join time')
mark('joined-live')

// Restart the guest on the same storage root.
await guest.service.stop()
guest = await startParticipant('guest-restarted', guest.dir)

// Joined-base boot: right base, still reporting joined (base-state broadcast,
// not a live join-success), same items with identical stable ids.
const restartStatus = await guest.service.waitFor(
    (reply) => reply.joined === true && reply.baseId === hostStatus.baseId,
    { op: 'status', timeoutMs: 30_000 },
)
assert.equal(restartStatus.baseId, hostStatus.baseId, 'restarted guest boots the joined base, not its pre-join base')
const restartDump = await guest.service.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 60_000 })
assert.deepEqual(
    restartDump.items.map((item) => [item.id, item.text]).sort(),
    liveDump.items.map((item) => [item.id, item.text]).sort(),
    'items rebuild from the joined base with identical stable ids',
)
mark('restart-still-joined')

// The scoped writer must come back too: once a peer is reachable again, the
// restarted guest stays writable.
await guest.service.waitFor((reply) => (reply.peerCount ?? 0) > 0, { op: 'dump', timeoutMs: 60_000 })
const add = await guest.service.request('add', { text: 'Eggs' })
assert.equal(add.ok, true, 'restarted guest can still write')
await guest.service.waitFor((reply) => reply.items?.some((item) => item.text === 'Eggs'), { op: 'dump', timeoutMs: 30_000 })
mark('restart-writable')

await guest.service.stop()
await host.service.stop()
await testnet.destroy()
for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
mark('complete')
process.exit(0)
