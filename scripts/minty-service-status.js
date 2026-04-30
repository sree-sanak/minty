#!/usr/bin/env node

/**
 * scripts/minty-service-status.js — Print Minty service status.
 *
 * Usage:
 *   node scripts/minty-service-status.js [--data-dir <path>] [--json]
 *   npm run service:status
 *   npm run service:status -- --json
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { resolveDataDir } = require('./minty-service');

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Check if a PID is alive.
 */
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Safely load a JSON file, returning null on any error.
 */
function loadJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function resolveUserDataDirForStatus(dataDir, uuid) {
    if (uuid) {
        const usersDir = path.join(dataDir, 'users', uuid);
        if (fs.existsSync(usersDir)) return usersDir;
    }
    return dataDir;
}

function resolveSyncStatePath(dataDir, userDataDir) {
    const userPath = path.join(userDataDir || dataDir, 'sync-state.json');
    if (fs.existsSync(userPath)) return userPath;
    return path.join(dataDir, 'sync-state.json');
}

/**
 * Build a concise status object from the data directory.
 */
function buildStatus(dataDir) {
    const status = { dataDir };

    // service-status.json (written by minty-service.js)
    const svcStatus = loadJson(path.join(dataDir, 'service-status.json'));
    if (svcStatus) {
        status.pid = svcStatus.pid || null;
        status.running = svcStatus.pid ? isPidAlive(svcStatus.pid) : false;
        status.startedAt = svcStatus.startedAt || null;
        status.uuid = svcStatus.uuid || null;
        status.userDataDir = svcStatus.userDataDir || resolveUserDataDirForStatus(dataDir, status.uuid);
        if (svcStatus.gbrain) status.gbrain = svcStatus.gbrain;
    } else {
        status.running = false;
        status.pid = null;
        status.startedAt = null;
        status.userDataDir = resolveUserDataDirForStatus(dataDir, null);
    }

    // sync-state.json (written by crm/sync.js). In service mode this may live
    // under data/users/<uuid>/sync-state.json, while older/single-user setups
    // keep it directly under data/.
    const syncStatePath = resolveSyncStatePath(dataDir, status.userDataDir);
    status.syncStatePath = syncStatePath;
    const syncState = loadJson(syncStatePath);
    if (syncState) {
        status.sources = {};
        for (const [key, val] of Object.entries(syncState)) {
            if (val && typeof val === 'object') {
                status.sources[key] = {
                    status: val.status || 'unknown',
                    lastSyncAt: val.lastSyncAt || null,
                };
            }
        }
    }

    return status;
}

/**
 * Format status as human-readable TTY text.
 */
function formatTty(status) {
    const lines = [];
    const running = status.running ? 'running' : 'stopped';
    lines.push(`Minty service: ${running}`);
    if (status.pid) lines.push(`  PID:        ${status.pid}`);
    if (status.startedAt) lines.push(`  Started:    ${status.startedAt}`);
    if (status.uuid) lines.push(`  UUID:       ${status.uuid}`);
    lines.push(`  Data dir:   ${status.dataDir}`);

    if (status.gbrain) {
        const g = status.gbrain;
        if (g.lastSuccessAt) lines.push(`  GBrain:     last export ${g.lastSuccessAt}`);
        if (g.lastErrorAt) lines.push(`  GBrain err: ${g.lastError} (${g.lastErrorAt})`);
    }

    if (status.sources) {
        lines.push('  Sources:');
        for (const [name, src] of Object.entries(status.sources)) {
            const sync = src.lastSyncAt ? src.lastSyncAt : 'never';
            lines.push(`    ${name.padEnd(16)} ${src.status.padEnd(8)} last: ${sync}`);
        }
    }

    return lines.join('\n');
}

module.exports = {
    isPidAlive, loadJson, buildStatus, formatTty,
    resolveUserDataDirForStatus, resolveSyncStatePath,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
    const dataDir = path.resolve(resolveDataDir(process.argv, process.env));
    const useJson = process.argv.includes('--json') || !process.stdout.isTTY;

    const status = buildStatus(dataDir);

    if (useJson) {
        console.log(JSON.stringify(status, null, 2));
    } else {
        console.log(formatTty(status));
    }
}
