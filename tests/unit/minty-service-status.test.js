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
