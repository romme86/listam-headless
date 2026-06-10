// H1 acceptance scenario, run as a plain child process by
// test/owner-control.test.mjs. Assertions are node:assert — any failure
// crashes this process with a nonzero exit. Run as a standalone script (not
// under node:test) so hyperdht's teardown noise can be filtered narrowly:
// after the checks have passed, a late 'connection reset by peer' from an
// internal UDX stream is irrelevant; everything else still fails the run.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import b4a from 'b4a'
import {
    createCommandEnvelope,
    createDeviceKeyPair,
    createOwnerControlSession,
    createRotationPayload,
    parsePairingCode,
} from '@listam/owner-control'
import { runHeadless, runOneShot } from './cli.mjs'

process.on('uncaughtException', (error) => {
    if (/connection reset by peer/i.test(error?.message ?? '')) return
    console.error(error)
    process.exit(1)
})

const mark = (label) => console.log(`SCENARIO ${label}`)

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

async function connectControl(dht, serverPublicKeyHex, keyPair) {
    const socket = dht.connect(b4a.from(serverPublicKeyHex, 'hex'))
    await once(socket, 'open')
    socket.on('error', () => {})
    const session = createOwnerControlSession({
        keyPair,
        write: (line) => socket.write(line + '\n'),
    })
    const raw = []
    readline.createInterface({ input: socket }).on('line', (line) => {
        if (!session.handleLine(line)) raw.push(JSON.parse(line))
    })
    return {
        session,
        raw,
        sendRaw: (value) => socket.write(JSON.stringify(value) + '\n'),
        close: () => socket.destroy(),
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- scenario 1: the full H1 matrix ----------------------------------------
{
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-control-'))
    const dht = new DHT({ bootstrap: testnet.bootstrap })

    await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    const ready = await service.ready()
    assert.match(ready.controlPublicKey, /^[0-9a-f]{64}$/, 'service announces its control address')
    await service.request('add', { text: 'Milk' })

    // Pairing bootstrap: admin, diagnostics-only, and a probe for raw frames.
    const adminPairing = await service.request('control-pair', {
        capabilities: ['status:read', 'diagnostics:read', 'invite:create', 'export:create', 'import:apply', 'service:shutdown'],
    })
    const diagPairing = await service.request('control-pair', { capabilities: ['status:read', 'diagnostics:read'] })
    const probePairing = await service.request('control-pair', { capabilities: ['status:read'] })

    const adminKey = createDeviceKeyPair()
    const diagKey = createDeviceKeyPair()
    const probeKey = createDeviceKeyPair()
    const admin = await connectControl(dht, ready.controlPublicKey, adminKey)
    const diag = await connectControl(dht, ready.controlPublicKey, diagKey)
    const probe = await connectControl(dht, ready.controlPublicKey, probeKey)

    assert.equal((await admin.session.pair(parsePairingCode(adminPairing.code).secretHex, 'Admin laptop')).ok, true)
    const diagPaired = await diag.session.pair(parsePairingCode(diagPairing.code).secretHex, 'Diag phone')
    assert.equal(diagPaired.ok, true)
    assert.deepEqual(diagPaired.capabilities, ['status:read', 'diagnostics:read'])
    assert.equal((await probe.session.pair(parsePairingCode(probePairing.code).secretHex, 'Probe')).ok, true)
    mark('paired')

    // A pairing code is single-use.
    const thief = await connectControl(dht, ready.controlPublicKey, createDeviceKeyPair())
    const stolen = await thief.session.pair(parsePairingCode(adminPairing.code).secretHex, 'Thief')
    assert.equal(stolen.ok, false)
    assert.equal(stolen.reason, 'pairing-used')

    // Signed command success.
    const status = await admin.session.request('status')
    assert.equal(status.ok, true)
    assert.equal(status.status.itemCount, 1)
    const diagnostics = await diag.session.request('diagnostics')
    assert.equal(diagnostics.ok, true)
    assert.ok(Array.isArray(diagnostics.audit) && diagnostics.audit.length > 0, 'diagnostics expose the audit ring')
    mark('signed-commands')

    // Acceptance: a diagnostics-only client cannot administer.
    for (const [command, payload] of [['shutdown', null], ['import', { data: {} }], ['export', null], ['topics', { action: 'pin', key: 'a'.repeat(64) }]]) {
        const refused = await diag.session.request(command, payload)
        assert.equal(refused.ok, false, `${command} must be refused for diagnostics-only`)
        assert.equal(refused.reason, 'out-of-scope')
    }
    mark('capability-gates')

    // Unsigned / malformed / replayed / expired refusal.
    const unsignedEnvelope = createCommandEnvelope({ keyPair: probeKey, command: 'status', seq: Date.now() + 5_000, now: Date.now() })
    delete unsignedEnvelope.signature
    probe.sendRaw(unsignedEnvelope)
    probe.sendRaw({ v: 1, command: 'status', deviceId: probe.session.deviceId, ts: Date.now(), seq: 999999 })
    await sleep(500)
    assert.ok(probe.raw.some((reply) => reply.commandId === unsignedEnvelope.commandId && reply.ok === false && reply.reason === 'unsigned'), 'unsigned envelope refused')
    assert.ok(probe.raw.some((reply) => reply.ok === false && ['malformed', 'scope-mismatch'].includes(reply.reason)), 'garbage frame refused')

    const replayEnvelope = createCommandEnvelope({ keyPair: probeKey, command: 'status', seq: Date.now() + 10_000, now: Date.now() })
    probe.sendRaw(replayEnvelope)
    await sleep(400)
    probe.sendRaw(replayEnvelope)
    await sleep(500)
    assert.ok(probe.raw.some((reply) => reply.commandId === replayEnvelope.commandId && reply.ok === true), 'first delivery accepted')
    assert.ok(probe.raw.some((reply) => reply.commandId === replayEnvelope.commandId && reply.ok === false && reply.reason === 'replay'), 'replayed envelope refused')

    const expired = createCommandEnvelope({ keyPair: probeKey, command: 'status', seq: Date.now() + 20_000, now: Date.now() - 10 * 60_000 })
    probe.sendRaw(expired)
    await sleep(500)
    assert.ok(probe.raw.some((reply) => reply.commandId === expired.commandId && reply.reason === 'expired'), 'expired envelope refused')

    const stranger = await connectControl(dht, ready.controlPublicKey, createDeviceKeyPair())
    const unknown = await stranger.session.request('status')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.reason, 'unknown-device')
    mark('refusals')

    // Admin capabilities actually work.
    const invite = await admin.session.request('invite')
    assert.equal(invite.ok, true)
    assert.ok(invite.inviteKey.length > 0, 'invite minted over owner-control')
    const exported = await admin.session.request('export')
    assert.equal(exported.ok, true)
    assert.equal(exported.export.items.length, 1)
    mark('admin-commands')

    // Rotation: old key dies, new key inherits grants.
    const rotatedKey = createDeviceKeyPair()
    assert.equal((await admin.session.request('rotate', createRotationPayload(rotatedKey))).ok, true)
    assert.equal((await admin.session.request('status')).reason, 'revoked-device', 'pre-rotation key is dead')
    const rotated = await connectControl(dht, ready.controlPublicKey, rotatedKey)
    assert.equal((await rotated.session.request('status')).ok, true, 'rotated key inherits the registration')
    mark('rotation')

    // Operator-side revocation.
    assert.equal((await service.request('control-revoke', { deviceId: diag.session.deviceId })).ok, true)
    assert.equal((await diag.session.request('status')).reason, 'revoked-device')
    const devices = await service.request('control-devices')
    assert.ok(devices.devices.some((device) => device.deviceId === rotated.session.deviceId && !device.revokedAt))
    assert.ok(devices.devices.some((device) => device.deviceId === diag.session.deviceId && device.revokedAt))
    mark('revocation')

    await service.stop()
    rmSync(dir, { recursive: true, force: true })
}

// --- scenario 2: an authorized remote shutdown stops the service ------------
{
    const testnet = await createTestnet(3)
    const dir = mkdtempSync(join(tmpdir(), 'listam-control-stop-'))
    const dht = new DHT({ bootstrap: testnet.bootstrap })

    await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrapFlag(testnet)])
    const ready = await service.ready()

    const pairing = await service.request('control-pair', { capabilities: ['service:shutdown'] })
    const client = await connectControl(dht, ready.controlPublicKey, createDeviceKeyPair())
    await client.session.pair(parsePairingCode(pairing.code).secretHex, 'Ops')

    const reply = await client.session.request('shutdown')
    assert.equal(reply.ok, true)
    const [code] = await once(service.proc, 'exit')
    assert.equal(code, 0, 'service exited gracefully on the authorized shutdown')
    mark('remote-shutdown')

    rmSync(dir, { recursive: true, force: true })
}

mark('complete')
// Hard exit: remaining DHT handles are torn down with the process; the
// headless children exit themselves on stdin EOF.
process.exit(0)
