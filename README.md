# Listam Headless

The Listam personal server (Phase 13 of the multi-app plan): a long-lived
owned peer for always-on devices (Raspberry Pi, mini PC, NAS). It is not a
cloud service — it keeps the owner's lists available and durable.

Two roles, chosen at setup:

- **participant** — a trusted full member: runs the same `@listam/backend`
  as mobile and desktop (own `headless` storage root, storage lease,
  refuse-destructive recovery policy) with persistent identity via the
  shared file secret store.
- **blind-storage** — a ciphertext helper (finding C2): Corestore +
  Hyperswarm only, pinning cores by *public key*. It never receives — and
  has no code path that accepts — the list encryption key. It stores and
  serves encrypted blocks it cannot read. There is no "read-only" tier;
  that would require credentials the substrate does not have.

## Install

Requires Node.js 22 or newer. The always-on path targets Linux (Raspberry
Pi OS, Debian, Ubuntu — systemd user unit with a cron fallback).

**From npm (latest published version):**

```sh
npm install -g listam-headless
listam-headless install --storage ~/listam-data --invite <code>
```

`install` runs setup, writes a systemd user unit (enabling linger so it
survives reboots), starts the service, and — given `--invite` — joins your
list before returning. The invite code comes from the share flow in the
Listam mobile or desktop app. Afterwards:

```sh
listam-headless status --storage ~/listam-data   # live snapshot, exit 1 if stale
journalctl --user -u listam-headless -n 20       # service log
listam-headless uninstall --storage ~/listam-data
```

Use a global install (not `npx`) for `install`: the generated unit points
at the package on disk, and the npx cache is not a stable home for it.

**From the website tarball** ([listam.ch/downloads](https://listam.ch/downloads)):

```sh
tar xzf listam-headless-<version>.tgz && cd package
npm install --omit=dev
node headless.mjs install --storage ~/listam-data --invite <code>
```

**From source** (the checkout expects the shared packages next to it):

```sh
git clone https://github.com/romme86/listam-headless.git
git clone https://github.com/romme86/listam-packages.git
cd listam-headless && npm install
```

Maintainers: `npm run dist` builds `dist/listam-headless-<version>.tgz`
with the exact shared-package source included under `vendor/`. Extract the
archive before running `npm install` inside `package/`; an external
`npm install <archive>` does not resolve the archive's relative dependencies.
For npm publication, first publish the shared packages, then run
`npm run dist -- --registry` and publish from `dist/stage/`.

## Usage

```sh
node headless.mjs setup  --storage ~/listam --role participant
node headless.mjs setup  --storage ~/listam-helper --role blind-storage \
                         --base-key <64-hex core key>
node headless.mjs run    --storage ~/listam [--bootstrap host:port,...]
node headless.mjs status --storage ~/listam     # reads the live snapshot
```

`run` accepts the plan's scriptable primitives as JSON lines on stdin and
answers one JSON line per request:

```
{"id":1,"op":"status"}
{"id":2,"op":"invite"}                         # alias: print-invite
{"id":3,"op":"join","invite":"<z32>"}
{"id":4,"op":"add","text":"Milk"}              # alias: add-item
{"id":5,"op":"edit","itemId":"…","text":"…"}   # alias: edit-item
{"id":6,"op":"done","itemId":"…"}              # alias: mark-done
{"id":7,"op":"delete","itemId":"…"}            # alias: delete-item
{"id":8,"op":"dump"}                           # alias: dump-list
{"id":9,"op":"export","path":"backup.json"}
{"id":10,"op":"import","path":"backup.json"}   # upserts by stable id
{"id":11,"op":"provision-leaf","ssid":"<wifi>","psk":"<pw>"}  # pair an ESP32 leaf over BLE
{"id":12,"op":"shutdown"}
```

Blind mode adds `pin {key}` and `peek {index}` (diagnostics: returns the
locally stored block — ciphertext by construction). The request `id` is the
correlation id; item references always use `itemId`.

`provision-leaf` initializes a nearby ESP32 leaf over Bluetooth: it writes the
operator-supplied WiFi credentials plus this hub's control key and
auto-detected LAN address into the leaf, which then dials back over WiFi and
mirrors this project. It requires the leaf bridge to be running
(`LISTAM_LEAF_BRIDGE_PORT=9993`) and the **optional** `@abandonware/noble`
dependency on a host with a BLE radio (Linux: BlueZ; macOS: CoreBluetooth). On
a Bluetooth-less host it returns `{ ok: false, reason: "ble-unavailable" }`
rather than failing, and `npx listam-headless` installs fine without it. It is
an operator-only op — never exposed over the remote owner-control channel.

The signed owner-control channel supports explicitly granted capabilities.
Pairing offers and revocation stay on the local operator surface. The service
exits on stdin EOF; the installed service keeps a private control FIFO open.

## Durable encrypted mirroring

A bootstrap pin alone is insufficient for offline multiwriter recovery.
On the blind helper, mint a short-lived control offer through stdin or its FIFO:

```json
{"id":1,"op":"control-pair","capabilities":["topics:configure","status:read"]}
```

On a participant that has the intended list open, redeem the returned code,
then use the helper's `controlPublicKey` from `control-info`:

```json
{"id":2,"op":"control-connect","code":"<pairing-code>","name":"List mirror"}
{"id":3,"op":"control-command","serverPublicKeyHex":"<helper-public-key>","command":"topics","payload":{"action":"mirror","baseKey":"<list-bootstrap-key>"}}
```

The participant persists a subscription and publishes versioned public-key
manifests as writers and materialized views change. It retries every 15 seconds
while active, resumes after restart, and pauses with the network lifecycle.
The helper persists manifests before acknowledging them and restores downloads
after restart. Only core public keys and ciphertext reach the helper; the
list encryption key stays with participants. Manual `pin` operations persist too.

Use the same command with `action: "stop-mirror"` to withdraw that subscription.
This stops automatic replication for keys no other manifest or manual pin needs;
it does not erase existing ciphertext. Revocation prevents further control
commands, so stop mirroring before revoking the controller when desired.
Manifest revisions reject stale/conflicting updates; helper storage is bounded
by its quota and a maximum of 4,096 registered cores.

Storage quotas: `--max-storage-bytes` (default 1 GiB) is checked
periodically; a blind helper over quota leaves its swarm topics (stops
taking on more data) and never deletes anything automatically.

## Blind relay

Two peers that are both behind carrier-grade NAT cannot hole punch: hyperdht
gives up on a double-random NAT pair without even trying, which is why three
phones on 4G could not pair with each other. A box with a reachable address can
relay the connection for them.

```sh
node headless.mjs relay --storage ~/listam-relay --print-key   # mint/print the key, then exit
node headless.mjs relay --storage ~/listam-relay               # serve
node headless.mjs install --storage ~/listam-relay --role relay # always-on (Linux)
```

The relay is a peer of nothing: no config, no base, no list keys. It pairs two
peers on a token they exchanged through the DHT and pumps bytes between them —
it terminates no encryption and can read nothing it carries. Clients reach it by
its **public key**, which the operator copies out of `--print-key` (or
`headless.mjs status`) and into the client's `relayThrough` setting; the key is
derived from a persisted seed, so it survives restarts and reinstalls of the
service. It stops on SIGTERM (no stdin op surface), logs relay stats every five
minutes (`--stats-interval <seconds>`), and installs as its own systemd unit
(`listam-headless-relay`) so one box can run both a peer and a relay.

For a fixed UDP port, use `relay --port 49740` or
`install --role relay --port 49740` with the same storage argument. The relay
refuses to start if it cannot bind that port. Choose a port unused by the
participant service, and forward the same UDP port through each upstream router.
Status includes the listening/public addresses and DHT reachability.

Discovery and connection relaying are separate: clients use the public HyperDHT
network to find peers, and `relayThrough` forwards encrypted connection traffic
when needed. The relay joins that same DHT and can help discovery once it becomes
a reachable persistent node. A public bootstrap address additionally needs a
stable public IP or DNS name and an externally reachable UDP port; a Tailscale
address only works for clients on that tailnet. Verify external reachability
before adding a node to client bootstrap or relay defaults.

Check an actual encrypted round trip with direct hole punching disabled:

```sh
node headless.mjs relay-check --storage ~/listam-relay
# Optional: --key <relay-public-key> --timeout 45000
```

The check uses synthetic data and writes `relay-health.json`, separate from the
relay's service snapshot. Exit code 1 means a check failed. Run from another
machine to verify reachability. The tools deployment script installs a ten-minute
health timer, separate code roots for relays and participants, and persistent
service restarts. A failed network probe does not automatically restart a relay.

## Test

```sh
npm install
npm run ci    # lint + unit tests + acceptance tests on a private
              # hyperdht testnet (C2 blind-storage boundary, restart
              # identity/storage/status persistence, lease refusal,
              # export/import id round-trip)
```

The [0.15.0 release validation record](https://github.com/romme86/listam-tools/blob/main/reviews/2026-09-13-p2p-release.md)
also covers public-network Mac/Geekom/Pi synchronization and authenticated
Mac-to-Geekom mirror publication, helper restart and withdrawal. It records
the remaining Geekom single-host private-DHT timeouts separately from those
cross-device results; the Linux private-network suite was not fully green.
