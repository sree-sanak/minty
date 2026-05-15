/**
 * tests/integration/linkedin-api.test.js
 *
 * Integration tests for the three LinkedIn auto-sync API routes:
 *   - GET  /api/linkedin/status
 *   - POST /api/linkedin/sync
 *   - POST /api/linkedin/connect
 *
 * AGENTS.md requires integration tests for every new API route. This file is
 * authored AHEAD of the server.js wiring and has a skeleton → live
 * progression:
 *
 *   Phase A (runnable TODAY): helper-level tests against pure modules —
 *     origin-check.js CSRF guard, sync-state.js round-trip, feature-flag gate
 *     semantics. These exercise the building blocks the endpoints will use.
 *
 *   Phase B (runnable TODAY): env / feature-flag behaviour that does not
 *     require a live HTTP server — we can assert what the gate function
 *     returns when MINTY_LINKEDIN_AUTOSYNC is unset.
 *
 *   Phase C (runnable TODAY with the test-friendly server factory): real
 *     HTTP endpoint assertions via createServer(). The factory was added in
 *     server.js so that requiring the module no longer binds port 3456 as a
 *     side-effect, and each test gets its own synthetic temp data dir.
 *
 * Run today:
 *   node --test tests/integration/linkedin-api.test.js
 *
 * Run all integration tests:
 *   npm run test:integration
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('net');

const originCheck = require('../../sources/linkedin/origin-check.js');
const syncState = require('../../sources/linkedin/sync-state.js');

// ===========================================================================
// Phase A — helper-level coverage (runnable today, no server dependency)
// ===========================================================================

test('[LinkedInAPI/A]: origin-check rejects request with no Origin header (C1 CSRF)', () => {
    // Simulates an attacker-crafted fetch() where no Origin is set and the
    // request lacks Sec-Fetch-Site too — we can't verify same-origin, refuse.
    const req = { headers: { host: 'localhost:3456' }, method: 'POST' };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.reason, 'no-origin-signal');
});

test('[LinkedInAPI/A]: origin-check rejects cross-origin POST even with Sec-Fetch-Site header', () => {
    const req = {
        headers: {
            origin: 'http://evil.example',
            host: 'localhost:3456',
            'sec-fetch-site': 'cross-site',
        },
        method: 'POST',
    };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
});

test('[LinkedInAPI/A]: origin-check accepts same-origin POST (localhost:3456)', () => {
    const req = {
        headers: {
            origin: 'http://localhost:3456',
            host: 'localhost:3456',
        },
        method: 'POST',
    };
    const result = originCheck.requireSameOrigin(req);
    assert.equal(result.ok, true);
});

test('[LinkedInAPI/A]: sync-state happy path (status endpoint payload shape)', () => {
    // Mirrors what GET /api/linkedin/status will read from disk. Verifies the
    // shape the handler will return to the SPA.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-int-'));
    syncState.writeLinkedIn(dir, {
        status: 'connected',
        lastSync: '2026-04-23T10:00:00.000Z',
    });
    const ln = syncState.readLinkedIn(dir);
    assert.equal(ln.status, 'connected');
    assert.equal(ln.lastSync, '2026-04-23T10:00:00.000Z');
    // The full status-endpoint response shape (for the SPA card):
    for (const key of [
        'status',
        'mode',
        'lastConnectAt',
        'lastSync',
        'lastError',
        'progress',
    ]) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(ln, key),
            `expected linkedin state key: ${key}`,
        );
    }
});

// ===========================================================================
// Phase B — feature-flag gate (runnable today, no server dependency)
// ===========================================================================

/**
 * Stand-in for the feature-flag gate that crm/server.js will implement. When
 * server.js lands, it will likely live inside the server file itself or a
 * small `crm/features.js` helper; either way, this test encodes the intended
 * semantics so whoever writes that code has a spec to satisfy.
 */
function linkedInAutoSyncEnabled(env) {
    const e = env || process.env;
    const v = e.MINTY_LINKEDIN_AUTOSYNC;
    return v === '1' || v === 'true';
}

test('[LinkedInAPI/B]: feature flag unset → disabled (server must return 404)', () => {
    const env = {}; // no MINTY_LINKEDIN_AUTOSYNC
    assert.equal(linkedInAutoSyncEnabled(env), false);
});

test('[LinkedInAPI/B]: feature flag "1" → enabled', () => {
    assert.equal(linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: '1' }), true);
});

test('[LinkedInAPI/B]: feature flag "0" → disabled', () => {
    assert.equal(linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: '0' }), false);
});

test('[LinkedInAPI/B]: feature flag "true" → enabled (case-sensitive per spec)', () => {
    assert.equal(
        linkedInAutoSyncEnabled({ MINTY_LINKEDIN_AUTOSYNC: 'true' }),
        true,
    );
});

// ===========================================================================
// Phase C — server factory / require-time side-effect tests
// ===========================================================================

// Hard timeout so a misbehaving server never stalls the test runner.
// Should be redundant with CI `--test-timeout` but catches the case where
// npm test is run without one.
const TEST_TIMEOUT = 10_000; // ms

/** Wrap a promise so it fails fast if it hangs. */
function withTimeout(promise, ms = TEST_TIMEOUT) {
    let handle;
    const timer = new Promise((_, reject) => {
        handle = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

/** Close a test HTTP server and wait until Node releases the handle. */
function closeServer(srv) {
    return new Promise((resolve, reject) => {
        srv.close((err) => (err ? reject(err) : resolve()));
    });
}

/**
 * Verify that requiring crm/server.js does NOT bind port 3456.
 * This is the prerequisite fix that enables live endpoint tests to run.
 * Technique: try to bind the port ourselves; if it succeeds the module
 * didn't claim it.
 */
test('[LinkedInAPI/C]: requiring server.js does NOT bind port 3456 as a side-effect', async () => {
    // Require the module (this used to bind the port at require time)
    require('../../crm/server.js');

    // Now try to claim port 3456 ourselves — if the module bound it, this fails
    await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                // Port is in use — the module claimed it (FAIL)
                reject(new Error('Port 3456 was bound by requiring server.js — factory pattern not working'));
            } else {
                reject(err);
            }
        });
        srv.listen(3456, '127.0.0.1', () => {
            srv.close(() => resolve()); // success — port was free
        });
    });
});

/**
 * Verify createServer() returns a listening net.Server on the requested port.
 */
test('[LinkedInAPI/C]: createServer() returns a server that starts on the given port', { timeout: TEST_TIMEOUT }, async () => {
    const { createServer } = require('../../crm/server.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-li-factory-'));
    fs.mkdirSync(path.join(tmp, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unified', 'contacts.json'), '[]');
    fs.writeFileSync(path.join(tmp, 'unified', 'interactions.json'), '[]');

    const srv = await createServer({ dataDir: tmp, port: 0 });
    assert.ok(srv instanceof net.Server, 'createServer should resolve to an http.Server');

    await withTimeout(new Promise((resolve, reject) => {
        if (srv.listening) { resolve(); return; }
        srv.on('listening', resolve);
        srv.on('error', reject);
    }));

    const { port } = srv.address();
    assert.ok(port > 0, `server should be on a real port, got ${port}`);

    await closeServer(srv);
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** Issue an HTTP request against a listening test server. */
function requestFromServer(srv, requestOptions = {}) {
    const http = require('http');
    const { port } = srv.address();
    const options = {
        host: 'localhost',
        port,
        method: 'GET',
        path: '/',
        ...requestOptions,
    };
    return withTimeout(new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    }));
}

async function withTempLinkedInServer(config, fn) {
    const { createServer } = require('../../crm/server.js');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-li-factory-'));
    fs.mkdirSync(path.join(tmp, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unified', 'contacts.json'), '[]');
    fs.writeFileSync(path.join(tmp, 'unified', 'interactions.json'), '[]');
    if (config) fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));

    const srv = await createServer({ dataDir: tmp, port: 0 });
    try {
        await fn(srv);
    } finally {
        await closeServer(srv);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * Verify that a server started via createServer() responds to GET /api/contacts
 * (the empty-contacts guard is tested by asserting a 200 + [] response).
 */
test('[LinkedInAPI/C]: createServer() server responds to GET /api/contacts with []', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer(null, async (srv) => {
        const res = await requestFromServer(srv, { path: '/api/contacts' });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        assert.deepEqual(JSON.parse(res.body), []);
    });
});

/**
 * Verify that GET /api/linkedin/status is routed through the server factory
 * when the feature flag is enabled (linkedinAutosync=true in config.json).
 * The response must include 'status' and 'playwrightAvailable'.
 */
test('[LinkedInAPI/C]: GET /api/linkedin/status → 200 when linkedinAutosync enabled', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: true }, async (srv) => {
        const res = await requestFromServer(srv, { path: '/api/linkedin/status' });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
        const data = JSON.parse(res.body);
        for (const key of ['status', 'playwrightAvailable']) {
            assert.ok(
                Object.prototype.hasOwnProperty.call(data, key),
                `expected key "${key}" in status response`,
            );
        }
    });
});

/**
 * Verify that GET /api/linkedin/status returns 404 when linkedinAutosync is
 * explicitly disabled (the gate must block the request).
 */
test('[LinkedInAPI/C]: GET /api/linkedin/status → 404 when linkedinAutosync disabled', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: false }, async (srv) => {
        const res = await requestFromServer(srv, { path: '/api/linkedin/status' });
        assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    });
});

/**
 * Verify that POST /api/linkedin/sync returns 404 when the feature flag is
 * disabled (linkedinAutosync=false). The POST gate blocks before any
 * dangerous operation is attempted.
 */
test('[LinkedInAPI/C]: POST /api/linkedin/sync → 404 when linkedinAutosync disabled', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: false }, async (srv) => {
        const res = await requestFromServer(srv, { method: 'POST', path: '/api/linkedin/sync' });
        assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    });
});

/**
 * Verify that POST /api/linkedin/sync returns 403 when a cross-origin request
 * is sent without a valid CSRF token. The origin-check guard is the first
 * line of defence.
 */
test('[LinkedInAPI/C]: POST /api/linkedin/sync → 403 when cross-origin (no valid CSRF token)', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: true }, async (srv) => {
        const { port } = srv.address();
        const res = await requestFromServer(srv, {
            method: 'POST',
            path: '/api/linkedin/sync',
            headers: { Origin: 'http://evil.example', Host: `localhost:${port}` },
        });
        assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
    });
});

/**
 * Verify that POST /api/linkedin/connect returns 404 when the feature flag
 * is disabled (linkedinAutosync=false).
 */
test('[LinkedInAPI/C]: POST /api/linkedin/connect → 404 when linkedinAutosync disabled', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: false }, async (srv) => {
        const res = await requestFromServer(srv, { method: 'POST', path: '/api/linkedin/connect' });
        assert.equal(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.body}`);
    });
});

/**
 * Verify that POST /api/linkedin/connect returns 403 when a cross-origin
 * request is sent without a valid CSRF token.
 */
test('[LinkedInAPI/C]: POST /api/linkedin/connect → 403 when cross-origin (no valid CSRF token)', { timeout: TEST_TIMEOUT }, async () => {
    await withTempLinkedInServer({ linkedinAutosync: true }, async (srv) => {
        const res = await requestFromServer(srv, { method: 'POST', path: '/api/linkedin/connect' });
        assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`);
    });
});
