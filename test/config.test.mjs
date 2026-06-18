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
    normalizeVoiceConfig,
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

test('voice exec-confidence floors default sanely and accept config + env overrides', () => {
    const def = normalizeVoiceConfig({}, {})
    assert.deepEqual(def.execConfidence, { add_item: 0.75, remove_item: 0.9, note: 0.75 })
    assert.ok(def.execConfidence.remove_item > 0.85, 'destructive remove floor must exceed the grammar max')

    // config.voice.execConfidence overrides per intent; out-of-range/garbage falls back to the default.
    const fromCfg = normalizeVoiceConfig({ execConfidence: { add_item: 0.5, remove_item: 1.2, note: 'x' } }, {})
    assert.equal(fromCfg.execConfidence.add_item, 0.5)
    assert.equal(fromCfg.execConfidence.remove_item, 0.9, 'a >1 value is rejected -> default')
    assert.equal(fromCfg.execConfidence.note, 0.75, 'a non-number is rejected -> default')

    // env wins over config and over the default.
    const fromEnv = normalizeVoiceConfig(
        { execConfidence: { remove_item: 0.95 } },
        { LISTAM_VOICE_FLOOR_ADD: '0.9', LISTAM_VOICE_FLOOR_REMOVE: '0.99' },
    )
    assert.equal(fromEnv.execConfidence.add_item, 0.9)
    assert.equal(fromEnv.execConfidence.remove_item, 0.99)
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
