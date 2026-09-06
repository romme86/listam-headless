#!/usr/bin/env node
// Opt-in private-testnet regression for HyperDHT relay socket cleanup.
// node scripts/relay-churn.mjs [cycles] (default: 2000)
// This exercises forced relaying, clean/abrupt disconnect and relay failure.
// A real TRY_LATER/randomized-NAT run remains part of the Linux NAT matrix.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { startRelay } from '../src/relay.mjs'

const cycles = Number(process.argv[2] ?? 2000)
if (!Number.isInteger(cycles) || cycles < 1) throw new Error('cycles must be a positive integer')
const storageDir = mkdtempSync(join(tmpdir(), 'listam-relay-churn-'))
const net = await createTestnet(3)
const guest = new DHT({ bootstrap: net.bootstrap })
const host = new DHT({ bootstrap: net.bootstrap })
let relay, server
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const openRelay = () => startRelay({ storageDir, bootstrap: net.bootstrap, logger: { log() {} }, statsIntervalMs: 0 })
const poolActive = (dht) => dht.stats.socketPool.socketsAdded - dht.stats.socketPool.socketsRemoved
const pools = () => ({ guest: poolActive(guest), host: poolActive(host), relay: relay.stats().dht.socketPool.active })
const key = DHT.keyPair()

async function echo(index, { keepOpen = false } = {}) {
    const socket = guest.connect(key.publicKey, { relayThrough: relay.publicKey, localConnection: false })
    socket.on('error', () => {})
    const closed = new Promise((resolve) => socket.once('close', resolve))
    let timer
    let retained = false
    try {
        const expected = Buffer.from(`listam-churn-${index}`)
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`relay echo ${index} timed out`)), 15_000)
            let received = Buffer.alloc(0)
            socket.on('data', (data) => {
                received = Buffer.concat([received, data])
                if (received.length < expected.length) return
                try { assert.deepEqual(received, expected); resolve() } catch (error) { reject(error) }
            })
            socket.once('close', () => reject(new Error('relay closed before echo')))
            socket.write(expected)
        })
        if (keepOpen) {
            retained = true
            return { socket, closed }
        }
        if (index % 2) socket.end()
        else socket.destroy()
        clearTimeout(timer)
        await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 1000) })])
    } finally {
        clearTimeout(timer)
        if (!retained) socket.destroy()
    }
}

try {
    relay = await openRelay()
    server = host.createServer({ relayThrough: relay.publicKey, holepunch: false, shareLocalAddress: false }, (socket) => {
        socket.on('error', () => {})
        socket.on('data', (data) => socket.write(data))
        socket.on('end', () => socket.end())
    })
    await server.listen(key)
    await echo(-1)
    await delay(4000) // HyperDHT's pool intentionally lingers sockets for 3s.
    const baseline = pools()
    for (let i = 0; i < cycles; i++) {
        await echo(i)
        if ((i + 1) % 200 === 0) console.log(JSON.stringify({ cycles: i + 1, pools: pools() }))
    }
    await delay(4000)
    const after = pools()
    assert.deepEqual(after, baseline, 'socket pools must return to their post-warmup baseline')
    assert.ok(relay.stats().pairings.matched >= cycles + 1, 'every cycle used the relay')
    console.log(JSON.stringify({ phase: 'churn', ok: true, cycles, baseline, after }))

    const live = await echo('relay-failure', { keepOpen: true })
    let failureTimer
    const failureStartedAt = Date.now()
    try {
        await relay.close()
        // HyperDHT sends a keepalive every 5s, then UDX must exhaust its
        // retransmissions. A 5s assertion would fail before loss detection.
        // Keep the production defaults and measure the actual close latency.
        await Promise.race([live.closed, new Promise((_, reject) => {
            failureTimer = setTimeout(() => reject(new Error('relay failure left client connected after 30s')), 30_000)
        })])
    } finally { clearTimeout(failureTimer); live.socket.destroy() }
    const failureCloseMs = Date.now() - failureStartedAt
    relay = await openRelay()
    await echo('after-restart')
    await delay(4000)
    assert.deepEqual(pools(), baseline)
    console.log(JSON.stringify({ phase: 'relay-failure-and-restart', ok: true, failureCloseMs, pools: pools() }))
} finally {
    if (server) await server.close()
    await guest.destroy()
    await host.destroy()
    if (relay) await relay.close()
    await net.destroy()
    rmSync(storageDir, { recursive: true, force: true })
}
