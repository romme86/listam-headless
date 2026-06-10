// Phase 15: the headless-driven subset of the cross-instance acceptance
// matrix, in CI. The rows run in helpers/matrix-scenario.mjs as a plain child
// process (see owner-control.test.mjs for why); this wrapper asserts a clean
// exit plus every emitted row checkpoint.
//
// CI default runs the CORE tier (deterministic, join-time replication). Set
// LISTAM_MATRIX_FULL=1 to also run the sustained-replication tier (steady-
// state edits, C1 re-key, 3-way kill/rejoin), which depends on main-swarm DHT
// reconnection timing between independent processes and is therefore a
// documented, repeatable extended run rather than a CI gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'matrix-scenario.mjs')
const FULL = process.env.LISTAM_MATRIX_FULL === '1'

const CORE_MARKS = [
    'MATRIX join-and-duplicate-names',
    'MATRIX invite-rotation',
    'MATRIX owner-gate-roster',
]
const FULL_MARKS = [
    'MATRIX steady-state-convergence',
    'MATRIX member-removal-rekey',
    'MATRIX three-way-convergence',
    'MATRIX survivors-continue',
    'MATRIX rejoin-reconciles',
    'MATRIX complete',
]
const EXPECTED_MARKS = FULL ? [...CORE_MARKS, ...FULL_MARKS] : [...CORE_MARKS, 'MATRIX core-complete']

test('cross-instance acceptance matrix (headless-driven subset)', { timeout: FULL ? 1_800_000 : 240_000 }, async () => {
    const proc = spawn(process.execPath, [SCENARIO], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, `matrix scenario failed (exit ${code})\nstdout tail: ${stdout.slice(-1500)}\nstderr tail: ${stderr.slice(-3000)}`)
    for (const markLine of EXPECTED_MARKS) {
        assert.ok(stdout.includes(markLine), `missing matrix row checkpoint: ${markLine}`)
    }
})
