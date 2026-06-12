// Unreachable-peer wedge regression (2026-06-11 cross-device finding) — run
// as a child process by test/wedge.test.mjs (same arrangement as the matrix
// scenario: hyperdht teardown noise filtered narrowly, every assertion still
// fails the run).
//
// Guards three behaviors:
//  1. A guest-side mutation works while connected (the original root cause —
//     a stale pre-join 'local' core block froze the joined base's writer, so
//     every guest append busy-looped at ~99% CPU and never resolved).
//  2. After the peer AND the DHT vanish, a mutation still answers promptly
//     (local-first append or clean refusal — never a silent hang) and the
//     service stays near-idle instead of spinning.
//  3. stdin EOF shuts the service down even in the severed state.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
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

const mark = (label) => console.log(`WEDGE ${label}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dirs = []
async function participant(label, bootstrap) {
    const dir = mkdtempSync(join(tmpdir(), `wedge-test-${label}-`))
    dirs.push(dir)
    const setup = await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    assert.equal(setup.code, 0, `${label} setup failed`)
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrap])
    await service.ready()
    return service
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')

const host = await participant('host', bootstrap)
const guest = await participant('guest', bootstrap)

await host.request('add', { text: 'Milk' })
const invite = (await host.request('invite')).inviteKey
assert.ok(invite, 'host must mint an invite')
await guest.request('join', { invite })
await guest.waitFor((r) => r.joined, { op: 'dump' })
await guest.waitFor((r) => r.items?.length >= 1, { op: 'dump' })

// 1. Guest-side mutation while connected must commit and replicate.
const healthyAdd = await guest.request('add', { text: 'Guest item' })
assert.equal(healthyAdd.ok, true, `healthy guest add refused: ${JSON.stringify(healthyAdd)}`)
await host.waitFor((r) => r.items?.some((i) => i.text === 'Guest item'), { op: 'dump', timeoutMs: 60_000 })
mark('healthy-guest-add')

// 2. Sever peer and DHT; the next mutation must still answer promptly.
host.proc.kill('SIGKILL')
await testnet.destroy()
const severedAdd = await Promise.race([
    guest.request('add', { text: 'Severed item' }),
    sleep(25_000).then(() => null),
])
assert.ok(severedAdd, 'severed add never answered (one-response-per-request contract broken)')
mark('severed-add-answered')

// The pre-fix wedge pegged a core (~99%); allow generous headroom for
// legitimate post-disconnect work.
await sleep(3_000)
const cpu = Number(execSync(`ps -o %cpu= -p ${guest.proc.pid}`).toString().trim())
assert.ok(cpu < 50, `guest spinning after sever: ${cpu}% CPU`)
mark('idle-after-sever')

// 3. stdin EOF must end the process even in the severed state (the shutdown
// watchdog bounds a wedged teardown at 5s).
guest.proc.stdin.end()
const exited = await Promise.race([
    new Promise((resolve) => guest.proc.once('exit', () => resolve(true))),
    sleep(8_000).then(() => false),
])
assert.ok(exited, 'guest ignored stdin EOF shutdown')
mark('eof-exit-clean')

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
mark('complete')
process.exit(0)
