// Full-participant headless service: a long-lived owned peer running the same
// @listam/backend as mobile and desktop (node platform, 'headless' storage
// namespace and lease, refuse-destructive recovery policy), exposing the
// plan's scriptable primitives over stdin/stdout JSON lines:
//
//   status | invite (print-invite) | join | add (add-item) | edit (edit-item)
//   | done (mark-done) | delete (delete-item) | dump (dump-list) | export
//   | import | shutdown
//
// Identity (writer/base keys) persists across restarts through the shared
// file secret store, so this device remains the same peer for its whole life.
import { startBackend, createNodePlatform } from '@listam/backend'
import { createBackendChannel } from '@listam/client'
import {
    createFileSecretStore,
    prepareBackendSecrets,
    persistBackendSecretRequest,
    secretFingerprint,
} from '@listam/secrets'
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_REQUEST_SYNC,
    RPC_GET_MEMBERS,
    RPC_REMOVE_MEMBER,
} from '@listam/protocol'
import { buildPeerLabelItem, isLabelItem } from '@listam/domain/labels'
import { writeStatus } from './status.mjs'
import { createQuotaMonitor } from './quota.mjs'
import { normalizeVoiceConfig } from './config.mjs'

export const EXPORT_VERSION = 1

const OP_ALIASES = {
    'print-invite': 'invite',
    'create-base': 'status',
    'dump-list': 'dump',
    'add-item': 'add',
    'edit-item': 'edit',
    'mark-done': 'done',
    'delete-item': 'delete',
}

export async function startHeadlessService({ fs, storageDir, config, logger, now = Date.now }) {
    const state = {
        items: [],
        inviteKey: '',
        peerCount: 0,
        joined: false,
        roster: null,
        baseKeyFingerprint: null,
        quota: null,
        startedAt: now(),
    }

    const secretStore = createFileSecretStore({ fs, path: `${storageDir}/headless-secrets.json` })
    const prepared = await prepareBackendSecrets({ secureStore: secretStore })

    const channel = createBackendChannel()
    channel.client.onEvent((event) => {
        if (event.type === 'persist-secret') {
            persistBackendSecretRequest(event.payload, { secureStore: secretStore })
                .then((result) => event.reply(JSON.stringify({ stored: result.mode === 'secure-store', mode: result.mode })))
                .catch(() => event.reply(JSON.stringify({ stored: false })))
            return
        }
        if (event.type === 'sync-list') state.items = Array.isArray(event.items) ? event.items : []
        if (event.type === 'add-from-backend') state.items = [event.item, ...state.items.filter((i) => i.id !== event.item.id)]
        if (event.type === 'update-from-backend') {
            state.items = state.items.some((i) => i.id === event.item.id)
                ? state.items.map((i) => (i.id === event.item.id ? event.item : i))
                : [event.item, ...state.items]
        }
        if (event.type === 'delete-from-backend') state.items = state.items.filter((i) => i.id !== event.item.id)
        if (event.type === 'invite-key') state.inviteKey = event.key ?? ''
        if (event.type === 'message') {
            const payload = event.payload
            if (payload?.type === 'peer-count') state.peerCount = payload.count ?? 0
            if (payload?.type === 'join-success') state.joined = true
            // Boot-time truth for restarted guests (no live join-success).
            if (payload?.type === 'base-state') state.joined = payload.joined === true
            if (payload?.type === 'membership-roster') {
                state.roster = payload.roster ?? null
                // The roster is where this node first learns its own writer key
                // (the isSelf writer), so advertise the configured name now.
                maybeAdvertiseName()
            }
        }
    })

    // This node's human-readable name, advertised to peers via a synced peer-label
    // item (see @listam/domain/labels). LISTAM_INSTANCE_NAME overrides config.name.
    const instanceName = (process.env.LISTAM_INSTANCE_NAME || config.name || '').trim().slice(0, 64)
    let advertisedName = ''
    function maybeAdvertiseName() {
        if (!instanceName) return
        const selfKey = state.roster?.writers?.find((w) => w.isSelf)?.writerKey
        if (!selfKey) return
        const signature = `${selfKey} ${instanceName}`
        if (advertisedName === signature) return
        advertisedName = signature
        const synced = state.items.find((i) => isLabelItem(i) && i.id === selfKey && i.labelName === instanceName)
        if (synced) return
        const item = buildPeerLabelItem({ writerKey: selfKey, name: instanceName, updatedAt: now() })
        channel.client.send(RPC_UPDATE, { item }).catch(() => {})
    }

    const platform = createNodePlatform({
        argv: [storageDir, '', '', JSON.stringify(prepared.backendPayload)],
        storageNamespace: 'headless',
        bootstrap: config.bootstrap ?? null,
    })
    platform.createRpc = channel.platform.createRpc

    const backend = await startBackend(platform)
    state.baseKeyFingerprint = await currentBaseFingerprint(secretStore)

    // Optional TCP bridge for leaf peers (hardware/leaf-peer): replicate the
    // corestore to dumb always-on mirrors (e.g. the ESP32-S3 leaf).
    let leafBridge = null
    // The LAN address(es) a leaf should dial back to. Surfaced in the status
    // snapshot so apps that provision a leaf over their own BLE radio (e.g.
    // mobile) can read the control key + this address from a paired hub.
    let leafHubAddr = null
    const leafBridgePort = Number(process.env.LISTAM_LEAF_BRIDGE_PORT ?? config.leafBridgePort ?? 0)
    if (leafBridgePort > 0) {
        const { startLeafBridge } = await import('@listam/backend/lib/leaf-bridge.mjs')
        try {
            leafBridge = await startLeafBridge({ port: leafBridgePort, logger })
            const os = await import('node:os')
            const { detectHubAddr } = await import('./provision-ble.mjs')
            leafHubAddr = detectHubAddr(os.default ?? os, leafBridgePort)
        } catch (err) {
            logger?.log?.('[ERROR] leaf-bridge failed to start:', err?.message ?? err)
        }
    }

    // Optional voice assistant: a side-band TCP socket receives PCM audio from a
    // leaf, whisper.cpp transcribes it, and the parsed command runs through the
    // same backend RPCs the stdin ops use. Off unless config.voice.enabled (or
    // LISTAM_VOICE_ENABLED=1) with a whisper model configured. NB: headless tracks
    // one list, so named-list resolution / cross-list remove are limited to the
    // tracked list; default-list add and the notes destination work fully.
    let voiceBridge = null
    const voiceCfg = normalizeVoiceConfig(config.voice, process.env)
    if (voiceCfg.enabled) {
        try {
            const net = await import('node:net')
            const { createStt } = await import('@listam/backend/lib/stt/index.mjs')
            const { startAudioBridge } = await import('@listam/backend/lib/audio-bridge.mjs')
            const { createVoiceController } = await import('@listam/backend/lib/voice-controller.mjs')
            const { createVoiceFeedbackHandler } = await import('@listam/backend/lib/voice-feedback.mjs')
            const { parseIntent, detectWake } = await import('@listam/domain/voice-intent')
            const { isRegistryItem } = await import('@listam/domain/list-registry')

            const stt = createStt({ engine: voiceCfg.engine, config: voiceCfg, logger })
            const controller = createVoiceController({
                addItem: async (text, listId, listType) => parseMutationReply(await channel.client.send(RPC_ADD, { text, listId, listType })).ok,
                deleteItem: async (item) => parseMutationReply(await channel.client.send(RPC_DELETE, { item })).ok,
                // Exclude label meta-items (peer/surface names) so a voice
                // "remove …" can never substring-match and delete one.
                getAllItems: async () => state.items.filter((i) => !isLabelItem(i)),
                getRegistryItems: async () => state.items.filter(isRegistryItem),
                notesListId: voiceCfg.notesListId,
                logger,
            })

            // The leaf LED stays dark on the dB gate; it lights only from the
            // feedback streamed back at each recognition milestone (yellow wake →
            // purple command → green saved / red error). See voice-feedback.mjs.
            const feedbackHandler = createVoiceFeedbackHandler({
                stt, controller, parseIntent, detectWake, locale: voiceCfg.locale,
                execFloors: voiceCfg.execConfidence, logger,
            })

            // Persist every received utterance into a training dataset (positives
            // that fired the on-device "yo" wake + hard-negatives that only tripped
            // the dB gate) so the real-life corpus accumulates on this always-on
            // audio sink for future wake-model retraining. Off with
            // LISTAM_VOICE_DATASET=0; dir via LISTAM_VOICE_DATASET_DIR.
            let onUtterance = feedbackHandler
            if (process.env.LISTAM_VOICE_DATASET !== '0') {
                try {
                    const { createUtteranceDataset } = await import('@listam/backend/lib/voice-dataset.mjs')
                    const fsp = await import('node:fs/promises')
                    const datasetDir = process.env.LISTAM_VOICE_DATASET_DIR || voiceCfg.datasetDir || `${storageDir}/voice-dataset`
                    const dataset = createUtteranceDataset({ dir: datasetDir, fs: fsp.default ?? fsp, logger })
                    onUtterance = (utterance, reply) => {
                        dataset.save(utterance) // fire-and-forget; never blocks the live pipeline
                        return feedbackHandler(utterance, reply)
                    }
                    logger?.log?.(`[voice] dataset capture on → ${datasetDir}`)
                } catch (err) {
                    logger?.log?.('[voice] dataset capture disabled:', err?.message ?? err)
                }
            }

            voiceBridge = await startAudioBridge({
                tcp: net.default ?? net,
                port: voiceCfg.audioPort,
                onUtterance,
                logger,
            })
            logger?.log?.(`[voice] audio bridge listening on :${voiceBridge.port}`)
        } catch (err) {
            logger?.log?.('[ERROR] voice bridge failed to start:', err?.message ?? err)
        }
    }

    const quota = createQuotaMonitor({
        fs,
        path: storageDir,
        maxBytes: config.maxStorageBytes,
        onExceeded: ({ usedBytes, maxBytes }) => {
            logger?.log?.('[AUDIT] Storage quota exceeded; this helper should be pruned or resized', { usedBytes, maxBytes })
        },
    })
    state.quota = quota.start()

    function snapshot() {
        return {
            role: 'participant',
            mode: prepared.mode,
            baseId: state.baseKeyFingerprint,
            joined: state.joined,
            peerCount: state.peerCount,
            itemCount: state.items.length,
            inviteActive: state.inviteKey.length > 0,
            leafBridge: leafBridge
                ? {
                      port: leafBridge.port,
                      controlKey: leafBridge.controlKey,
                      hubAddr: leafHubAddr,
                      // The audio sink the leaf streams voice to (same host IPs,
                      // the voice bridge's port) — only when voice is enabled.
                      audioAddr:
                          voiceBridge && leafHubAddr
                              ? leafHubAddr.replace(/:\d+/g, `:${voiceBridge.port}`)
                              : null,
                  }
                : null,
            quota: { ...quota.check() },
            startedAt: state.startedAt,
        }
    }

    const statusTimer = setInterval(() => writeStatus(fs, storageDir, snapshot(), now()), 5_000)
    statusTimer?.unref?.()
    writeStatus(fs, storageDir, snapshot(), now())

    // Backend mutation handlers reply with a JSON outcome; treat anything
    // unparseable (or an older backend that does not reply) as success so the
    // gate only ever turns silent failures into reported ones.
    function parseMutationReply(raw) {
        if (raw == null) return { ok: true }
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
            return { ok: parsed?.ok !== false, reason: parsed?.reason ?? null }
        } catch {
            return { ok: true }
        }
    }

    function mutationRefused(reply) {
        return {
            ok: false,
            message: `mutation refused (${reply.reason ?? 'unknown'}): base is not writable or sync is stalled (no reachable peer)`,
            joined: state.joined,
            peerCount: state.peerCount,
        }
    }

    // The stdin protocol owes exactly one answer per request. If a backend
    // path wedges anyway (e.g. an append that cannot complete while
    // disconnected), answer with a timeout failure instead of going silent;
    // join gets a longer budget because blind pairing legitimately waits up
    // to two minutes for the host.
    const OP_TIMEOUT_MS = 20_000
    const JOIN_OP_TIMEOUT_MS = 180_000

    async function handleOp(request) {
        const op = OP_ALIASES[request.op] ?? request.op
        // join waits on P2P sync; provision-leaf waits on a BLE scan + write —
        // both legitimately exceed the default op timeout.
        const timeoutMs = op === 'join' || op === 'provision-leaf' ? JOIN_OP_TIMEOUT_MS : OP_TIMEOUT_MS
        let timer = null
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => {
                logger?.log?.(`[ERROR] Op ${op} timed out after ${timeoutMs}ms; answering with failure`)
                resolve({ ok: false, message: `op ${op} timed out after ${timeoutMs}ms (sync stalled or peers unreachable?)` })
            }, timeoutMs)
            timer.unref?.()
        })
        try {
            return await Promise.race([dispatchOp(op, request), timedOut])
        } finally {
            clearTimeout(timer)
        }
    }

    async function dispatchOp(op, request) {
        switch (op) {
            case 'status':
                return snapshot()
            case 'invite': {
                await channel.client.send(RPC_CREATE_INVITE)
                return { inviteKey: state.inviteKey }
            }
            case 'join':
                await channel.client.send(RPC_JOIN_KEY, { key: request.invite })
                state.baseKeyFingerprint = await currentBaseFingerprint(secretStore)
                return {}
            case 'add': {
                const reply = parseMutationReply(await channel.client.send(RPC_ADD, { text: request.text }))
                if (!reply.ok) return mutationRefused(reply)
                return {}
            }
            case 'edit': {
                const item = state.items.find((entry) => entry.id === request.itemId)
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                const reply = parseMutationReply(await channel.client.send(RPC_UPDATE, { item: { ...item, text: request.text, updatedAt: now() } }))
                if (!reply.ok) return mutationRefused(reply)
                return {}
            }
            case 'done': {
                const item = state.items.find((entry) => entry.id === request.itemId)
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                const isDone = request.isDone !== false
                const reply = parseMutationReply(await channel.client.send(RPC_UPDATE, {
                    item: { ...item, isDone, timeOfCompletion: isDone ? now() : 0, updatedAt: now() },
                }))
                if (!reply.ok) return mutationRefused(reply)
                return {}
            }
            case 'delete': {
                const item = state.items.find((entry) => entry.id === request.itemId) ?? request.item
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                const reply = parseMutationReply(await channel.client.send(RPC_DELETE, { item }))
                if (!reply.ok) return mutationRefused(reply)
                return {}
            }
            case 'sync':
                await channel.client.send(RPC_REQUEST_SYNC)
                return {}
            case 'members':
                await channel.client.send(RPC_GET_MEMBERS)
                return { roster: state.roster }
            case 'remove-member':
                // Owner-only at the backend layer: triggers the C1 re-key flow
                // (epoch rotation), so the removed device cannot follow new
                // content even if consensus-layer removal lags.
                await channel.client.send(RPC_REMOVE_MEMBER, { writerKey: request.writerKey })
                return {}
            case 'dump':
                return { items: state.items, peerCount: state.peerCount, joined: state.joined, inviteKey: state.inviteKey, roster: state.roster }
            case 'export': {
                const data = {
                    version: EXPORT_VERSION,
                    exportedAt: now(),
                    baseId: state.baseKeyFingerprint,
                    items: state.items,
                }
                if (request.path) fs.writeFileSync(request.path, JSON.stringify(data, null, 2), { mode: 0o600 })
                return { export: data }
            }
            case 'import': {
                const raw = request.path ? fs.readFileSync(request.path, 'utf8') : JSON.stringify(request.data)
                const data = JSON.parse(raw)
                if (Number(data?.version) !== EXPORT_VERSION || !Array.isArray(data.items)) {
                    return { ok: false, message: 'unsupported export payload' }
                }
                // Updates upsert by stable id in the shared reduction, so an
                // import preserves item ids, done state, and edits.
                let imported = 0
                for (const item of data.items) {
                    const reply = parseMutationReply(await channel.client.send(RPC_UPDATE, { item }))
                    if (!reply.ok) {
                        return { ...mutationRefused(reply), message: `import stalled after ${imported} of ${data.items.length} items`, imported }
                    }
                    imported++
                }
                return { imported }
            }
            case 'provision-leaf': {
                // Initialize an ESP32 leaf over BLE with this hub's control key +
                // address and the operator-supplied WiFi creds. Local-radio only:
                // deliberately absent from the owner-control remote executor.
                const { runProvisionLeaf } = await import('./provision-ble.mjs')
                return runProvisionLeaf(request, { leafBridge, logger })
            }
            case 'shutdown':
                return { shutdown: true }
            default:
                return { ok: false, message: `unknown op ${request.op}` }
        }
    }

    async function shutdown() {
        if (voiceBridge) await voiceBridge.close().catch(() => {})
        if (leafBridge) await leafBridge.close().catch(() => {})
        clearInterval(statusTimer)
        quota.stop()
        writeStatus(fs, storageDir, { ...snapshot(), stopped: true }, now())
        await backend.shutdown()
    }

    return { handleOp, shutdown, snapshot, client: channel.client }
}

async function currentBaseFingerprint(secretStore) {
    try {
        const stored = await secretStore.getItem('listam.secret.v1.autobaseKey')
        return stored ? secretFingerprint(stored) : null
    } catch {
        return null
    }
}
