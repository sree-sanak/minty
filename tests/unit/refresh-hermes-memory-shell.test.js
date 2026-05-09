'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-refresh-shell-test-'));
}

function runRefreshWithStubs({ npmExitCode, diagnosticsExitCode }) {
    const dir = tmpDir();
    try {
        const binDir = path.join(dir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(binDir, 'npm'), [
            '#!/usr/bin/env bash',
            'if [[ "$*" == *"gbrain:export"* ]]; then',
            '  mkdir -p data/gbrain',
            '  printf "# synthetic relationship memory\\n" > data/gbrain/relationship-memory.md',
            'fi',
            `exit ${npmExitCode}`,
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(binDir, 'node'), [
            '#!/usr/bin/env bash',
            'case "$*" in',
            `  *"${ROOT_DIR}/scripts/memory-refresh-diagnostics.js"*) exit ${diagnosticsExitCode} ;;`,
            '  -e*) exit 1 ;;',
            '  *) exit 0 ;;',
            'esac',
            '',
        ].join('\n'));
        fs.chmodSync(path.join(binDir, 'npm'), 0o755);
        fs.chmodSync(path.join(binDir, 'node'), 0o755);

        return spawnSync('bash', [path.join(ROOT_DIR, 'scripts', 'refresh-hermes-memory.sh')], {
            cwd: ROOT_DIR,
            env: {
                ...process.env,
                PATH: `${binDir}:/usr/bin:/bin`,
            },
            encoding: 'utf8',
        });
    } finally {
        const generatedMemory = path.join(ROOT_DIR, 'data', 'gbrain', 'relationship-memory.md');
        fs.rmSync(generatedMemory, { force: true });
        try {
            fs.rmdirSync(path.dirname(generatedMemory));
        } catch (_err) {
            // Best-effort cleanup only; do not mask the shell result under test.
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function assertNoSensitiveShellOutput(result) {
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.equal(combined.includes('TELEGRAM_API_HASH'), false);
    assert.equal(combined.includes('TELEGRAM_SESSION'), false);
    assert.equal(combined.includes('/root/.hermes'), false);
}

test('[RefreshHermesMemoryShell]: diagnostics writer failure exits nonzero when refresh succeeds', { skip: process.platform === 'win32' }, () => {
    const result = runRefreshWithStubs({ npmExitCode: 0, diagnosticsExitCode: 7 });

    assert.equal(result.status, 7);
    assert.match(result.stderr, /Failed to write memory refresh diagnostics \(exit code 7\)\./);
    assertNoSensitiveShellOutput(result);
});

test('[RefreshHermesMemoryShell]: refresh failure keeps refresh exit code when diagnostics also fail', { skip: process.platform === 'win32' }, () => {
    const result = runRefreshWithStubs({ npmExitCode: 5, diagnosticsExitCode: 7 });

    assert.equal(result.status, 5);
    assert.match(result.stderr, /Failed to write memory refresh diagnostics \(exit code 7\)\./);
    assertNoSensitiveShellOutput(result);
});
