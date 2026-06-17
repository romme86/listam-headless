// Headless instance configuration: which role this device performs, where it
// stores data, how it bootstraps, and its storage quota. Written by `setup`,
// read by `run`/`status`. The fs module is injected for testability.
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
    return {
        enabled: env.LISTAM_VOICE_ENABLED === '1' || r.enabled === true,
        engine: r.engine || 'whisper-cpp',
        binPath: env.LISTAM_VOICE_BIN || r.binPath || 'whisper-cli',
        modelPath: env.LISTAM_VOICE_MODEL || r.modelPath || null,
        audioPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_VOICE_PORT,
        locale: r.locale || 'auto',
        notesListId: r.notesListId || 'voicenotes',
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

export function buildConfig({ role, baseKeyHex, bootstrap, maxStorageBytes, leafBridgePort }) {
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
