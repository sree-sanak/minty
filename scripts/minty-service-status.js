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

function isSafeUuid(uuid) {
    return typeof uuid === 'string' && uuid !== '.' && uuid !== '..' && /^[A-Za-z0-9._-]+$/.test(uuid);
}

function isPathInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const rel = path.relative(parentPath, childPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveUserDataDirForStatus(dataDir, uuid) {
    if (isSafeUuid(uuid)) {
        const usersDir = path.join(dataDir, 'users', uuid);
        if (fs.existsSync(usersDir)) return usersDir;
    }
    return dataDir;
}

function resolveSyncStatePath(dataDir, userDataDir) {
    const safeUserDataDir = userDataDir && isPathInside(dataDir, userDataDir) ? userDataDir : dataDir;
    const userPath = path.join(safeUserDataDir, 'sync-state.json');
    if (fs.existsSync(userPath)) return userPath;
    return path.join(dataDir, 'sync-state.json');
}

// ---------------------------------------------------------------------------
// Privacy-safe error redaction
// ---------------------------------------------------------------------------

const MAX_SAFE_MESSAGE_LEN = 150;
const SUPPORTED_SOURCE_NAMES = Object.freeze([
    'whatsapp', 'email', 'googleContacts', 'linkedin', 'telegram', 'sms', 'calendar',
]);

function redactErrorMessage(msg) {
    if (!msg || typeof msg !== 'string' || msg.trim() === '') return null;
    let s = msg;
    // Strip stack trace lines
    s = s.replace(/\n\s+at\s+.*/g, '');
    // Redact emails
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
    // Redact phone numbers (international-ish)
    s = s.replace(/\+?[\d][\d\s\-().]{7,}\d/g, '[REDACTED_PHONE]');
    // Redact JWT-like tokens and common shortened JWT snippets in logs.
    s = s.replace(/eyJ[A-Za-z0-9_.-]{8,}/g, '[REDACTED_TOKEN]');
    // Redact long token/session values after common bearer fields.
    s = s.replace(/(?<=(?:=|token\s+|Bearer\s+))[A-Za-z0-9._-]{20,}/gi, '[REDACTED_TOKEN]');
    // Redact URLs before path redaction so private hostnames are not retained.
    s = s.replace(/https?:\/\/[^\s)]+/gi, '[REDACTED_URL]');
    // Redact file paths
    s = s.replace(/(?:\/[\w.\-]+){2,}/g, '[REDACTED_PATH]');
    // Truncate
    if (s.length > MAX_SAFE_MESSAGE_LEN) s = s.slice(0, MAX_SAFE_MESSAGE_LEN) + '...';
    return s.trim() || null;
}

// ---------------------------------------------------------------------------
// Source health classification
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_HOURS = 24;

function classifySourceHealth(sourceEntry = null, now = new Date()) {
    if (!sourceEntry || typeof sourceEntry !== 'object') {
        return {
            lastSyncAt: null,
            ageHours: null,
            status: 'missing',
            errorKind: null,
            safeMessage: 'No sync state recorded',
        };
    }

    const entry = {
        lastSyncAt: sourceEntry.lastSyncAt || null,
        ageHours: null,
        status: 'never-synced',
        errorKind: null,
        safeMessage: null,
    };

    if (sourceEntry.status === 'error' || sourceEntry.lastError) {
        entry.status = 'failing';
        entry.errorKind = 'sync_error';
        entry.safeMessage = redactErrorMessage(sourceEntry.lastError || sourceEntry.error || 'unknown error');
    }

    if (entry.lastSyncAt) {
        const syncDate = new Date(entry.lastSyncAt);
        const ageMs = now.getTime() - syncDate.getTime();
        if (!Number.isFinite(ageMs)) {
            entry.status = entry.status === 'failing' ? 'failing' : 'missing';
            entry.errorKind = entry.errorKind || 'invalid_timestamp';
            entry.safeMessage = entry.safeMessage || 'Invalid sync timestamp';
            return entry;
        }
        entry.ageHours = Math.max(0, Math.round((ageMs / (3600 * 1000)) * 100) / 100);

        if (entry.status !== 'failing') {
            entry.status = entry.ageHours > STALE_THRESHOLD_HOURS ? 'stale' : 'fresh';
        }
    }

    return entry;
}

function isStoppedStatus(svcStatus) {
    if (!svcStatus?.stoppedAt) return false;
    if (!svcStatus.startedAt) return true;
    return new Date(svcStatus.stoppedAt).getTime() >= new Date(svcStatus.startedAt).getTime();
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
        status.stoppedAt = svcStatus.stoppedAt || null;
        status.running = !isStoppedStatus(svcStatus) && svcStatus.pid ? isPidAlive(svcStatus.pid) : false;
        status.startedAt = svcStatus.startedAt || null;
        status.uuid = svcStatus.uuid || null;
        status.userDataDir = svcStatus.userDataDir && isPathInside(dataDir, svcStatus.userDataDir)
            ? svcStatus.userDataDir
            : resolveUserDataDirForStatus(dataDir, status.uuid);
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
        status.sourceHealth = {};
        const now = new Date();
        for (const name of SUPPORTED_SOURCE_NAMES) {
            status.sourceHealth[name] = classifySourceHealth(syncState[name], now);
        }
        for (const [key, val] of Object.entries(syncState)) {
            if (val && typeof val === 'object') {
                status.sources[key] = {
                    status: val.status || 'unknown',
                    lastSyncAt: val.lastSyncAt || null,
                };
                status.sourceHealth[key] = classifySourceHealth(val, now);
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
    if (status.stoppedAt) lines.push(`  Stopped:    ${status.stoppedAt}`);
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
    isPidAlive, loadJson, buildStatus, formatTty, redactErrorMessage, classifySourceHealth,
    isSafeUuid, isPathInside, resolveUserDataDirForStatus, resolveSyncStatePath,
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
