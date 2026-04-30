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
// GBrain export runner
// ---------------------------------------------------------------------------

function runGbrainExport(dataDir) {
    const script = path.join(__dirname, 'export-gbrain-memory.js');
    const outDir = path.join(dataDir, 'gbrain');
    const args = ['--data-dir', dataDir, '--out-dir', outDir];
    execFile(process.execPath, [script, ...args], (err, stdout, stderr) => {
        if (err) {
            console.error('[minty-service] gbrain export failed:', err.message);
            if (stderr) console.error(stderr);
        } else {
            console.log('[minty-service] gbrain export complete');
            if (stdout) process.stdout.write(stdout);
        }
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

    const { startSyncDaemon } = require('../crm/sync');
    const daemon = startSyncDaemon(uuid, userDataDir);

    // GBrain export (opt-in)
    let gbrainTimer = null;
    if (process.env.MINTY_GBRAIN_EXPORT === '1') {
        const interval = resolveGbrainInterval(process.env);
        console.log(`[minty-service] gbrain export enabled (interval: ${interval}ms)`);
        runGbrainExport(dataDir);
        gbrainTimer = setInterval(() => runGbrainExport(dataDir), interval);
        gbrainTimer.unref();
    }

    // Graceful shutdown
    function shutdown(signal) {
        console.log(`[minty-service] ${signal} received, stopping…`);
        if (gbrainTimer) clearInterval(gbrainTimer);
        daemon.stop();
        process.exit(0);
    }
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep process alive
    const keepAlive = setInterval(() => {}, 1 << 30);
    keepAlive.unref();
}

module.exports = { resolveDataDir, resolveUuid, resolveUserDataDir, resolveGbrainInterval };
