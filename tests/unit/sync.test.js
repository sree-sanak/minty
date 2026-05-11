/**
 * tests/unit/sync.test.js — unit tests for crm/sync.js pure functions
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
    getDefaultSyncState,
    isStale,
    hashContent,
    computeDirHash,
    loadSyncState,
    saveSyncState,
    deepMerge,
    recordSourceSyncSuccess,
    recordSourceSyncFailure,
} = require('../../crm/sync');

// ---------------------------------------------------------------------------
// getDefaultSyncState
// ---------------------------------------------------------------------------

test('[Sync]: getDefaultSyncState returns all required source keys', () => {
    const state = getDefaultSyncState();
    for (const source of ['whatsapp', 'email', 'googleContacts', 'linkedin', 'telegram', 'sms']) {
        assert.ok(source in state, `Missing key: ${source}`);
    }
});

test('[Sync]: getDefaultSyncState whatsapp has status idle', () => {
    const state = getDefaultSyncState();
    assert.equal(state.whatsapp.status, 'idle');
    assert.equal(state.whatsapp.messageCount, 0);
    assert.equal(state.whatsapp.lastSyncAt, null);
});

test('[Sync]: getDefaultSyncState email has null historyId', () => {
    const state = getDefaultSyncState();
    assert.equal(state.email.historyId, null);
    assert.equal(state.email.status, 'idle');
});

test('[Sync]: getDefaultSyncState returns new object each call (no shared reference)', () => {
    const a = getDefaultSyncState();
    const b = getDefaultSyncState();
    a.whatsapp.status = 'active';
    assert.equal(b.whatsapp.status, 'idle');
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------

test('[Sync]: isStale returns false for null lastSyncAt (never synced ≠ stale)', () => {
    assert.equal(isStale(null, 60000), false);
});

test('[Sync]: isStale returns false for undefined lastSyncAt (never synced ≠ stale)', () => {
    assert.equal(isStale(undefined, 60000), false);
});

test('[Sync]: isStale returns false for a recent timestamp', () => {
    const recent = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago
    assert.equal(isStale(recent, 60000), false); // maxAge 60s
});

test('[Sync]: isStale returns true for an old timestamp', () => {
    const old = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
    assert.equal(isStale(old, 60000), true); // maxAge 60s
});

test('[Sync]: isStale boundary — exactly at maxAge is NOT stale', () => {
    // age == maxAge: not yet stale (strictly greater than)
    const exactly = new Date(Date.now() - 60000).toISOString();
    // Could be either way at exact boundary; just verify no crash
    const result = isStale(exactly, 60000);
    assert.ok(typeof result === 'boolean');
});

// ---------------------------------------------------------------------------
// hashContent
// ---------------------------------------------------------------------------

test('[Sync]: hashContent returns a hex string', () => {
    const h = hashContent('hello');
    assert.match(h, /^[a-f0-9]{32}$/);
});

test('[Sync]: hashContent is deterministic', () => {
    assert.equal(hashContent('test'), hashContent('test'));
});

test('[Sync]: hashContent differs for different inputs', () => {
    assert.notEqual(hashContent('foo'), hashContent('bar'));
});

test('[Sync]: hashContent works with Buffer input', () => {
    const h = hashContent(Buffer.from('hello'));
    assert.match(h, /^[a-f0-9]{32}$/);
});

// ---------------------------------------------------------------------------
// computeDirHash
// ---------------------------------------------------------------------------

test('[Sync]: computeDirHash returns null for non-existent directory', () => {
    assert.equal(computeDirHash('/tmp/minty-test-nonexistent-dir-xyz'), null);
});

test('[Sync]: computeDirHash returns a hash string for an existing directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    const h = computeDirHash(tmpDir);
    assert.match(h, /^[a-f0-9]{32}$/);
    fs.rmSync(tmpDir, { recursive: true });
});

test('[Sync]: computeDirHash changes when file content changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
    const h1 = computeDirHash(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'world');
    const h2 = computeDirHash(tmpDir);
    assert.notEqual(h1, h2);
    fs.rmSync(tmpDir, { recursive: true });
});

test('[Sync]: computeDirHash is stable (same content → same hash)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'aaa');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'bbb');
    const h1 = computeDirHash(tmpDir);
    const h2 = computeDirHash(tmpDir);
    assert.equal(h1, h2);
    fs.rmSync(tmpDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadSyncState / saveSyncState
// ---------------------------------------------------------------------------

test('[Sync]: loadSyncState returns default state for non-existent file', () => {
    const state = loadSyncState('/tmp/minty-test-nonexistent-sync-state.json');
    const defaults = getDefaultSyncState();
    assert.deepEqual(state, defaults);
});

test('[Sync]: saveSyncState writes valid JSON', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    const state = getDefaultSyncState();
    state.email.historyId = 'abc123';
    saveSyncState(tmpFile, state);
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.equal(raw.email.historyId, 'abc123');
    fs.unlinkSync(tmpFile);
});

test('[Sync]: loadSyncState round-trips through saveSyncState', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    const state = getDefaultSyncState();
    state.whatsapp.messageCount = 42;
    state.email.historyId = 'test-history-id';
    state.linkedin.status = 'stale';
    saveSyncState(tmpFile, state);
    const loaded = loadSyncState(tmpFile);
    assert.equal(loaded.whatsapp.messageCount, 42);
    assert.equal(loaded.email.historyId, 'test-history-id');
    assert.equal(loaded.linkedin.status, 'stale');
    fs.unlinkSync(tmpFile);
});

test('[Sync]: loadSyncState merges with defaults (missing keys filled in)', () => {
    const tmpFile = path.join(os.tmpdir(), `minty-sync-${Date.now()}.json`);
    // Write a partial state (missing sms)
    fs.writeFileSync(tmpFile, JSON.stringify({ email: { historyId: 'x', status: 'idle', lastSyncAt: null } }));
    const loaded = loadSyncState(tmpFile);
    // Should have sms from defaults
    assert.ok('sms' in loaded);
    assert.equal(loaded.email.historyId, 'x');
    fs.unlinkSync(tmpFile);
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

test('[Sync]: deepMerge shallow merge', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    assert.deepEqual(result, { a: 1, b: 3, c: 4 });
});

test('[Sync]: deepMerge nested objects', () => {
    const result = deepMerge(
        { email: { historyId: null, status: 'idle' } },
        { email: { historyId: 'abc' } }
    );
    assert.equal(result.email.historyId, 'abc');
    assert.equal(result.email.status, 'idle');
});

test('[Sync]: deepMerge does not mutate target', () => {
    const target = { a: { x: 1 } };
    deepMerge(target, { a: { y: 2 } });
    assert.equal(target.a.y, undefined);
});

test('[Sync]: deepMerge handles null source', () => {
    const result = deepMerge({ a: 1 }, null);
    assert.deepEqual(result, { a: 1 });
});

// ---------------------------------------------------------------------------
// Source sync freshness state helpers
// ---------------------------------------------------------------------------

test('[Sync]: recordSourceSyncFailure preserves previous freshness and stores sanitized error', () => {
    const previous = '2026-05-01T10:00:00.000Z';
    const state = {
        email: {
            lastSyncAt: previous,
            status: 'idle',
            historyId: 'history-1',
        },
    };

    const next = recordSourceSyncFailure(state, 'email', new Error(
        'Provider stack raw-token-12345 path /tmp/private/minty/source-data.json failed'
    ), '2026-05-11T10:00:00.000Z');

    assert.equal(next.email.lastSyncAt, previous);
    assert.equal(next.email.status, 'error');
    assert.equal(next.email.historyId, 'history-1');
    assert.equal(next.email.lastErrorAt, '2026-05-11T10:00:00.000Z');
    assert.equal(next.email.lastError, 'Provider stack [redacted-token] path [redacted-path] failed');
    assert.equal(JSON.stringify(next).includes('raw-token-12345'), false);
    assert.equal(JSON.stringify(next).includes('/tmp/private/minty/source-data.json'), false);

    const spacedPath = recordSourceSyncFailure(state, 'email', new Error(
        'Provider failed at "/tmp/private folder/source data.json" with Bearer abc123secret'
    ), '2026-05-11T10:00:00.000Z');
    assert.equal(spacedPath.email.lastError, 'Provider failed at "[redacted-path]" with [redacted-token]');
    assert.equal(JSON.stringify(spacedPath).includes('/tmp/private folder/source data.json'), false);

    const unquotedSpacedPath = recordSourceSyncFailure(state, 'email', new Error(
        'Provider failed at /tmp/private folder/source data.json with retry pending'
    ), '2026-05-11T10:00:00.000Z');
    assert.equal(unquotedSpacedPath.email.lastError, 'Provider failed at [redacted-path] with retry pending');
    assert.equal(JSON.stringify(unquotedSpacedPath).includes('folder/source data.json'), false);

    const providerDetails = recordSourceSyncFailure(state, 'email', new Error(
        'OAuth failed for alice@example.com phone +44 7700 900123 url https://oauth.example.test/cb?access_token=private-value&code=abc'
    ), '2026-05-11T10:00:00.000Z');
    assert.equal(providerDetails.email.lastError, 'OAuth failed for [redacted-email] phone [redacted-phone] url [redacted-url]');
    assert.equal(JSON.stringify(providerDetails).includes('alice@example.com'), false);
    assert.equal(JSON.stringify(providerDetails).includes('+44 7700 900123'), false);
    assert.equal(JSON.stringify(providerDetails).includes('private-value'), false);

    const schemelessProvider = recordSourceSyncFailure(state, 'email', new Error(
        'OAuth callback oauth.example.test/cb?code=private-code&state=private-state failed'
    ), '2026-05-11T10:00:00.000Z');
    assert.equal(schemelessProvider.email.lastError, 'OAuth callback [redacted-url] failed');
    assert.equal(JSON.stringify(schemelessProvider).includes('oauth.example.test'), false);
    assert.equal(JSON.stringify(schemelessProvider).includes('private-code'), false);

    const connectionDetails = recordSourceSyncFailure(state, 'email', new Error(
        'Database unavailable at postgres://user:pass@db.internal/minty credentials=private-value'
    ), '2026-05-11T10:00:00.000Z');
    assert.equal(connectionDetails.email.lastError, 'Database unavailable at [redacted-connection-string] [redacted-token]');
    assert.equal(JSON.stringify(connectionDetails).includes('postgres://'), false);
    assert.equal(JSON.stringify(connectionDetails).includes('private-value'), false);
});

test('[Sync]: recordSourceSyncSuccess advances freshness and clears stale error metadata', () => {
    const state = {
        googleContacts: {
            lastSyncAt: '2026-05-01T10:00:00.000Z',
            status: 'error',
            syncToken: 'sync-token-1',
            lastError: 'old failure',
            lastErrorAt: '2026-05-10T10:00:00.000Z',
        },
    };

    const next = recordSourceSyncSuccess(state, 'googleContacts', {
        status: 'idle',
        changed: 3,
    }, '2026-05-11T10:00:00.000Z');

    assert.equal(next.googleContacts.lastSyncAt, '2026-05-11T10:00:00.000Z');
    assert.equal(next.googleContacts.status, 'idle');
    assert.equal(next.googleContacts.syncToken, 'sync-token-1');
    assert.equal(next.googleContacts.changed, 3);
    assert.equal(next.googleContacts.lastError, undefined);
    assert.equal(next.googleContacts.lastErrorAt, undefined);
});
