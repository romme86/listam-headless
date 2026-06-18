// `provision-leaf` operator op: initialize a listam leaf (ESP32-S3) over
// Bluetooth from this always-on hub. The hub already holds everything the leaf
// needs except the WiFi credentials — the control core key and the address(es)
// the leaf should dial back to — so the operator only supplies the WiFi network.
//
// BLE is optional: @abandonware/noble is a native addon and the BLE radio may
// be absent (most cloud VMs). The transport is therefore lazy-imported and
// dependency-injected (mirroring leaf-bridge.mjs's injected `tcp`), so this
// module imports nothing native at load time, is unit-testable with a fake
// transport, and degrades to { ok: false, reason: 'ble-unavailable' } rather
// than crashing.

import { buildProvisioningPayload, validateProvisioningPayload, provisionLeaf } from '@listam/provisioning'
import { secretFingerprint } from '@listam/secrets'

// Every non-internal IPv4 address of this host, as `ip:port` — the leaf retries
// each forever, so listing all candidates is harmless and covers multi-homed
// hosts (wired + WiFi + hotspot). Callers can override with request.hubAddr.
// Exported so the service can advertise it in its status snapshot (apps that
// provision over their own radio, e.g. mobile, read it from there).
export function detectHubAddr(os, port) {
    const out = []
    for (const list of Object.values(os.networkInterfaces() ?? {})) {
        for (const ni of list ?? []) {
            const family = ni.family === 4 || ni.family === 'IPv4'
            if (family && !ni.internal) out.push(`${ni.address}:${port}`)
        }
    }
    return out.join(',')
}

function normalizeWifi(request) {
    if (Array.isArray(request.wifi) && request.wifi.length) {
        return request.wifi.filter((n) => n && typeof n.ssid === 'string' && n.ssid !== '')
    }
    if (request.ssid) return [{ ssid: request.ssid, psk: request.psk ?? '' }]
    return []
}

async function defaultOpenTransport(opts) {
    let mod
    try {
        mod = await import('@listam/provisioning/transport/noble')
    } catch (err) {
        const e = new Error('Bluetooth transport is unavailable')
        e.code = 'ble-unavailable'
        e.cause = err
        throw e
    }
    return mod.openLeafTransport(opts)
}

// request: { ssid, psk } or { wifi: [{ssid,psk}, ...] }, optional hubAddr,
//          audioAddr, wakeDbThreshold, ledGpio, scanTimeoutMs.
// deps:    { leafBridge, logger, os, openTransport } — os/openTransport injected in tests.
export async function runProvisionLeaf(request = {}, { leafBridge, logger = console, os, openTransport = defaultOpenTransport } = {}) {
    if (!leafBridge) {
        return { ok: false, reason: 'no-leaf-bridge', message: 'leaf bridge is not running; start with LISTAM_LEAF_BRIDGE_PORT set' }
    }

    const wifi = normalizeWifi(request)
    if (wifi.length === 0) {
        return { ok: false, message: 'provide a wifi network: { ssid, psk } or { wifi: [{ ssid, psk }] }' }
    }

    const osMod = os ?? (await import('node:os')).default
    const hubAddr = (typeof request.hubAddr === 'string' && request.hubAddr.trim()) || detectHubAddr(osMod, leafBridge.port)
    if (!hubAddr) {
        return { ok: false, message: 'could not auto-detect hub_addr (no external IPv4 found); pass hubAddr explicitly' }
    }

    const payload = buildProvisioningPayload({
        controlKey: leafBridge.controlKey,
        hubAddr,
        wifi,
        audioAddr: request.audioAddr,
        wakeDbThreshold: request.wakeDbThreshold,
        ledGpio: request.ledGpio,
    })
    try {
        validateProvisioningPayload(payload)
    } catch (err) {
        return { ok: false, reason: 'invalid-payload', message: err?.message ?? String(err) }
    }

    let transport
    try {
        transport = await openTransport({ timeoutMs: request.scanTimeoutMs ?? 20000, logger })
    } catch (err) {
        if (err?.code === 'ble-unavailable') {
            return {
                ok: false,
                reason: 'ble-unavailable',
                hint: 'install the optional @abandonware/noble dependency and run on a host with a BLE radio (Linux: BlueZ + libbluetooth-dev; macOS: CoreBluetooth)',
            }
        }
        return { ok: false, reason: 'scan-failed', message: err?.message ?? String(err) }
    }

    try {
        await provisionLeaf({
            transport,
            payload,
            mtu: transport.mtu,
            onStatus: (code, name) => logger?.log?.(`[provision] leaf status: ${name} (${code})`),
        })
        return {
            ok: true,
            leafId: transport.id,
            leafName: transport.name,
            hubAddr,
            controlKeyFingerprint: secretFingerprint(leafBridge.controlKey),
        }
    } catch (err) {
        return { ok: false, reason: 'provision-failed', message: err?.message ?? String(err) }
    } finally {
        try {
            await transport.close?.()
        } catch {
            /* link may already be gone after the leaf reboots on success */
        }
    }
}
