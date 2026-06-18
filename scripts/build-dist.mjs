#!/usr/bin/env node
// Builds the standalone distribution of listam-headless: dist/stage/ is a
// publishable copy whose @listam/* deps point at the npm registry instead
// of the local listam-packages checkout (the working tree stays on file:
// links for development), and dist/<name>-<version>.tgz is the tarball
// served from the website. `npm publish` runs from dist/stage/.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = path.join(root, 'dist')
const stageDir = path.join(distDir, 'stage')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

function registryRange(spec) {
    const target = path.resolve(root, spec.slice('file:'.length), 'package.json')
    const dep = JSON.parse(fs.readFileSync(target, 'utf8'))
    return `^${dep.version}`
}

function mapDeps(deps) {
    return Object.fromEntries(
        Object.entries(deps ?? {}).map(([name, spec]) => [
            name,
            spec.startsWith('file:') ? registryRange(spec) : spec,
        ])
    )
}

const dependencies = mapDeps(pkg.dependencies)
// optionalDependencies (e.g. @abandonware/noble for `provision-leaf`) must be
// carried through too, or the published CLI can never load the optional BLE
// transport even on a host that has the radio.
const optionalDependencies = mapDeps(pkg.optionalDependencies)

const distPkg = {
    name: pkg.name,
    version: pkg.version,
    description:
        'Always-on Listam peer for your own hardware (Raspberry Pi, mini PC, NAS). ' +
        'Keeps your shared lists available and durable — participant or blind-storage role.',
    license: 'MIT',
    type: pkg.type,
    main: pkg.main,
    bin: pkg.bin,
    files: ['headless.mjs', 'src'],
    scripts: { start: pkg.scripts.start },
    engines: { node: '>=22' },
    repository: { type: 'git', url: 'git+https://github.com/romme86/listam-headless.git' },
    homepage: 'https://github.com/romme86/listam-headless#readme',
    bugs: { url: 'https://github.com/romme86/listam-headless/issues' },
    keywords: ['listam', 'p2p', 'local-first', 'hyperswarm', 'autobase', 'raspberry-pi', 'self-hosted'],
    dependencies,
    ...(Object.keys(optionalDependencies).length ? { optionalDependencies } : {}),
}

fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
for (const entry of ['headless.mjs', 'src', 'README.md', 'LICENSE']) {
    fs.cpSync(path.join(root, entry), path.join(stageDir, entry), { recursive: true })
}
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n')

const packed = execFileSync('npm', ['pack', '--pack-destination', distDir], {
    cwd: stageDir,
    encoding: 'utf8',
}).trim()

const tarball = path.join(distDir, packed)
const bytes = fs.readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')

console.log(`tarball  ${tarball}`)
console.log(`size     ${bytes.length} bytes`)
console.log(`sha256   ${sha256}`)
console.log(`publish  cd ${path.relative(process.cwd(), stageDir)} && npm publish`)
