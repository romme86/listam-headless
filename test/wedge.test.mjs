// Regression guard for the unreachable-peer wedge (2026-06-11): guest
// mutations must work while connected, answer promptly when the peer and DHT
// are gone, leave the service near-idle, and never block stdin-EOF shutdown.
// The rows run in helpers/wedge-scenario.mjs as a plain child process (see
// matrix.test.mjs for why); this wrapper asserts a clean exit plus every
// emitted checkpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'wedge-scenario.mjs')

const EXPECTED_MARKS = [
    'WEDGE healthy-guest-add',
    'WEDGE severed-add-answered',
    'WEDGE idle-after-sever',
    'WEDGE eof-exit-clean',
    'WEDGE complete',
]

test('guest mutations survive peer+DHT loss without wedging the service', { timeout: 240_000 }, async () => {
    const proc = spawn(process.execPath, [SCENARIO], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })

    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, `wedge scenario failed (exit ${code})\nstdout tail: ${stdout.slice(-1500)}\nstderr tail: ${stderr.slice(-3000)}`)
    for (const markLine of EXPECTED_MARKS) {
        assert.ok(stdout.includes(markLine), `missing wedge checkpoint: ${markLine}`)
    }
})
