// Phase 14 acceptance (H1): the full owner-control matrix runs in
// helpers/owner-control-scenario.mjs as a plain child process (hyperdht's
// post-teardown noise cannot be filtered narrowly under the node:test
// runner). Every assertion lives in the scenario; a failed assert crashes it
// with a nonzero exit and its stderr is surfaced here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'owner-control-scenario.mjs')

const EXPECTED_MARKS = [
    'SCENARIO paired',
    'SCENARIO signed-commands',
    'SCENARIO capability-gates',
    'SCENARIO refusals',
    'SCENARIO admin-commands',
    'SCENARIO rotation',
    'SCENARIO revocation',
    'SCENARIO remote-shutdown',
    'SCENARIO complete',
]

test('owner-control acceptance: pairing, gates, refusals, rotation, revocation, remote shutdown', { timeout: 480_000 }, async () => {
    const proc = spawn(process.execPath, [SCENARIO], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, `scenario failed (exit ${code})\nstdout tail: ${stdout.slice(-1500)}\nstderr tail: ${stderr.slice(-3000)}`)
    for (const markLine of EXPECTED_MARKS) {
        assert.ok(stdout.includes(markLine), `missing checkpoint: ${markLine}`)
    }
})
