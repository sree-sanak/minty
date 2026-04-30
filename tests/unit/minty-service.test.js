'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    resolveDataDir,
    resolveUuid,
    resolveUserDataDir,
    resolveGbrainInterval,
} = require('../../scripts/minty-service');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// resolveDataDir
// ---------------------------------------------------------------------------

test('[minty-service] resolveDataDir: --data-dir flag wins', () => {
    const argv = ['node', 'service.js', '--data-dir', '/tmp/custom'];
    assert.equal(resolveDataDir(argv, {}), '/tmp/custom');
});

test('[minty-service] resolveDataDir: CRM_DATA_DIR env fallback', () => {
    const argv = ['node', 'service.js'];
    assert.equal(resolveDataDir(argv, { CRM_DATA_DIR: '/tmp/env-dir' }), '/tmp/env-dir');
});

test('[minty-service] resolveDataDir: MINTY_DEMO=1 uses data-demo', () => {
    const argv = ['node', 'service.js'];
    const result = resolveDataDir(argv, { MINTY_DEMO: '1' });
    assert.equal(result, path.join(ROOT, 'data-demo'));
});

test('[minty-service] resolveDataDir: default is data/', () => {
    const argv = ['node', 'service.js'];
    const result = resolveDataDir(argv, {});
    assert.equal(result, path.join(ROOT, 'data'));
});

test('[minty-service] resolveDataDir: --data-dir beats CRM_DATA_DIR', () => {
    const argv = ['node', 'service.js', '--data-dir', '/a'];
    assert.equal(resolveDataDir(argv, { CRM_DATA_DIR: '/b' }), '/a');
});

// ---------------------------------------------------------------------------
// resolveUuid
// ---------------------------------------------------------------------------

test('[minty-service] resolveUuid: --uuid flag wins', () => {
    const argv = ['node', 'service.js', '--uuid', 'abc-123'];
    assert.equal(resolveUuid(argv, {}), 'abc-123');
});

test('[minty-service] resolveUuid: MINTY_USER_UUID env fallback', () => {
    const argv = ['node', 'service.js'];
    assert.equal(resolveUuid(argv, { MINTY_USER_UUID: 'env-uuid' }), 'env-uuid');
});

test('[minty-service] resolveUuid: default is single-user', () => {
    const argv = ['node', 'service.js'];
    assert.equal(resolveUuid(argv, {}), 'single-user');
});

test('[minty-service] resolveUuid: --uuid beats env', () => {
    const argv = ['node', 'service.js', '--uuid', 'flag'];
    assert.equal(resolveUuid(argv, { MINTY_USER_UUID: 'env' }), 'flag');
});

// ---------------------------------------------------------------------------
// resolveUserDataDir
// ---------------------------------------------------------------------------

test('[minty-service] resolveUserDataDir: uses users/<uuid> when it exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    const usersDir = path.join(tmp, 'users', 'u1');
    fs.mkdirSync(usersDir, { recursive: true });
    assert.equal(resolveUserDataDir(tmp, 'u1'), usersDir);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('[minty-service] resolveUserDataDir: falls back to dataDir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-test-'));
    assert.equal(resolveUserDataDir(tmp, 'missing'), tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveGbrainInterval
// ---------------------------------------------------------------------------

test('[minty-service] resolveGbrainInterval: default is 6 hours', () => {
    assert.equal(resolveGbrainInterval({}), 6 * 60 * 60 * 1000);
});

test('[minty-service] resolveGbrainInterval: parses env', () => {
    assert.equal(resolveGbrainInterval({ MINTY_GBRAIN_EXPORT_INTERVAL_MS: '30000' }), 30000);
});

test('[minty-service] resolveGbrainInterval: invalid falls back to default', () => {
    assert.equal(resolveGbrainInterval({ MINTY_GBRAIN_EXPORT_INTERVAL_MS: 'nope' }), 6 * 60 * 60 * 1000);
});

test('[minty-service] resolveGbrainInterval: zero falls back to default', () => {
    assert.equal(resolveGbrainInterval({ MINTY_GBRAIN_EXPORT_INTERVAL_MS: '0' }), 6 * 60 * 60 * 1000);
});

test('[minty-service] resolveGbrainInterval: negative falls back to default', () => {
    assert.equal(resolveGbrainInterval({ MINTY_GBRAIN_EXPORT_INTERVAL_MS: '-1000' }), 6 * 60 * 60 * 1000);
});
