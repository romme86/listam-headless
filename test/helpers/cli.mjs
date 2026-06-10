// Spawns `headless.mjs` as a child process and drives its JSON-line stdin
// protocol — the same way an operator script or the future interaction-matrix
// harness would.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'headless.mjs')

export function runHeadless(args) {
    const proc = spawn(process.execPath, [ENTRY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map()
    let nextId = 0
    let resolveReady
    const readyPromise = new Promise((resolve) => { resolveReady = resolve })
    let stderr = ''
    let exited = false
    let exitCode = null

    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('exit', (code) => { exited = true; exitCode = code })
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let message = null
        try {
            message = JSON.parse(line)
        } catch {
            return
        }
        if (message.event === 'ready') resolveReady(message)
        if (message.id != null && pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })

    return {
        proc,
        get stderr() { return stderr },
        get exited() { return exited },
        get exitCode() { return exitCode },
        async ready() {
            const result = await Promise.race([
                readyPromise,
                once(proc, 'exit').then(() => null),
            ])
            if (!result) {
                throw new Error(`headless exited before ready (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`)
            }
            return result
        },
        request(op, fields = {}) {
            if (exited) {
                return Promise.reject(new Error(`headless already exited (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`))
            }
            const id = ++nextId
            const response = new Promise((resolve) => pending.set(id, resolve))
            proc.stdin.write(JSON.stringify({ ...fields, id, op }) + '\n')
            const exitRejection = once(proc, 'exit').then(() => {
                throw new Error(`headless exited mid-request '${op}' (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`)
            })
            // The exit branch fires eventually even when the response won the
            // race; keep its rejection handled so teardown never reports it.
            exitRejection.catch(() => {})
            return Promise.race([response, exitRejection])
        },
        async waitFor(predicate, { op = 'status', timeoutMs = 120_000, intervalMs = 1000 } = {}) {
            const deadline = Date.now() + timeoutMs
            for (;;) {
                const snapshot = await this.request(op)
                if (predicate(snapshot)) return snapshot
                if (Date.now() > deadline) {
                    throw new Error(`waitFor timed out; last: ${JSON.stringify(snapshot)}\nstderr tail: ${stderr.slice(-2000)}`)
                }
                await new Promise((resolve) => setTimeout(resolve, intervalMs))
            }
        },
        async stop() {
            if (exited) return
            try {
                const done = once(proc, 'exit')
                const timeout = new Promise((resolve) => setTimeout(resolve, 10_000, 'timeout'))
                proc.stdin.write(JSON.stringify({ id: ++nextId, op: 'shutdown' }) + '\n')
                if (await Promise.race([done, timeout]) === 'timeout') {
                    proc.kill('SIGKILL')
                }
            } catch {
                proc.kill('SIGKILL')
            }
        },
    }
}

export async function runOneShot(args) {
    const proc = spawn(process.execPath, [ENTRY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    const [code] = await once(proc, 'exit')
    let parsed = null
    try {
        parsed = JSON.parse(stdout.trim().split('\n').at(-1))
    } catch {}
    return { code, parsed, stdout }
}
