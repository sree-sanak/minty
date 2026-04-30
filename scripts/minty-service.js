#!/usr/bin/env node

/**
 * scripts/minty-service.js — Headless Minty service entrypoint.
 *
 * Runs the sync daemon in the background without the HTTP/UI server.
 * Suitable for always-on deployment behind Hermes or as a standalone daemon.
 *
 * Usage:
 *   node scripts/minty-service.js [--data-dir <path>] [--uuid <uuid>]
 *   MINTY_DEMO=1 node scripts/minty-service.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the data directory from CLI args, env, or defaults.
 */
function resolveDataDir(argv, env) {
    const idx = argv.indexOf('--data-dir');
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
    if (env.CRM_DATA_DIR) return env.CRM_DATA_DIR;
    if (env.MINTY_DEMO === '1') return path.join(__dirname, '..', 'data-demo');
    return path.join(__dirname, '..', 'data');
}

/**
 * Resolve user UUID from CLI args, env, or default.
 */
function resolveUuid(argv, env) {
    const idx = argv.indexOf('--uuid');
    if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
    if (env.MINTY_USER_UUID) return env.MINTY_USER_UUID;
    return 'single-user';
}

/**
 * Resolve the user data directory. If data/users/<uuid> exists, use it;
 * otherwise fall back to the base data directory.
 */
function resolveUserDataDir(dataDir, uuid) {
    const usersDir = path.join(dataDir, 'users', uuid);
    if (fs.existsSync(usersDir)) return usersDir;
    return dataDir;
}

/**
 * Parse GBrain export interval from env (milliseconds). Default 6 hours.
 */
function resolveGbrainInterval(env) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const raw = env.MINTY_GBRAIN_EXPORT_INTERVAL_MS;
    if (!raw) return SIX_HOURS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : SIX_HOURS;
}

// ---------------------------------------------------------------------------
// Service status helpers (exported for tests)
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 256;

/**
 * Shape a gbrain export status object from success/failure.
 * Truncates error messages to avoid leaking large stderr.
 */
function shapeGbrainStatus(err, stderr) {
    const now = new Date().toISOString();
    if (err) {
        const msg = (err.message || '').slice(0, MAX_ERROR_LENGTH);
        const detail = (stderr || '').slice(0, MAX_ERROR_LENGTH);
        return { lastErrorAt: now, lastError: msg, lastErrorDetail: detail };
    }
    return { lastSuccessAt: now };
}

/**
 * Read, merge, and write service-status.json atomically.
 */
function updateServiceStatus(statusPath, patch) {
    let current = {};
    try { current = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
    const merged = { ...current, ...patch };
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const tmpPath = `${statusPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, statusPath);
    try { fs.chmodSync(statusPath, 0o600); } catch { /* ignore */ }
    return merged;
}

// ---------------------------------------------------------------------------
// GBrain export runner
// ---------------------------------------------------------------------------

/**
 * Run the gbrain export subprocess. Returns the ChildProcess handle.
 * Accepts an optional onComplete(err, stderr) callback for status tracking.
 */
function runGbrainExport(dataDir, onComplete) {
    const script = path.join(__dirname, 'export-gbrain-memory.js');
    const outDir = path.join(dataDir, 'gbrain');
    const args = ['--data-dir', dataDir, '--out-dir', outDir];
    const child = execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
        if (err) {
            console.error('[minty-service] gbrain export failed:', err.message);
            if (stderr) console.error(stderr);
        } else {
            console.log('[minty-service] gbrain export complete');
            if (stdout) process.stdout.write(stdout);
        }
        if (onComplete) onComplete(err, stderr);
    });
    return child;
}

function waitForChildExit(child, timeoutMs = 5000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        let timeout;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            child.removeListener('exit', finish);
            child.removeListener('close', finish);
            resolve();
        };
        timeout = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            finish();
        }, timeoutMs);
        child.once('exit', finish);
        child.once('close', finish);
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
    const dataDir = path.resolve(resolveDataDir(process.argv, process.env));
    const uuid = resolveUuid(process.argv, process.env);
    const userDataDir = resolveUserDataDir(dataDir, uuid);

    // crm/sync.js reads CRM_DATA_DIR at module load for config/users.json.
    // Set it before requiring the daemon so headless service mode honors --data-dir.
    process.env.CRM_DATA_DIR = dataDir;

    console.log('[minty-service] starting');
    console.log('[minty-service] data-dir:', dataDir);
    console.log('[minty-service] uuid:', uuid);
    console.log('[minty-service] user-data-dir:', userDataDir);
    console.log('[minty-service] local-first: all data stays on disk, no cloud sync');
    console.log('[minty-service] privacy: no telemetry, no external calls beyond configured sources');

    // Service status file
    const statusPath = path.join(dataDir, 'service-status.json');
    updateServiceStatus(statusPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        dataDir,
        uuid,
        userDataDir,
    });

    const { startSyncDaemon } = require('../crm/sync');
    const daemon = startSyncDaemon(uuid, userDataDir);

    // GBrain export (opt-in)
    let activeGbrainChild = null;
    const startGbrainExport = () => {
        if (activeGbrainChild) {
            console.warn('[minty-service] gbrain export skipped: previous export still running');
            return null;
        }
        activeGbrainChild = runGbrainExport(dataDir, (err, stderr) => {
            activeGbrainChild = null;
            const patch = { gbrain: shapeGbrainStatus(err, stderr) };
            updateServiceStatus(statusPath, patch);
        });
        activeGbrainChild.on('exit', () => { activeGbrainChild = null; });
        return activeGbrainChild;
    };
    let gbrainTimer = null;
    if (process.env.MINTY_GBRAIN_EXPORT === '1') {
        const interval = resolveGbrainInterval(process.env);
        console.log(`[minty-service] gbrain export enabled (interval: ${interval}ms)`);
        startGbrainExport();
        gbrainTimer = setInterval(startGbrainExport, interval);
        gbrainTimer.unref();
    }

    // Keep process alive until SIGINT/SIGTERM. The interval is ref'd (default)
    // so Node won't exit even if daemon timers are all unref'd.
    const keepAlive = setInterval(() => {}, 1 << 30);

    // Graceful shutdown
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[minty-service] ${signal} received, stopping…`);
        clearInterval(keepAlive);
        if (gbrainTimer) clearInterval(gbrainTimer);
        const gbrainChild = activeGbrainChild;
        if (activeGbrainChild) {
            activeGbrainChild.kill('SIGTERM');
        }
        daemon.stop();
        await waitForChildExit(gbrainChild, 5000);
        activeGbrainChild = null;
        updateServiceStatus(statusPath, { stoppedAt: new Date().toISOString() });
        console.log('[minty-service] stopped');
        process.exit(0);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
    resolveDataDir, resolveUuid, resolveUserDataDir, resolveGbrainInterval,
    shapeGbrainStatus, updateServiceStatus, waitForChildExit,
};
