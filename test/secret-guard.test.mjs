import test from 'node:test'
import assert from 'node:assert/strict'
import { startHeadlessService } from '../src/service.mjs'

// A truncated headless-secrets.json (power loss mid-write on a Pi) used to read
// as "this peer has no secrets", which is NOT a fresh start: the Corestore next
// to it still holds a base, so the backend booted with no key and silently
// adopted whatever identity that store pointed at — for a peer that had joined a
// project, its own pre-join base, writable, replicating to nobody. An unattended
// peer has no one to notice, so the service must refuse to start instead.
//
// The guard runs before any backend or swarm exists, so these cases need no
// testnet. The passing case (no secrets file at all ⇒ genuine first run) is
// covered where it can be asserted without booting a peer: see
// listam-packages/packages/secrets/secret-storage.test.mjs.

function fsWithSecrets(contents) {
    return {
        readFileSync(path) {
            if (path.endsWith('headless-secrets.json')) {
                if (contents === null) {
                    const err = new Error(`ENOENT: no such file, open '${path}'`)
                    err.code = 'ENOENT'
                    throw err
                }
                return contents
            }
            const err = new Error(`ENOENT: no such file, open '${path}'`)
            err.code = 'ENOENT'
            throw err
        },
        writeFileSync() {},
        renameSync() {},
    }
}

function createLogger() {
    const lines = []
    return { lines, log: (...args) => lines.push(args) }
}

test('a corrupt secrets file refuses the boot instead of starting keyless', async () => {
    const logger = createLogger()

    await assert.rejects(
        () => startHeadlessService({
            fs: fsWithSecrets('{"listam.secret.v1.autobaseKey":"aaaa'),
            storageDir: '/tmp/listam-headless-test',
            config: {},
            logger,
        }),
        /could not be read/,
    )

    const fatal = logger.lines.find(([line]) => String(line).includes('[FATAL]'))
    assert.ok(fatal, 'the refusal must be logged for the supervisor')
    assert.ok(String(fatal[0]).includes('could not be read'))
})

test('the refusal names the file to restore and the way to start over', async () => {
    await assert.rejects(
        () => startHeadlessService({
            fs: fsWithSecrets('not json at all'),
            storageDir: '/srv/listam-data',
            config: {},
            logger: createLogger(),
        }),
        (err) => {
            assert.match(err.message, /\/srv\/listam-data\/headless-secrets\.json/)
            assert.match(err.message, /delete the storage directory to start over/)
            return true
        },
    )
})
