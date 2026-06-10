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
} from '@listam/protocol'
import { writeStatus } from './status.mjs'
import { createQuotaMonitor } from './quota.mjs'

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
            if (payload?.type === 'membership-roster') state.roster = payload.roster ?? null
        }
    })

    const platform = createNodePlatform({
        argv: [storageDir, '', '', JSON.stringify(prepared.backendPayload)],
        storageNamespace: 'headless',
        bootstrap: config.bootstrap ?? null,
    })
    platform.createRpc = channel.platform.createRpc

    const backend = await startBackend(platform)
    state.baseKeyFingerprint = await currentBaseFingerprint(secretStore)

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
            quota: { ...quota.check() },
            startedAt: state.startedAt,
        }
    }

    const statusTimer = setInterval(() => writeStatus(fs, storageDir, snapshot(), now()), 5_000)
    statusTimer?.unref?.()
    writeStatus(fs, storageDir, snapshot(), now())

    async function handleOp(request) {
        const op = OP_ALIASES[request.op] ?? request.op
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
            case 'add':
                await channel.client.send(RPC_ADD, { text: request.text })
                return {}
            case 'edit': {
                const item = state.items.find((entry) => entry.id === request.itemId)
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                await channel.client.send(RPC_UPDATE, { item: { ...item, text: request.text, updatedAt: now() } })
                return {}
            }
            case 'done': {
                const item = state.items.find((entry) => entry.id === request.itemId)
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                const isDone = request.isDone !== false
                await channel.client.send(RPC_UPDATE, {
                    item: { ...item, isDone, timeOfCompletion: isDone ? now() : 0, updatedAt: now() },
                })
                return {}
            }
            case 'delete': {
                const item = state.items.find((entry) => entry.id === request.itemId) ?? request.item
                if (!item) return { ok: false, message: `no item with id ${request.itemId}` }
                await channel.client.send(RPC_DELETE, { item })
                return {}
            }
            case 'sync':
                await channel.client.send(RPC_REQUEST_SYNC)
                return {}
            case 'members':
                await channel.client.send(RPC_GET_MEMBERS)
                return { roster: state.roster }
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
                for (const item of data.items) {
                    await channel.client.send(RPC_UPDATE, { item })
                }
                return { imported: data.items.length }
            }
            case 'shutdown':
                return { shutdown: true }
            default:
                return { ok: false, message: `unknown op ${request.op}` }
        }
    }

    async function shutdown() {
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
