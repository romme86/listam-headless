// Phase 13 acceptance (C2 credential boundary): a blind-storage instance
// replicates the owner's base as ciphertext but can never decrypt it. The
// blind helper is configured with the core public key only; it has no
// Autobase, no view, and no code path that accepts the encryption key.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

const SECRET_ITEM_TEXT = 'TopSecretOatMilk'

function bootstrapFlag(testnet) {
    return testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
}

function readOwnerBaseKeyHex(ownerDir) {
    // The test reaches into the owner's secret store the way the owner
    // would copy their base id when configuring a storage helper. Phase 14's
    // owner-control channel automates this hand-off.
    const secrets = JSON.parse(fs.readFileSync(`${ownerDir}/headless-secrets.json`, 'utf8'))
    return secrets['listam.secret.v1.autobaseKey']
}

test('a blind-storage instance replicates ciphertext it cannot decrypt', { timeout: 300_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const ownerDir = mkdtempSync(join(tmpdir(), 'listam-headless-owner-'))
    const blindDir = mkdtempSync(join(tmpdir(), 'listam-headless-blind-'))
    t.after(async () => {
        await testnet.destroy()
        for (const dir of [ownerDir, blindDir]) rmSync(dir, { recursive: true, force: true })
    })

    // Owner participant creates a base with recognizable plaintext content.
    await runOneShot(['setup', '--storage', ownerDir, '--role', 'participant'])
    const owner = runHeadless(['run', '--storage', ownerDir, '--bootstrap', bootstrapFlag(testnet)])
    await owner.ready()
    await owner.request('add', { text: SECRET_ITEM_TEXT })
    await owner.request('add', { text: 'Bread' })
    await owner.waitFor((reply) => reply.items?.length === 2, { op: 'dump', timeoutMs: 30_000 })

    const baseKeyHex = readOwnerBaseKeyHex(ownerDir)
    assert.match(baseKeyHex, /^[0-9a-f]{64}$/)

    // Blind helper pins the owner's base by PUBLIC key only.
    const setup = await runOneShot(['setup', '--storage', blindDir, '--role', 'blind-storage', '--base-key', baseKeyHex])
    assert.equal(setup.parsed?.ok, true)
    const blind = runHeadless(['run', '--storage', blindDir, '--bootstrap', bootstrapFlag(testnet)])
    const ready = await blind.ready()
    assert.equal(ready.role, 'blind-storage')

    // Replication: the helper's stored copy of the owner's core grows.
    const synced = await blind.waitFor(
        (snapshot) => (snapshot.pins?.[0]?.contiguousLength ?? 0) >= 2,
        { timeoutMs: 180_000 },
    )
    assert.ok(synced.pins[0].length >= 2, 'pinned core advertises the owner appends')
    assert.equal(synced.encryptionKey, 'never-held')

    // Credential boundary: every stored block is ciphertext. The plaintext
    // item text must appear nowhere, and blocks must not parse as the op JSON.
    let blocksChecked = 0
    for (let index = 0; index < synced.pins[0].contiguousLength; index++) {
        const { block } = await blind.request('peek', { index })
        if (!block) continue
        blocksChecked++
        const bytes = Buffer.from(block, 'hex')
        assert.equal(bytes.toString('utf8').includes(SECRET_ITEM_TEXT), false, `block ${index} must not leak plaintext`)
        assert.equal(block.includes(Buffer.from(SECRET_ITEM_TEXT, 'utf8').toString('hex')), false)
        let parsedStructure = null
        try {
            parsedStructure = JSON.parse(bytes.toString('utf8'))
        } catch {
            parsedStructure = null
        }
        assert.equal(
            parsedStructure && typeof parsedStructure === 'object' ? 'readable' : 'opaque',
            'opaque',
            `block ${index} must not parse as a readable operation`,
        )
    }
    assert.ok(blocksChecked >= 2, 'the helper actually stored the replicated blocks locally')

    // The helper never received key material: no secret store was ever
    // created on the blind instance.
    assert.equal(existsSync(`${blindDir}/headless-secrets.json`), false)

    // The owner keeps operating normally alongside the helper.
    await owner.request('add', { text: 'Eggs' })
    const grew = await blind.waitFor(
        (snapshot) => (snapshot.pins?.[0]?.length ?? 0) >= 3,
        { timeoutMs: 120_000 },
    )
    assert.ok(grew.pins[0].length >= 3, 'the helper keeps replicating new appends')

    await owner.stop()
    await blind.stop()
})
