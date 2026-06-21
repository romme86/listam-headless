// Headless instance configuration: which role this device performs, where it
// stores data, how it bootstraps, and its storage quota. Written by `setup`,
// read by `run`/`status`. The fs module is injected for testability.
import { DEFAULT_EXEC_FLOORS } from '@listam/backend/lib/voice-feedback.mjs'

export const ROLES = Object.freeze(['participant', 'blind-storage'])
export const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024 // 1 GiB
export const DEFAULT_VOICE_PORT = 9994

// Voice assistant config (off by default). Reads an optional `voice` block from
// headless-config.json with env overrides, so a leaf can stream audio here for
// transcription + command execution. modelPath must point at a whisper.cpp GGML
// model for STT to be available.
export function normalizeVoiceConfig(raw = {}, env = {}) {
    const r = raw && typeof raw === 'object' ? raw : {}
    const port = Number(env.LISTAM_VOICE_PORT ?? r.audioPort ?? DEFAULT_VOICE_PORT)
    // STT decoder hints passed through to the whisper.cpp adapter as extraArgs.
    // An initial prompt biases whisper toward the command vocabulary — short
    // list-commands transcribe poorly without context (e.g. "add milk" merges
    // to "Admilk"); seeding the expected words fixes most of it. config.extraArgs
    // is appended verbatim for any other whisper-cli flag.
    const prompt = env.LISTAM_VOICE_PROMPT ?? r.prompt ?? null
    const extraArgs = []
    if (prompt) extraArgs.push('--prompt', String(prompt))
    if (Array.isArray(r.extraArgs)) extraArgs.push(...r.extraArgs.map(String))
    return {
        enabled: env.LISTAM_VOICE_ENABLED === '1' || r.enabled === true,
        engine: r.engine || 'whisper-cpp',
        binPath: env.LISTAM_VOICE_BIN || r.binPath || 'whisper-cli',
        modelPath: env.LISTAM_VOICE_MODEL || r.modelPath || null,
        audioPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_VOICE_PORT,
        locale: env.LISTAM_VOICE_LOCALE || r.locale || 'auto',
        notesListId: r.notesListId || 'voicenotes',
        execConfidence: normalizeExecFloors(r.execConfidence, env),
        extraArgs,
    }
}

// Per-intent write-gate confidence floors (see voice-feedback.shouldExecuteIntent).
// Until a real wake-word model lands, a command without a clean wake word must
// clear its floor to execute; this keeps ambient speech that merely parses from
// mutating lists, with the strictest bar on the destructive remove. Defaults come
// from DEFAULT_EXEC_FLOORS so the policy has a single source of truth. Each floor
// is overridable from config.voice.execConfidence or a LISTAM_VOICE_FLOOR_* env.
function normalizeExecFloors(raw = {}, env = {}) {
    const ec = raw && typeof raw === 'object' ? raw : {}
    const floor = (envKey, value, dflt) => {
        const v = Number(env[envKey] ?? value)
        return Number.isFinite(v) && v >= 0 && v <= 1 ? v : dflt
    }
    return {
        add_item: floor('LISTAM_VOICE_FLOOR_ADD', ec.add_item, DEFAULT_EXEC_FLOORS.add_item),
        remove_item: floor('LISTAM_VOICE_FLOOR_REMOVE', ec.remove_item, DEFAULT_EXEC_FLOORS.remove_item),
        note: floor('LISTAM_VOICE_FLOOR_NOTE', ec.note, DEFAULT_EXEC_FLOORS.note),
    }
}

const HEX_32 = /^[0-9a-f]{64}$/i

export function configPath(storageDir) {
    return `${storageDir}/headless-config.json`
}

export function normalizeRole(value) {
    return ROLES.includes(value) ? value : null
}

export function parseBootstrap(value) {
    if (Array.isArray(value)) return value.length > 0 ? value : null
    if (typeof value !== 'string' || !value.trim()) return null
    const nodes = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const at = entry.lastIndexOf(':')
            if (at <= 0) return null
            const host = entry.slice(0, at)
            const port = Number(entry.slice(at + 1))
            return host && Number.isInteger(port) && port > 0 ? { host, port } : null
        })
    return nodes.every(Boolean) && nodes.length > 0 ? nodes : null
}

export function normalizeBaseKeyHex(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return HEX_32.test(text) ? text : null
}

export function buildConfig({ role, baseKeyHex, bootstrap, maxStorageBytes, leafBridgePort, name }) {
    const normalizedRole = normalizeRole(role)
    if (!normalizedRole) {
        return { ok: false, reason: `role must be one of: ${ROLES.join(', ')}` }
    }

    const config = {
        version: 1,
        role: normalizedRole,
        maxStorageBytes: Number.isFinite(maxStorageBytes) && maxStorageBytes > 0
            ? Math.floor(maxStorageBytes)
            : DEFAULT_MAX_STORAGE_BYTES,
    }

    // Human-readable instance name advertised to peers (e.g. "Raspberry Pi").
    // A headless node has no UI, so it names itself from config; the service
    // writes a synced peer-label item on boot. Overridable at runtime with
    // LISTAM_INSTANCE_NAME. Clamped to 64 chars (matches @listam/domain MAX_LABEL_NAME).
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 64) : ''
    if (cleanName) config.name = cleanName

    const parsedBootstrap = parseBootstrap(bootstrap)
    if (parsedBootstrap) config.bootstrap = parsedBootstrap

    const parsedLeafPort = Number(leafBridgePort)
    if (Number.isInteger(parsedLeafPort) && parsedLeafPort > 0 && parsedLeafPort < 65536) {
        config.leafBridgePort = parsedLeafPort
    }

    if (normalizedRole === 'blind-storage') {
        // A blind helper pins ciphertext cores by public key. It must never be
        // configured with (or later accept) the list encryption key — that is
        // the C2 credential boundary.
        const pin = normalizeBaseKeyHex(baseKeyHex)
        if (!pin) {
            return { ok: false, reason: 'blind-storage requires --base-key <64-hex core key> to pin' }
        }
        config.pins = [pin]
    }

    return { ok: true, config }
}

export function saveConfig(fs, storageDir, config) {
    fs.mkdirSync(storageDir, { recursive: true })
    fs.writeFileSync(configPath(storageDir), JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function loadConfig(fs, storageDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(configPath(storageDir), 'utf8'))
        if (!parsed || typeof parsed !== 'object' || !normalizeRole(parsed.role)) return null
        return parsed
    } catch {
        return null
    }
}
