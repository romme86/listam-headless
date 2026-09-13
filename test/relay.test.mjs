// Blind-relay acceptance (the server half of the 4G pairing fix): two peers
// that cannot punch must still be able to meet through the owner's always-on
// box, and the address they meet at must never change under them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import DHT from 'hyperdht'
import { createSocket } from 'node:dgram'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'
import { startRelay, loadRelayKeyPair, relayKeysPath, parseRelayPort } from '../src/relay.mjs'
import { runOneShot } from './helpers/cli.mjs'

const silentLogger = { log() {} }

test('relay port rejects missing values, invalid ports and shell syntax', () => {
    assert.equal(parseRelayPort(undefined), null)
    assert.equal(parseRelayPort(null), null)
    assert.equal(parseRelayPort('49740'), 49740)
    assert.equal(parseRelayPort(65535), 65535)
    for (const value of [true, false, '', 0, -1, 65536, 1.5, '49740;id', '1e3']) {
        assert.throws(() => parseRelayPort(value), /relay port/)
    }
})

test('a relay can use a fixed UDP port for discovery as well as connection relaying', { timeout: 30_000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const reservation = createSocket('udp4')
    reservation.bind(0, '0.0.0.0')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const relay = await startRelay({ storageDir: tempStorage(t), port, bootstrap: testnet.bootstrap, logger: silentLogger, statsIntervalMs: 0 })
    t.after(() => relay.close())
    assert.equal(relay.stats().dht.localAddress.port, port)
    const probe = new DHT({ bootstrap: [{ host: '127.0.0.1', port }] })
    t.after(() => probe.destroy())
    await probe.fullyBootstrapped()
    assert.equal(probe.bootstrapped, true)
    assert.ok(await probe.ping({ host: '127.0.0.1', port }), 'relay answers DHT discovery traffic on its advertised port')
})

test('a busy fixed relay port fails instead of silently advertising another port', { timeout: 30_000 }, async (t) => {
    const testnet = await createTestnet(3)
    t.after(() => testnet.destroy())
    const reservation = createSocket('udp4')
    reservation.bind(0, '0.0.0.0')
    await once(reservation, 'listening')
    t.after(() => reservation.close())
    await assert.rejects(startRelay({
        storageDir: tempStorage(t),
        port: reservation.address().port,
        bootstrap: testnet.bootstrap,
        logger: silentLogger,
        statsIntervalMs: 0,
    }), /requested UDP port|EADDRINUSE/)
})

function tempStorage(t) {
    const dir = mkdtempSync(join(tmpdir(), 'listam-relay-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    return dir
}

test('the relay public key is stable across restarts and readable without serving', async (t) => {
    const testnet = await createTestnet(3)
    const dir = tempStorage(t)
    t.after(() => testnet.destroy())

    const first = await startRelay({ storageDir: dir, logger: silentLogger, bootstrap: testnet.bootstrap, statsIntervalMs: 0 })
    const publicKey = first.publicKeyZ32
    await first.close()

    // The key is baked into client builds; a restart that rotated it would
    // strand every client that already has the old one.
    const second = await startRelay({ storageDir: dir, logger: silentLogger, bootstrap: testnet.bootstrap, statsIntervalMs: 0 })
    assert.equal(second.publicKeyZ32, publicKey, 'restart reuses the persisted seed')
    await second.close()

    // Same key without touching the DHT at all: `relay --print-key` is how the
    // operator reads it off the box.
    const printed = await runOneShot(['relay', '--storage', dir, '--print-key'])
    assert.equal(printed.code, 0)
    assert.equal(printed.parsed?.publicKey, publicKey)

    // And the seed never leaves the storage dir as anything but the secret file.
    const keyPair = await loadRelayKeyPair({ storageDir: dir })
    assert.equal(b4a.toString(keyPair.publicKey, 'hex'), second.publicKeyHex)
    assert.match(relayKeysPath(dir), /headless-relay-keys\.json$/)
})

test('--print-key mints the key on a fresh storage dir without starting a service', async (t) => {
    const dir = tempStorage(t)
    const first = await runOneShot(['relay', '--storage', dir, '--print-key'])
    assert.equal(first.code, 0)
    assert.match(first.parsed?.publicKey ?? '', /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/, 'z32-encoded 32-byte key')

    const again = await runOneShot(['relay', '--storage', dir, '--print-key'])
    assert.equal(again.parsed?.publicKey, first.parsed.publicKey, 'minting is idempotent')
})

// The real thing: both peers hole-punch-disabled (the carrier-NAT case in
// miniature — on loopback hyperdht would otherwise always find a direct path),
// both pointed at the relay, and the payload has to arrive anyway.
test('two peers with relayThrough set connect through the relay', { timeout: 120_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = tempStorage(t)
    const relay = await startRelay({ storageDir: dir, logger: silentLogger, bootstrap: testnet.bootstrap, statsIntervalMs: 0 })
    const guest = new DHT({ bootstrap: testnet.bootstrap })
    const host = new DHT({ bootstrap: testnet.bootstrap })
    t.after(async () => {
        await guest.destroy()
        await host.destroy()
        await relay.close()
        await testnet.destroy()
    })

    const hostKeyPair = DHT.keyPair()
    const server = host.createServer(
        { relayThrough: relay.publicKey, holepunch: false, shareLocalAddress: false },
        (socket) => {
            socket.on('error', () => {})
            socket.on('data', (data) => socket.write(b4a.from(`echo:${b4a.toString(data)}`)))
        },
    )
    await server.listen(hostKeyPair)
    t.after(() => server.close())

    async function roundTrip(payload) {
        const socket = guest.connect(hostKeyPair.publicKey, { relayThrough: relay.publicKey, localConnection: false })
        socket.on('error', () => {})
        try {
            return await new Promise((resolve, reject) => {
                socket.once('data', (data) => resolve(b4a.toString(data)))
                socket.once('close', () => reject(new Error('socket closed before any reply')))
                socket.write(b4a.from(payload))
            })
        } finally {
            socket.destroy()
        }
    }

    assert.equal(await roundTrip('ping'), 'echo:ping')

    const stats = relay.stats()
    assert.equal(stats.pairings.matched, 1, 'the two peers were paired on the relay')
    assert.equal(stats.streams.opened, 2, 'one relayed raw stream per side')
    assert.equal(stats.sessions.accepted, 2)

    // Durability: the abrupt teardown above is the normal end of a mobile
    // session, and it must not take the relay (or its next pairing) down.
    assert.equal(await roundTrip('ping-again'), 'echo:ping-again')
    assert.equal(relay.stats().pairings.matched, 2)
})

test('the relay subcommand serves, announces its key, and stops on SIGTERM', { timeout: 120_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dir = tempStorage(t)
    t.after(() => testnet.destroy())

    const entry = fileURLToPath(new URL('../headless.mjs', import.meta.url))
    const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')
    const proc = spawn(process.execPath, [entry, 'relay', '--storage', dir, '--bootstrap', bootstrap], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })

    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    const ready = await new Promise((resolve, reject) => {
        readline.createInterface({ input: proc.stdout }).on('line', (line) => {
            try {
                const message = JSON.parse(line)
                if (message.event === 'relay-ready') resolve(message)
            } catch {}
        })
        proc.once('exit', (code) => reject(new Error(`relay exited before ready (${code})\n${stderr}`)))
    })
    assert.match(ready.publicKey, /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/)
    // The operator has to copy this key by hand, so it must be legible on the
    // console and not only inside a JSON line. stderr is a separate pipe, so it
    // can land a beat after the stdout event.
    const bannerDeadline = Date.now() + 10_000
    while (!stderr.includes(ready.publicKey) && Date.now() < bannerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(stderr.includes(ready.publicKey), `the startup banner carries the key (stderr: ${stderr})`)

    // The installer's readiness gate (and `headless.mjs status`) read this file.
    const status = await runOneShot(['status', '--storage', dir])
    assert.equal(status.code, 0)
    assert.equal(status.parsed?.status?.role, 'relay')
    assert.equal(status.parsed?.status?.publicKey, ready.publicKey)
    assert.equal(status.parsed?.status?.relay?.sessions?.accepted, 0)

    proc.kill('SIGTERM')
    const [code] = await once(proc, 'exit')
    assert.equal(code, 0, 'SIGTERM is a clean stop')
})
