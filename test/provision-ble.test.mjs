// Unit test for the `provision-leaf` op logic, against a fake BLE transport and
// a fake os — no radio, no hardware. Proves the op builds the right payload
// from the hub's control key + auto-detected hub_addr, drives provisioning to
// success, and degrades gracefully when Bluetooth is unavailable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_COMMIT, STATUS, CHAR_CONFIG_UUID, reassemble, decodePayload } from '@listam/provisioning'
import { runProvisionLeaf } from '../src/provision-ble.mjs'

const KEY = 'b'.repeat(64)
const leafBridge = { port: 9993, controlKey: KEY }
const fakeOs = {
    networkInterfaces() {
        return {
            lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
            en0: [{ family: 'IPv4', address: '192.168.1.67', internal: false }],
        }
    },
}
const silentLogger = { log() {} }

function makeFakeTransport({ respondWith = STATUS.OK } = {}) {
    const t = {
        id: 'leaf-abc',
        name: 'listam-leaf-3F7A',
        mtu: 64,
        writes: [],
        handler: null,
        async write(uuid, bytes) {
            t.writes.push({ uuid, bytes: Uint8Array.from(bytes) })
            if (bytes[0] === FRAME_COMMIT && t.handler) {
                queueMicrotask(() => t.handler(new Uint8Array([respondWith])))
            }
        },
        async subscribe(_uuid, onValue) {
            t.handler = onValue
            return () => {}
        },
        async close() {
            t.closed = true
        },
    }
    return t
}

test('provision-leaf succeeds and reports fingerprint + hubAddr', async () => {
    const transport = makeFakeTransport()
    const res = await runProvisionLeaf(
        { ssid: 'Sunrise_1012493', psk: 'hfVkzjnyj5Bdrdsc' },
        { leafBridge, logger: silentLogger, os: fakeOs, openTransport: async () => transport },
    )
    assert.equal(res.ok, true)
    assert.equal(res.hubAddr, '192.168.1.67:9993') // internal iface skipped
    assert.equal(res.leafId, 'leaf-abc')
    assert.match(res.controlKeyFingerprint, /^fnv1a32:[0-9a-f]{8}$/)
    assert.equal(transport.closed, true)

    // The bytes written reassemble into the payload the leaf will store.
    for (const w of transport.writes) assert.equal(w.uuid, CHAR_CONFIG_UUID)
    const r = reassemble(transport.writes.map((w) => w.bytes))
    assert.ok(r.ok, r.error)
    const payload = decodePayload(r.payload)
    assert.equal(payload.control_key, KEY)
    assert.equal(payload.hub_addr, '192.168.1.67:9993')
    assert.deepEqual(payload.wifi, [{ ssid: 'Sunrise_1012493', psk: 'hfVkzjnyj5Bdrdsc' }])
})

test('explicit hubAddr overrides auto-detection', async () => {
    const transport = makeFakeTransport()
    const res = await runProvisionLeaf(
        { ssid: 'wifi', psk: 'pw', hubAddr: '10.0.0.5:9993' },
        { leafBridge, logger: silentLogger, os: fakeOs, openTransport: async () => transport },
    )
    assert.equal(res.ok, true)
    assert.equal(res.hubAddr, '10.0.0.5:9993')
})

test('ble-unavailable degrades gracefully (never throws)', async () => {
    const res = await runProvisionLeaf(
        { ssid: 'wifi', psk: 'pw' },
        {
            leafBridge,
            logger: silentLogger,
            os: fakeOs,
            openTransport: async () => {
                const e = new Error('no radio')
                e.code = 'ble-unavailable'
                throw e
            },
        },
    )
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'ble-unavailable')
    assert.ok(res.hint)
})

test('missing wifi is refused before any BLE work', async () => {
    let opened = false
    const res = await runProvisionLeaf(
        {},
        { leafBridge, logger: silentLogger, os: fakeOs, openTransport: async () => { opened = true } },
    )
    assert.equal(res.ok, false)
    assert.equal(opened, false)
})

test('missing leaf bridge is refused', async () => {
    const res = await runProvisionLeaf({ ssid: 'w', psk: 'p' }, { leafBridge: null, logger: silentLogger, os: fakeOs })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'no-leaf-bridge')
})

test('a leaf error status is surfaced', async () => {
    const transport = makeFakeTransport({ respondWith: STATUS.ERR_VALIDATE })
    const res = await runProvisionLeaf(
        { ssid: 'wifi', psk: 'pw' },
        { leafBridge, logger: silentLogger, os: fakeOs, openTransport: async () => transport },
    )
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'provision-failed')
    assert.match(res.message, /ERR_VALIDATE/)
})
