import { normalizeMirrorManifest, writeMirrorState, MAX_MIRROR_CORES } from '@listam/backend/lib/blind-manifest.mjs'

const HEX = /^[0-9a-f]{64}$/
export function createBlindPins({ fs, storageDir, pins = [] }) {
    const path = `${storageDir}/headless-blind-pins.json`
    let state = { version: 1, manual: [...new Set(pins)], manifests: {} }
    try { state = JSON.parse(fs.readFileSync(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (state.version !== 1 || !Array.isArray(state.manual) || !state.manual.every((key) => typeof key === 'string' && HEX.test(key)) || !state.manifests || typeof state.manifests !== 'object' || Array.isArray(state.manifests)) throw new Error('invalid persisted blind pins')
    state.manifests = Object.fromEntries(Object.entries(state.manifests).map(([id, manifest]) => {
        if (!/^(local|[0-9a-f]{64}):[0-9a-f]{64}$/.test(id)) throw new Error('invalid manifest owner')
        const parsed = normalizeMirrorManifest(manifest)
        if (id.split(':')[1] !== parsed.baseKey) throw new Error('invalid manifest base')
        return [id, parsed]
    }))
    function keys(value = state) {
        const all = [...new Set([...value.manual, ...Object.values(value.manifests).flatMap((m) => m.keys)])].sort()
        if (all.length > MAX_MIRROR_CORES) throw new Error('mirror-core-limit')
        return all
    }
    keys()
    function commit(next) { keys(next); writeMirrorState(fs, path, next); state = next }
    return {
        keys,
        manifestCount: () => Object.keys(state.manifests).length,
        pin(key) {
            if (typeof key !== 'string' || !HEX.test(key)) throw new Error('pin requires a 64-hex core key')
            commit({ ...state, manual: [...new Set([...state.manual, key])] })
        },
        apply(value, owner = 'local') {
            if (owner !== 'local' && !HEX.test(owner)) throw new Error('invalid manifest owner')
            const manifest = normalizeMirrorManifest(value)
            const id = `${owner}:${manifest.baseKey}`
            const previous = state.manifests[id]
            if (previous && manifest.revision < previous.revision) throw new Error('stale-mirror-manifest')
            if (previous && manifest.revision === previous.revision) {
                if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('conflicting-mirror-manifest')
                return
            }
            if (!previous && Object.keys(state.manifests).length >= 128) throw new Error('mirror-manifest-limit')
            commit({ ...state, manifests: { ...state.manifests, [id]: manifest } })
        },
    }
}
