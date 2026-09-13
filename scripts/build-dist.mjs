#!/usr/bin/env node
// Builds the website archive with vendored shared-package tarballs. Extract it
// and run npm install inside package/. --registry instead produces a publishable
// package using registry ranges, after shared versions have been published.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = path.join(root, 'dist')
const stageDir = path.join(distDir, 'stage')
const registry = process.argv.includes('--registry')

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
    overrides: Object.fromEntries(Object.entries(pkg.overrides ?? {}).filter(([, spec]) => typeof spec === 'string' && !spec.startsWith('file:'))),
    ...(Object.keys(optionalDependencies).length ? { optionalDependencies } : {}),
}

fs.rmSync(stageDir, { recursive: true, force: true })
fs.mkdirSync(stageDir, { recursive: true })
for (const entry of ['headless.mjs', 'src', 'README.md', 'LICENSE']) {
    fs.cpSync(path.join(root, entry), path.join(stageDir, entry), { recursive: true })
}
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n')

// The downloadable archive carries the exact shared source used for this
// release. Registry publishing remains a separate, explicit release step.
if (!registry) {
    const vendorDir = path.join(stageDir, 'vendor')
    fs.mkdirSync(vendorDir)
    const sharedRoot = path.resolve(root, '../listam-packages/packages')
    for (const entry of fs.readdirSync(sharedRoot).sort()) {
        const directory = path.join(sharedRoot, entry)
        if (!fs.existsSync(path.join(directory, 'package.json'))) continue
        const meta = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
        const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', vendorDir], { cwd: directory, encoding: 'utf8' }))
        distPkg.dependencies[meta.name] = `file:vendor/${packed.filename}`
        distPkg.overrides[meta.name] = `$${meta.name}`
    }
    distPkg.files.push('vendor')
    distPkg.private = true
    fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n')
}

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
console.log(registry ? `publish  cd ${path.relative(process.cwd(), stageDir)} && npm publish` : 'standalone archive includes shared packages; use --registry only after npm publication')
