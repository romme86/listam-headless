// Regression guard (2026-06-12): a guest joined via the fast "already
// writable" pairing path must persist the joined base and remain joined,
// writable, and content-complete across a restart. The rows run in
// helpers/join-restart-scenario.mjs as a plain child process (see
// matrix.test.mjs for why); this wrapper asserts a clean exit plus every
// emitted checkpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'join-restart-scenario.mjs')

const EXPECTED_MARKS = [
    'JOIN-RESTART joined-live',
    'JOIN-RESTART restart-still-joined',
    'JOIN-RESTART restart-writable',
    'JOIN-RESTART complete',
]

test('a joined guest restarts onto the joined base, still joined and writable', { timeout: 240_000 }, async () => {
    const proc = spawn(process.execPath, [SCENARIO], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, `join-restart scenario failed (exit ${code})\nstdout tail: ${stdout.slice(-1500)}\nstderr tail: ${stderr.slice(-3000)}`)
    for (const markLine of EXPECTED_MARKS) {
        assert.ok(stdout.includes(markLine), `missing join-restart checkpoint: ${markLine}`)
    }
})
