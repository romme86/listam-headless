import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import createTestnet from 'hyperdht/testnet.js'
import { createFileSecretStore } from '@listam/secrets'
import { runHeadless, runOneShot } from './helpers/cli.mjs'

test('a participant pairs with a blind helper and publishes/revokes a signed manifest', { timeout: 90000 }, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'listam-mirror-control-'))
    const network = await createTestnet(3)
    const services = []
    t.after(async () => {
        for (const service of services) await service.stop()
        await network.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    })
    const bootstrap = network.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
    const ownerDir = join(root, 'owner'), helperDir = join(root, 'helper')
    await runOneShot(['setup', '--storage', ownerDir, '--role', 'participant'])
    function localRelaysOnly(dir) {
        const path = join(dir, 'headless-config.json')
        const config = JSON.parse(fs.readFileSync(path, 'utf8'))
        fs.writeFileSync(path, JSON.stringify({ ...config, relayKeys: [] }))
    }
    localRelaysOnly(ownerDir)
    const owner = runHeadless(['run', '--storage', ownerDir, '--bootstrap', bootstrap])
    services.push(owner)
    await owner.ready()
    await owner.request('add', { text: 'encrypted mirror check' })
    const secrets = createFileSecretStore({ fs, path: join(ownerDir, 'headless-secrets.json') })
    const baseKey = await secrets.getItem('listam.secret.v1.autobaseKey')
    assert.match(baseKey, /^[0-9a-f]{64}$/)
    await runOneShot(['setup', '--storage', helperDir, '--role', 'blind-storage', '--base-key', baseKey])
    localRelaysOnly(helperDir)
    const helper = runHeadless(['run', '--storage', helperDir, '--bootstrap', bootstrap])
    services.push(helper)
    const ready = await helper.ready()
    const offer = await helper.request('control-pair', { capabilities: ['topics:configure', 'status:read'] })
    const paired = await owner.request('control-connect', { code: offer.code, name: 'Mirror controller' })
    assert.equal(paired.ok, true, JSON.stringify(paired) + owner.stderr + helper.stderr)
    const command = (action) => owner.request('control-command', {
        serverPublicKeyHex: ready.controlPublicKey, command: 'topics', payload: { action, baseKey },
    })
    const subscribed = await command('mirror')
    assert.equal(subscribed.ok, true, JSON.stringify(subscribed))
    const persisted = JSON.parse(fs.readFileSync(join(helperDir, 'headless-blind-pins.json'), 'utf8'))
    const [[id, manifest]] = Object.entries(persisted.manifests)
    assert.match(id, /^[0-9a-f]{64}:[0-9a-f]{64}$/)
    assert.ok(manifest.keys.length >= 3, 'bootstrap, system and materialized view registered')
    assert.equal((await command('stop-mirror')).ok, true)
    const stopped = JSON.parse(fs.readFileSync(join(helperDir, 'headless-blind-pins.json'), 'utf8'))
    assert.deepEqual(stopped.manifests[id].keys, [])
    assert.deepEqual(stopped.manual, [baseKey], 'explicit setup pin survives subscription removal')
})
