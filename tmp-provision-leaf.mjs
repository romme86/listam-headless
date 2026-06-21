// One-off: provision the nearby leaf over BLE from this terminal (noble),
// using the SAME @listam/provisioning codec the desktop/mobile apps use.
// Run in a terminal that has macOS Bluetooth permission.
//
//   WIFI_SSID="MyWiFi" WIFI_PSK="pass" CONTROL_KEY="<64-hex from the desktop>" \
//     node tmp-provision-leaf.mjs
//
// HUB_ADDR is auto-detected (this Mac's LAN IPs : 9993) unless you pass it.
import os from 'node:os'
import { buildProvisioningPayload, provisionLeaf } from '@listam/provisioning'
import { openLeafTransport } from '@listam/provisioning/transport/noble'

const ssid = process.env.WIFI_SSID
const psk = process.env.WIFI_PSK ?? ''
const controlKey = process.env.CONTROL_KEY
let hubAddr = process.env.HUB_ADDR

if (!ssid || !controlKey) {
    console.error('Need WIFI_SSID and CONTROL_KEY (64 hex chars, copy it from the desktop app).')
    process.exit(1)
}
if (!hubAddr) {
    const ips = []
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
            if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) ips.push(`${ni.address}:9993`)
        }
    }
    hubAddr = ips.join(',')
}

const payload = buildProvisioningPayload({ controlKey, hubAddr, wifi: [{ ssid, psk }] })
console.log('hub_addr  :', hubAddr)
console.log('wifi      :', ssid)
console.log('scanning for the leaf over BLE (it should show a blue LED)…')

const transport = await openLeafTransport({ timeoutMs: 20000 })
console.log('connected :', transport.name, `(${transport.id})`)
await provisionLeaf({
    transport,
    payload,
    mtu: transport.mtu,
    onStatus: (code, name) => console.log('leaf status:', name),
})
console.log('✅ provisioned — the leaf will reboot, join WiFi, and dial', hubAddr)
await transport.close()
process.exit(0)
