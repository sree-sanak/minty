'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SERVICE_SCRIPT = path.resolve(__dirname, '../../scripts/minty-service.js');
const STATUS_SCRIPT = path.resolve(__dirname, '../../scripts/minty-service-status.js');

test('[minty-service] SIGTERM → clean shutdown with exit code 0', { timeout: 10_000, skip: process.platform === 'win32' ? 'POSIX signal semantics differ on Windows' : false }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-svc-'));
    try {
        const child = spawn(process.execPath, [SERVICE_SCRIPT, '--data-dir', tmp], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CRM_DATA_DIR: tmp },
        });

        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        // Wait for daemon startup output before sending SIGTERM. Signal handlers
        // are registered immediately after this startup path completes.
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`startup timeout. stdout=${stdout} stderr=${stderr}`));
            }, 5000);
            child.stdout.on('data', function check() {
                if (stdout.includes('[sync] Daemon started')) {
                    clearTimeout(timeout);
                    child.stdout.removeListener('data', check);
                    setTimeout(resolve, 500);
                }
            });
            child.on('error', (e) => { clearTimeout(timeout); reject(e); });
        });

        // Send SIGTERM
        child.kill('SIGTERM');

        // Wait for exit
        const { code, signal } = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`shutdown timeout. stdout=${stdout} stderr=${stderr}`));
            }, 5000);
            child.on('close', (c, s) => { clearTimeout(timeout); resolve({ code: c, signal: s }); });
        });

        assert.equal(code, 0, `expected exit code 0, got ${code} (signal=${signal}). stderr: ${stderr}`);
        assert.ok(stdout.includes('[minty-service] SIGTERM received'), 'should log SIGTERM');
        assert.ok(stdout.includes('[minty-service] stopped'), 'should log stopped');

        // Verify service-status.json was written
        const statusPath = path.join(tmp, 'service-status.json');
        assert.ok(fs.existsSync(statusPath), 'service-status.json should exist');
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        assert.ok(status.pid, 'status should have pid');
        assert.ok(status.startedAt, 'status should have startedAt');
        assert.ok(status.stoppedAt, 'status should have stoppedAt');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('[minty-service-status] --json prints machine-readable service status', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-svc-status-'));
    try {
        fs.writeFileSync(path.join(tmp, 'service-status.json'), JSON.stringify({
            pid: process.pid,
            startedAt: '2026-01-01T00:00:00.000Z',
            uuid: 'single-user',
        }));
        const result = spawnSync(process.execPath, [STATUS_SCRIPT, '--data-dir', tmp, '--json'], {
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
        const status = JSON.parse(result.stdout);
        assert.equal(status.dataDir, tmp);
        assert.equal(status.running, true);
        assert.equal(status.uuid, 'single-user');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
