import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBlindPins } from '../src/blind-pins.mjs'

const A = '11'.repeat(32), B = '22'.repeat(32), C = '33'.repeat(32)
test('signed manifest revisions and manual pins survive restart without secret fields', (t) => {
    const storageDir = fs.mkdtempSync(join(tmpdir(), 'listam-pins-'))
    t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
    let pins = createBlindPins({ fs, storageDir, pins: [A] })
    pins.pin(B)
    assert.throws(() => pins.apply({ version: 1, baseKey: A, revision: 3, keys: [A, C], encryptionKey: 'must-not-persist' }, B), /invalid/)
    pins.apply({ version: 1, baseKey: A, revision: 3, keys: [A, C] }, B)
    pins = createBlindPins({ fs, storageDir, pins: [A] })
    assert.deepEqual(pins.keys(), [A, B, C])
    assert.equal(fs.readFileSync(join(storageDir, 'headless-blind-pins.json'), 'utf8').includes('must-not-persist'), false)
    assert.throws(() => pins.apply({ version: 1, baseKey: A, revision: 2, keys: [] }, B), /stale/)
    assert.throws(() => pins.apply({ version: 1, baseKey: A, revision: 3, keys: [] }, B), /conflicting/)
    pins.apply({ version: 1, baseKey: A, revision: 3, keys: [C, A] }, B)
    pins.apply({ version: 1, baseKey: A, revision: 4, keys: [] }, B)
    assert.deepEqual(pins.keys(), [A, B], 'removing one manifest retains independent manual pins')
})

test('failed persistence cannot advance a helper manifest revision', (t) => {
    const storageDir = fs.mkdtempSync(join(tmpdir(), 'listam-pins-failure-'))
    t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }))
    const pins = createBlindPins({ fs: { ...fs, renameSync() { throw new Error('disk failure') } }, storageDir, pins: [A] })
    assert.throws(() => pins.apply({ version: 1, baseKey: A, revision: 1, keys: [B] }), /disk failure/)
    assert.deepEqual(pins.keys(), [A])
    assert.equal(pins.manifestCount(), 0)
})
