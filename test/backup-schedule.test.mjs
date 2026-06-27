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
