import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildConfig,
    loadConfig,
    saveConfig,
    parseBootstrap,
    normalizeBaseKeyHex,
    DEFAULT_MAX_STORAGE_BYTES,
} from '../src/config.mjs'

test('config builds per role with defaults and validation', () => {
    const participant = buildConfig({ role: 'participant' })
    assert.equal(participant.ok, true)
    assert.equal(participant.config.maxStorageBytes, DEFAULT_MAX_STORAGE_BYTES)
    assert.equal(participant.config.pins, undefined)

    const blind = buildConfig({ role: 'blind-storage', baseKeyHex: 'A'.repeat(64), maxStorageBytes: 1234 })
    assert.equal(blind.ok, true)
    assert.deepEqual(blind.config.pins, ['a'.repeat(64)])
    assert.equal(blind.config.maxStorageBytes, 1234)

    assert.equal(buildConfig({ role: 'blind-storage' }).ok, false, 'blind storage requires a pin key')
    assert.equal(buildConfig({ role: 'superuser' }).ok, false, 'unknown roles are rejected')
})

test('bootstrap strings parse to host/port lists and reject malformed entries', () => {
    assert.deepEqual(parseBootstrap('127.0.0.1:49737'), [{ host: '127.0.0.1', port: 49737 }])
    assert.deepEqual(parseBootstrap('a:1,b:2'), [{ host: 'a', port: 1 }, { host: 'b', port: 2 }])
    assert.equal(parseBootstrap('nonsense'), null)
    assert.equal(parseBootstrap('host:notaport'), null)
    assert.equal(parseBootstrap(''), null)
})

test('base keys must be 32-byte hex', () => {
    assert.equal(normalizeBaseKeyHex('a'.repeat(64)), 'a'.repeat(64))
    assert.equal(normalizeBaseKeyHex('A'.repeat(64)), 'a'.repeat(64))
    assert.equal(normalizeBaseKeyHex('a'.repeat(63)), null)
    assert.equal(normalizeBaseKeyHex('z'.repeat(64)), null)
})

test('config round-trips through the storage dir and rejects corrupt files', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'listam-headless-config-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const built = buildConfig({ role: 'participant', bootstrap: '127.0.0.1:1' })
    saveConfig(fs, dir, built.config)
    assert.deepEqual(loadConfig(fs, dir), built.config)

    fs.writeFileSync(`${dir}/headless-config.json`, 'not json')
    assert.equal(loadConfig(fs, dir), null)
})
