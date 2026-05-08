'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    isPidAlive,
    loadJson,
    buildStatus,
    formatTty,
    isSafeUuid,
    isPathInside,
    resolveUserDataDirForStatus,
    resolveSyncStatePath,
    redactErrorMessage,
    classifySourceHealth,
} = require('../../scripts/minty-service-status');

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

test('[service-status] isPidAlive: current process is alive', () => {
    assert.equal(isPidAlive(process.pid), true);
});

test('[service-status] isPidAlive: invalid PID is not alive', () => {
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive('123'), false);
});

// ---------------------------------------------------------------------------
// loadJson
// ---------------------------------------------------------------------------

test('[service-status] loadJson: reads valid JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const p = path.join(tmp, 'test.json');
    fs.writeFileSync(p, '{"a":1}');
    assert.deepEqual(loadJson(p), { a: 1 });
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] loadJson: returns null for missing file', () => {
    assert.equal(loadJson('/tmp/does-not-exist-' + Date.now() + '.json'), null);
});

// ---------------------------------------------------------------------------
// buildStatus
// ---------------------------------------------------------------------------

test('[service-status] buildStatus: empty data dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const s = buildStatus(tmp);
    assert.equal(s.running, false);
    assert.equal(s.pid, null);
    assert.equal(s.dataDir, tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: with service-status.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmp, 'service-status.json'), JSON.stringify({
        pid: process.pid, startedAt: '2025-01-01T00:00:00Z', uuid: 'test-user',
    }));
    const s = buildStatus(tmp);
    assert.equal(s.running, true);
    assert.equal(s.pid, process.pid);
    assert.equal(s.uuid, 'test-user');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: stoppedAt prevents stale pid from reporting running', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmp, 'service-status.json'), JSON.stringify({
        pid: process.pid,
        startedAt: '2025-01-01T00:00:00Z',
        stoppedAt: '2025-01-01T00:00:01Z',
    }));
    const s = buildStatus(tmp);
    assert.equal(s.running, false);
    assert.equal(s.stoppedAt, '2025-01-01T00:00:01Z');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: includes sync-state sources', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), JSON.stringify({
        email: { status: 'ok', lastSyncAt: '2025-01-01T00:00:00Z' },
        whatsapp: { status: 'idle', lastSyncAt: null },
    }));
    const s = buildStatus(tmp);
    assert.equal(s.sources.email.status, 'ok');
    assert.equal(s.sources.whatsapp.lastSyncAt, null);
    assert.equal(s.syncStatePath, path.join(tmp, 'sync-state.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: reads service-mode sync state from users/<uuid>', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const userDir = path.join(tmp, 'users', 'u1');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'service-status.json'), JSON.stringify({ uuid: 'u1' }));
    fs.writeFileSync(path.join(userDir, 'sync-state.json'), JSON.stringify({
        googleContacts: { status: 'ok', lastSyncAt: '2025-01-02T00:00:00Z' },
    }));
    const s = buildStatus(tmp);
    assert.equal(s.userDataDir, userDir);
    assert.equal(s.syncStatePath, path.join(userDir, 'sync-state.json'));
    assert.equal(s.sources.googleContacts.status, 'ok');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

test('[service-status] resolveUserDataDirForStatus: uses users/<uuid> when present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const userDir = path.join(tmp, 'users', 'u1');
    fs.mkdirSync(userDir, { recursive: true });
    assert.equal(resolveUserDataDirForStatus(tmp, 'u1'), userDir);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] isSafeUuid: rejects path traversal and path separators', () => {
    assert.equal(isSafeUuid('u1'), true);
    assert.equal(isSafeUuid('user.name-1'), true);
    assert.equal(isSafeUuid('../outside'), false);
    assert.equal(isSafeUuid('nested/user'), false);
    assert.equal(isSafeUuid('.'), false);
    assert.equal(isSafeUuid('..'), false);
    assert.equal(isSafeUuid(''), false);
});

test('[service-status] resolveUserDataDirForStatus: unsafe uuid falls back to data dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-outside-'));
    fs.mkdirSync(path.join(outside, 'x'), { recursive: true });
    assert.equal(resolveUserDataDirForStatus(tmp, `../../${path.basename(outside)}/x`), tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

test('[service-status] isPathInside: rejects paths outside parent', () => {
    const parent = path.join(os.tmpdir(), 'minty-parent');
    assert.equal(isPathInside(parent, path.join(parent, 'users', 'u1')), true);
    assert.equal(isPathInside(parent, path.join(os.tmpdir(), 'other')), false);
});

test('[service-status] resolveSyncStatePath: prefers user sync-state', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const userDir = path.join(tmp, 'users', 'u1');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), '{}');
    fs.writeFileSync(path.join(userDir, 'sync-state.json'), '{}');
    assert.equal(resolveSyncStatePath(tmp, userDir), path.join(userDir, 'sync-state.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] resolveSyncStatePath: ignores userDataDir outside data dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-outside-'));
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), '{}');
    fs.writeFileSync(path.join(outside, 'sync-state.json'), '{}');
    assert.equal(resolveSyncStatePath(tmp, outside), path.join(tmp, 'sync-state.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatTty
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// redactErrorMessage
// ---------------------------------------------------------------------------

test('[service-status] redactErrorMessage: redacts email addresses', () => {
    assert.equal(redactErrorMessage('Failed for user@example.com'), 'Failed for [REDACTED_EMAIL]');
});

test('[service-status] redactErrorMessage: redacts phone numbers', () => {
    assert.equal(redactErrorMessage('Call +1-555-867-5309 failed'), 'Call [REDACTED_PHONE] failed');
});

test('[service-status] redactErrorMessage: redacts tokens and session strings', () => {
    assert.equal(
        redactErrorMessage('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature expired'),
        'Bearer [REDACTED_TOKEN] expired'
    );
    assert.equal(
        redactErrorMessage('session=abc123def456ghi789jkl012mno345 invalid'),
        'session=[REDACTED_TOKEN] invalid'
    );
});

test('[service-status] redactErrorMessage: redacts file paths', () => {
    assert.equal(
        redactErrorMessage('ENOENT /home/user/.config/minty/secrets.json'),
        'ENOENT [REDACTED_PATH]'
    );
    assert.equal(
        redactErrorMessage('ENOENT C:\\Users\\person\\.config\\minty\\secrets.json'),
        'ENOENT [REDACTED_PATH]'
    );
    assert.equal(
        redactErrorMessage('ENOENT C:\\Users\\Person Name\\AppData\\Roaming\\minty\\secrets.json failed'),
        'ENOENT [REDACTED_PATH]'
    );
    assert.equal(
        redactErrorMessage('ENOENT /Users/Person Name/.config/minty/secrets.json failed'),
        'ENOENT [REDACTED_PATH]'
    );
    assert.equal(
        redactErrorMessage('ENOENT /Users/John Doe/.config/minty/secrets.json'),
        'ENOENT [REDACTED_PATH]'
    );
});

test('[service-status] redactErrorMessage: redacts standalone token-like secrets', () => {
    const prefixedToken = `sk_${'live'}_${'abcdefghijklmnopqrstuvwxyz'}`;
    const hexToken = 'a'.repeat(32);
    const lowercaseToken = 'z'.repeat(40);
    const result = redactErrorMessage(`Auth failed for API key ${prefixedToken}; request id ${hexToken}; opaque ${lowercaseToken}`);
    assert.ok(result.includes('[REDACTED_TOKEN]'));
    assert.ok(!result.includes('sk_live_'));
    assert.ok(!result.includes(hexToken));
    assert.ok(!result.includes(lowercaseToken));
});

test('[service-status] redactErrorMessage: extracts safe object-shaped errors', () => {
    const token = 'abcDEF1234567890abcDEF1234567890';
    const result = redactErrorMessage({
        at: '2026-05-07T12:00:00Z',
        reason: `Auth failed for token ${token} at C:\\Users\\person\\token.json`,
    });
    assert.ok(result.includes('[REDACTED_TOKEN]'));
    assert.ok(result.includes('[REDACTED_PATH]'));
    assert.ok(!result.includes('abcDEF'));
    assert.ok(!result.includes('C:\\Users'));
});

test('[service-status] redactErrorMessage: redacts URLs including private hostnames', () => {
    assert.equal(
        redactErrorMessage('Request to https://api.internal.example/v2/contacts failed'),
        'Request to [REDACTED_URL] failed'
    );
    assert.equal(
        redactErrorMessage('Connection refused by sync.internal-host:443'),
        'Connection refused by [REDACTED_HOST]'
    );
});

test('[service-status] redactErrorMessage: truncates long messages', () => {
    const long = 'x'.repeat(300);
    const result = redactErrorMessage(long);
    assert.ok(result.length <= 160);
});

test('[service-status] redactErrorMessage: redacts stack traces', () => {
    const msg = 'Error: boom\n    at Object.<anonymous> (/app/index.js:10:5)\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)';
    const result = redactErrorMessage(msg);
    assert.ok(!result.includes('/app/index.js'));
    assert.ok(!result.includes('at Module'));
});

test('[service-status] redactErrorMessage: handles null/undefined', () => {
    assert.equal(redactErrorMessage(null), null);
    assert.equal(redactErrorMessage(undefined), null);
    assert.equal(redactErrorMessage(''), null);
});

// ---------------------------------------------------------------------------
// classifySourceHealth
// ---------------------------------------------------------------------------

test('[service-status] classifySourceHealth: computes deterministic fresh age from injected clock', () => {
    const now = new Date('2026-05-07T12:00:00.000Z');
    const result = classifySourceHealth({ status: 'ok', lastSyncAt: '2026-05-07T09:30:00.000Z' }, now);
    assert.deepEqual(result, {
        lastSyncAt: '2026-05-07T09:30:00.000Z',
        ageHours: 2.5,
        status: 'fresh',
        errorKind: null,
        safeMessage: null,
    });
});

test('[service-status] classifySourceHealth: returns explicit missing state for absent source entry', () => {
    assert.deepEqual(classifySourceHealth(null, new Date('2026-05-07T12:00:00.000Z')), {
        lastSyncAt: null,
        ageHours: null,
        status: 'missing',
        errorKind: null,
        safeMessage: 'No sync state recorded',
    });
});

test('[service-status] classifySourceHealth: rejects invalid timestamps without NaN age', () => {
    assert.deepEqual(classifySourceHealth({ status: 'ok', lastSyncAt: 'not-a-date' }, new Date('2026-05-07T12:00:00.000Z')), {
        lastSyncAt: 'not-a-date',
        ageHours: null,
        status: 'missing',
        errorKind: 'invalid_timestamp',
        safeMessage: 'Invalid sync timestamp',
    });
});

test('[service-status] classifySourceHealth: rejects normalized calendar and timezone-naive timestamps', () => {
    const now = new Date('2026-05-07T12:00:00.000Z');
    for (const lastSyncAt of ['2026-02-30T10:00:00.000Z', '2026-05-07T10:00:00']) {
        assert.deepEqual(classifySourceHealth({ status: 'ok', lastSyncAt }, now), {
            lastSyncAt,
            ageHours: null,
            status: 'missing',
            errorKind: 'invalid_timestamp',
            safeMessage: 'Invalid sync timestamp',
        });
    }
});

test('[service-status] classifySourceHealth: uses legacy freshness timestamp fields', () => {
    const now = new Date('2026-05-07T12:00:00.000Z');
    const result = classifySourceHealth({ status: 'ok', lastSync: '2026-05-07T10:00:00.000Z' }, now);
    assert.equal(result.lastSyncAt, '2026-05-07T10:00:00.000Z');
    assert.equal(result.ageHours, 2);
    assert.equal(result.status, 'fresh');
});

test('[service-status] classifySourceHealth: rejects future timestamps as clock skew', () => {
    const now = new Date('2026-05-07T12:00:00.000Z');
    assert.deepEqual(classifySourceHealth({ status: 'ok', lastSyncAt: '2026-05-07T13:00:00.000Z' }, now), {
        lastSyncAt: '2026-05-07T13:00:00.000Z',
        ageHours: null,
        status: 'missing',
        errorKind: 'future_timestamp',
        safeMessage: 'Sync timestamp is in the future',
    });
});

// ---------------------------------------------------------------------------
// buildStatus: sourceHealth
// ---------------------------------------------------------------------------

test('[service-status] buildStatus: sourceHealth with fresh source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const now = new Date();
    const oneHourAgo = new Date(now - 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), JSON.stringify({
        email: { status: 'ok', lastSyncAt: oneHourAgo },
    }));
    const s = buildStatus(tmp);
    assert.ok(s.sourceHealth);
    assert.ok(s.sourceHealth.email);
    assert.equal(s.sourceHealth.email.status, 'fresh');
    assert.equal(s.sourceHealth.whatsapp.status, 'missing');
    assert.equal(s.sourceHealth.whatsapp.safeMessage, 'No sync state recorded');
    assert.equal(s.sourceHealth.email.lastSyncAt, oneHourAgo);
    assert.equal(typeof s.sourceHealth.email.ageHours, 'number');
    assert.ok(s.sourceHealth.email.ageHours >= 0 && s.sourceHealth.email.ageHours <= 2);
    assert.equal(s.sourceHealth.email.errorKind, null);
    assert.equal(s.sourceHealth.email.safeMessage, null);
    // backward compat: sources still present
    assert.equal(s.sources.email.status, 'ok');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: sourceHealth with stale source (>24h)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), JSON.stringify({
        whatsapp: { status: 'ok', lastSyncAt: twoDaysAgo },
    }));
    const s = buildStatus(tmp);
    assert.equal(s.sourceHealth.whatsapp.status, 'stale');
    assert.ok(s.sourceHealth.whatsapp.ageHours >= 47);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: sourceHealth with error source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const recentSync = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), JSON.stringify({
        googleContacts: {
            status: 'error',
            lastSyncAt: recentSync,
            lastError: 'Auth failed for user@corp.com at /home/deploy/.tokens/gc.json',
        },
    }));
    const s = buildStatus(tmp);
    assert.equal(s.sourceHealth.googleContacts.status, 'failing');
    assert.equal(s.sourceHealth.googleContacts.errorKind, 'sync_error');
    assert.ok(s.sourceHealth.googleContacts.safeMessage);
    assert.ok(!s.sourceHealth.googleContacts.safeMessage.includes('user@corp.com'));
    assert.ok(!s.sourceHealth.googleContacts.safeMessage.includes('/home/deploy'));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: sourceHealth with never-synced source', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmp, 'sync-state.json'), JSON.stringify({
        whatsapp: { status: 'idle', lastSyncAt: null },
    }));
    const s = buildStatus(tmp);
    assert.equal(s.sourceHealth.whatsapp.status, 'never-synced');
    assert.equal(s.sourceHealth.whatsapp.lastSyncAt, null);
    assert.equal(s.sourceHealth.whatsapp.ageHours, null);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] buildStatus: sourceHealth missing when no sync-state', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const s = buildStatus(tmp);
    assert.equal(s.sourceHealth, undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[service-status] formatTty: basic output', () => {
    const s = {
        dataDir: '/tmp/data',
        running: true,
        pid: 1234,
        startedAt: '2025-01-01T00:00:00Z',
        uuid: 'u1',
    };
    const out = formatTty(s);
    assert.ok(out.includes('running'));
    assert.ok(out.includes('1234'));
    assert.ok(out.includes('u1'));
});

test('[service-status] formatTty: stopped service', () => {
    const s = { dataDir: '/tmp/data', running: false, pid: null, startedAt: null };
    const out = formatTty(s);
    assert.ok(out.includes('stopped'));
});
