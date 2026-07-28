// Operator surface for scheduled (rolling) backups. The scheduler itself lives
// in @listam/backend and arms automatically once a backup password is set; these
// tests cover the headless ergonomics around it: setting a password over stdin,
// observing the `schedule` field in list-backups, toggling it off, and the
// non-interactive config bootstrap (LISTAM_BACKUP_PASSWORD).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

// The backend logs one of these per RPC_LIST_BACKUPS it serves (plus a generic
// "Got a request" line), which is exactly what made the status poll visible in
// the journal — so count them to prove the poll is gone.
function countBackupPolls(stderr) {
    return (stderr.match(/Command RPC_LIST_BACKUPS/g) ?? []).length
}

function readStatusFile(dir) {
    try { return JSON.parse(fs.readFileSync(join(dir, 'headless-status.json'), 'utf8')) } catch { return null }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A scheduled file lands in <storage>/<headless namespace>/backups; the exact
// path is owned by the backend, so just hunt the storage tree for the fixed
// rolling filenames rather than hard-coding the layout.
function findScheduledFiles(dir) {
    const out = []
    const walk = (p) => {
        let entries = []
        try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
            const full = join(p, e.name)
            if (e.isDirectory()) walk(full)
            else if (/^scheduled-(15m|1d|1w)\.listam$/.test(e.name)) out.push(full)
        }
    }
    walk(dir)
    return out
}

test('set-backup-password arms the rolling schedule and list-backups surfaces it', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-backup-sched-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    const node = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await node.ready()
    t.after(() => node.stop())

    // Before any password: schedule is reported, password not set, no scheduled files.
    const before = await node.request('list-backups')
    assert.equal(before.ok, true)
    assert.ok(before.schedule, 'list-backups carries a schedule object')
    assert.equal(before.schedule.passwordSet, false)
    assert.equal(before.schedule.tiers.length, 3, 'three rolling cadences are reported')
    assert.deepEqual(
        before.schedule.tiers.map((t) => t.reason),
        ['scheduled-15m', 'scheduled-1d', 'scheduled-1w'],
    )

    // Setting the password arms the scheduler (catch-up pass writes the files now).
    const setPw = await node.request('set-backup-password', { password: 'correct-horse-battery-staple' })
    assert.equal(setPw.ok, true, `set-backup-password failed: ${JSON.stringify(setPw)}`)

    // The schedule now reports passwordSet, and the rolling files exist + appear
    // in the backups array with real createdAt.
    const armed = await node.waitFor(
        (reply) => reply.schedule?.passwordSet === true && reply.schedule?.tiers?.some((t) => t.lastAt),
        { op: 'list-backups', timeoutMs: 30_000 },
    )
    assert.equal(armed.schedule.enabled, true, 'schedule defaults enabled')
    const scheduledInList = armed.backups.filter((b) => /^scheduled-/.test(b.file))
    assert.ok(scheduledInList.length >= 1, 'rolling files appear in the backups array')
    assert.ok(scheduledInList.every((b) => Number.isFinite(b.createdAt)), 'rolling files carry a real createdAt')

    const onDisk = findScheduledFiles(dir)
    assert.ok(onDisk.length >= 1, `expected at least one scheduled-*.listam on disk, found ${onDisk.length}`)

    // Toggle the whole schedule off via the operator op; reply echoes the new state.
    const off = await node.request('set-backup-schedule', { enabled: false })
    assert.equal(off.ok, true, `set-backup-schedule failed: ${JSON.stringify(off)}`)
    assert.equal(off.schedule.enabled, false)

    // ...and the status snapshot reflects it.
    const status = await node.waitFor(
        (reply) => reply.backup?.scheduleEnabled === false,
        { op: 'status', timeoutMs: 15_000 },
    )
    assert.equal(status.backup.passwordSet, true)
    assert.equal(status.backup.tiers.length, 3)
})

// An always-on peer used to re-read RPC_LIST_BACKUPS on every 5s status write:
// ~34.5k journal lines/day for a summary whose fastest tier moves every 15
// minutes. The status file must stay live at 5s WITHOUT the backup poll riding
// along — check both halves, since silencing the poll by stalling the status
// write would be the obvious wrong fix.
test('the 5s status write no longer polls the backup summary', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-backup-poll-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    const node = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    await node.ready()
    t.after(() => node.stop())

    // Boot legitimately reads the summary once; wait for it to land so the
    // measured window is steady state rather than bootstrap.
    await node.waitFor((reply) => reply.backup != null, { op: 'status', timeoutMs: 30_000 })

    const pollsBefore = countBackupPolls(node.stderr)
    const statusBefore = readStatusFile(dir)
    assert.ok(Number.isFinite(statusBefore?.updatedAt), 'status file is being written')

    // ~4 status ticks, comfortably inside the 60s summary cadence.
    await sleep(22_000)

    const statusAfter = readStatusFile(dir)
    assert.ok(
        statusAfter.updatedAt - statusBefore.updatedAt >= 15_000,
        `status file must keep its 5s tick (advanced only ${statusAfter.updatedAt - statusBefore.updatedAt}ms)`,
    )
    assert.ok(statusAfter.backup, 'the cached backup summary is still reported')

    const polled = countBackupPolls(node.stderr) - pollsBefore
    assert.ok(polled <= 1, `expected at most 1 backup poll across ~4 status ticks, saw ${polled}`)

    // An operator op that CHANGES backup state must still be reflected at once,
    // not up to a minute later.
    const off = await node.request('set-backup-schedule', { enabled: false })
    assert.equal(off.ok, true, `set-backup-schedule failed: ${JSON.stringify(off)}`)
    const status = await node.request('status')
    assert.equal(status.backup.scheduleEnabled, false, 'status reflects the toggle without waiting for the slow refresh')
})

test('config/env password bootstraps the schedule with no interactive step', { timeout: 240_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-backup-boot-'))
    t.after(async () => {
        await testnet.destroy()
        rmSync(dir, { recursive: true, force: true })
    })

    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.parsed?.ok, true)

    // The password is supplied only via env — never typed over stdin. The child
    // inherits process.env (cli.mjs spawns without an env override), so set it
    // around the spawn and restore immediately so it can't leak to other tests.
    const prior = process.env.LISTAM_BACKUP_PASSWORD
    process.env.LISTAM_BACKUP_PASSWORD = 'env-seeded-passphrase'
    let node
    try {
        node = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    } finally {
        if (prior === undefined) delete process.env.LISTAM_BACKUP_PASSWORD
        else process.env.LISTAM_BACKUP_PASSWORD = prior
    }
    await node.ready()
    t.after(() => node.stop())

    const armed = await node.waitFor(
        (reply) => reply.schedule?.passwordSet === true && reply.schedule?.tiers?.some((t) => t.lastAt),
        { op: 'list-backups', timeoutMs: 30_000 },
    )
    assert.equal(armed.schedule.passwordSet, true, 'env-bootstrapped password armed the schedule')
    assert.ok(findScheduledFiles(dir).length >= 1, 'rolling files written from the env-bootstrapped password')
})
