// Installer rendering: the systemd/cron plumbing itself only runs on a Linux
// host, but every generated artifact is a pure function we can pin down here.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    CRON_MARKER,
    assertShellSafe,
    mergeCrontabLines,
    renderGuardCrontab,
    renderRunScript,
    renderUnitFile,
} from '../src/install.mjs'

const PATHS = {
    nodePath: '/home/u/node22/bin/node',
    headlessPath: '/home/u/listam/listam-headless/headless.mjs',
    storageDir: '/home/u/listam-data',
    runScriptPath: '/home/u/listam-data/run.sh',
}

test('run script: setup-if-missing, FIFO kept open read-write on fd0', () => {
    const script = renderRunScript(PATHS)
    assert.ok(script.startsWith('#!/bin/bash\n'))
    assert.match(script, /set -u/)
    // Setup must be guarded by config existence (a plain re-run would fail
    // without --force) and carry the requested role.
    assert.match(script, /if \[ ! -f "\/home\/u\/listam-data\/headless-config\.json" \]; then/)
    assert.match(script, /setup --storage "\$STORAGE" --role participant\n/)
    assert.match(script, /\[ -p "\$FIFO" \] \|\| mkfifo "\$FIFO"/)
    // The read-write redirect is the whole point: stdin EOF means shutdown.
    assert.match(script, /exec "\/home\/u\/node22\/bin\/node" "\/home\/u\/listam\/listam-headless\/headless\.mjs" run --storage "\$STORAGE" 0<>"\$FIFO"\n$/)
})

test('run script: blind-storage role forwards the pinned base key', () => {
    const script = renderRunScript({ ...PATHS, role: 'blind-storage', baseKeyHex: 'ab'.repeat(32) })
    assert.match(script, new RegExp(`--role blind-storage --base-key ${'ab'.repeat(32)}`))
})

test('unit file: restart policy rides out the storage-lease TTL', () => {
    const unit = renderUnitFile(PATHS)
    // StartLimit* must sit in [Unit] (their home since systemd 230).
    assert.ok(unit.indexOf('StartLimitIntervalSec=120') < unit.indexOf('[Service]'))
    assert.ok(unit.indexOf('StartLimitBurst=8') < unit.indexOf('[Service]'))
    assert.match(unit, /ExecStart=\/bin\/bash \/home\/u\/listam-data\/run\.sh/)
    assert.match(unit, /Restart=always/)
    assert.match(unit, /RestartSec=10/)
    assert.match(unit, /WantedBy=default\.target/)
})

test('guard crontab: boot start plus a stale-status watchdog, both marked', () => {
    const lines = renderGuardCrontab(PATHS)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^@reboot setsid -f \/home\/u\/listam-data\/run\.sh >> \/home\/u\/listam-data\/service\.log 2>&1 /)
    assert.match(lines[1], /^\*\/5 \* \* \* \* .*status --storage \/home\/u\/listam-data > \/dev\/null 2>&1 \|\| setsid -f/)
    for (const line of lines) assert.ok(line.endsWith(CRON_MARKER))
})

test('crontab merge replaces only installer-marked lines', () => {
    const existing = [
        '0 4 * * * /home/u/backup.sh',
        `@reboot /old/run.sh ${CRON_MARKER}`,
        '',
        `*/5 * * * * /old/guard ${CRON_MARKER}`,
    ].join('\n')
    const merged = mergeCrontabLines(existing, renderGuardCrontab(PATHS))
    const lines = merged.trimEnd().split('\n')
    assert.equal(lines[0], '0 4 * * * /home/u/backup.sh')
    assert.equal(lines.length, 3)
    assert.ok(!merged.includes('/old/'))
    assert.ok(merged.endsWith('\n'))
    // Idempotent: a second merge changes nothing.
    assert.equal(mergeCrontabLines(merged, renderGuardCrontab(PATHS)), merged)
})

test('shell-unsafe paths are refused instead of quoted', () => {
    assert.doesNotThrow(() => assertShellSafe('path', '/home/u/listam-data'))
    for (const bad of ['/home/u/my listam', '/home/u/$HOME', '/home/u/a"b', "/home/u/a'b", '/home/u/a`b', '/home/u/a\\b', '']) {
        assert.throws(() => assertShellSafe('path', bad), /must be a non-empty path/)
    }
    assert.throws(() => renderRunScript({ ...PATHS, storageDir: '/home/u/with space' }))
})
