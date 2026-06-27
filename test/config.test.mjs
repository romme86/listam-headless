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
    normalizeBackupConfig,
    DEFAULT_VOICE_PROMPTS,
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

test('voice prompt: per-locale default applies for a concrete locale, never for auto, and is overridable', () => {
    // a concrete locale with no explicit prompt -> the built-in default for it
    assert.deepEqual(
        normalizeVoiceConfig({ locale: 'it' }, {}).extraArgs,
        ['--prompt', DEFAULT_VOICE_PROMPTS.it],
    )
    // auto (the default) must NOT anchor to any language
    assert.deepEqual(normalizeVoiceConfig({}, {}).extraArgs, [])
    assert.deepEqual(normalizeVoiceConfig({ locale: 'auto' }, {}).extraArgs, [])
    // an explicit prompt always wins over the per-locale default
    assert.deepEqual(
        normalizeVoiceConfig({ locale: 'it', prompt: 'custom words' }, {}).extraArgs,
        ['--prompt', 'custom words'],
    )
    // env prompt also wins
    assert.deepEqual(
        normalizeVoiceConfig({ locale: 'it' }, { LISTAM_VOICE_PROMPT: 'env words' }).extraArgs,
        ['--prompt', 'env words'],
    )
    // user extraArgs are appended after the default prompt
    assert.deepEqual(
        normalizeVoiceConfig({ locale: 'it', extraArgs: ['-t', '4'] }, {}).extraArgs,
        ['--prompt', DEFAULT_VOICE_PROMPTS.it, '-t', '4'],
    )
})

test('backup config: schedule defaults on, env/config can disable, password optional and never defaulted', () => {
    // default: schedule on, no password
    assert.deepEqual(normalizeBackupConfig({}, {}), { scheduledEnabled: true, password: null })
    assert.deepEqual(normalizeBackupConfig(undefined, {}), { scheduledEnabled: true, password: null })

    // config disables; password carried through verbatim
    assert.deepEqual(
        normalizeBackupConfig({ scheduledEnabled: false, password: 'hunter2' }, {}),
        { scheduledEnabled: false, password: 'hunter2' },
    )

    // env LISTAM_BACKUP_SCHEDULED overrides (false-ish strings disable)
    assert.equal(normalizeBackupConfig({ scheduledEnabled: true }, { LISTAM_BACKUP_SCHEDULED: 'false' }).scheduledEnabled, false)
    assert.equal(normalizeBackupConfig({ scheduledEnabled: false }, { LISTAM_BACKUP_SCHEDULED: 'true' }).scheduledEnabled, true)
    assert.equal(normalizeBackupConfig({}, { LISTAM_BACKUP_SCHEDULED: '0' }).scheduledEnabled, false)
    assert.equal(normalizeBackupConfig({}, { LISTAM_BACKUP_SCHEDULED: 'off' }).scheduledEnabled, false)

    // env password wins over config; empty string is treated as no password
    assert.equal(normalizeBackupConfig({ password: 'cfg' }, { LISTAM_BACKUP_PASSWORD: 'env' }).password, 'env')
    assert.equal(normalizeBackupConfig({ password: '' }, {}).password, null)
})

test('buildConfig persists a backup block only for participants and only when a knob is set', () => {
    // nothing asked -> no backup block (config stays byte-identical to before)
    assert.equal('backup' in buildConfig({ role: 'participant' }).config, false)

    // disabling the schedule persists scheduledEnabled:false
    assert.deepEqual(
        buildConfig({ role: 'participant', backupScheduled: false }).config.backup,
        { scheduledEnabled: false },
    )

    // a password seeds the block
    assert.deepEqual(
        buildConfig({ role: 'participant', backupPassword: 's3cret' }).config.backup,
        { password: 's3cret' },
    )

    // blind-storage never carries a backup block (no decryptable data)
    const blind = buildConfig({ role: 'blind-storage', baseKeyHex: 'a'.repeat(64), backupPassword: 'x', backupScheduled: false })
    assert.equal('backup' in blind.config, false)
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
