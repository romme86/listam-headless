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
{"id":11,"op":"shutdown"}
```

Blind mode adds `pin {key}` and `peek {index}` (diagnostics: returns the
locally stored block — ciphertext by construction). The request `id` is the
correlation id; item references always use `itemId`.

The remote owner-control channel (configure/inspect from mobile/desktop
without a shell) is Phase 14; until then stdin under the operator's
shell/SSH is the only control surface, and nothing is exposed on the network
beyond replication. The service exits on stdin EOF.

Storage quotas: `--max-storage-bytes` (default 1 GiB) is checked
periodically; a blind helper over quota leaves its swarm topics (stops
taking on more data) and never deletes anything automatically.

## Test

```sh
npm install
npm run ci    # lint + unit tests + acceptance tests on a private
              # hyperdht testnet (C2 blind-storage boundary, restart
              # identity/storage/status persistence, lease refusal,
              # export/import id round-trip)
```
