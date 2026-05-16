'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../../crm/server');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seed(dir) {
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [{
        id: 'raw-contact-source-health',
        name: 'Source Health Sentinel',
        emails: ['source-health-sentinel@example.com'],
        phones: ['raw-phone-555-0101'],
        sources: { telegram: { id: 'raw-source-id-telegram', name: 'Private Telegram Channel' } },
    }]);
    writeJson(path.join(unified, 'interactions.json'), [{
        id: 'raw-interaction-id',
        contactId: 'raw-contact-source-health',
        source: 'telegram',
        timestamp: '2026-05-06T07:30:00Z',
        text: 'private source health message body',
    }]);
    writeJson(path.join(unified, 'insights.json'), {});
    writeJson(path.join(unified, 'contact-evidence.json'), {
        'raw-contact-source-health': {
            topics: ['source-health-topic'],
            sources: ['telegram'],
            topicEvidence: [{ topic: 'source-health-topic', sources: ['telegram'], count: 1, confidence: 0.8 }],
        },
    });
    writeJson(path.join(unified, 'source-events.json'), [{
        source: 'telegram',
        contactId: 'raw-contact-source-health',
        sourceId: 'raw-source-id-telegram',
        detail: 'private source event detail',
        observedAt: '2026-05-06T07:45:00Z',
    }]);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: {
            status: 'ok',
            lastSyncAt: '2026-05-06T07:00:00Z',
            lastError: 'token abc123 at /private/source-health/token.json',
        },
        email: {
            status: 'ok',
            lastSyncAt: '2026-04-01T00:00:00Z',
        },
    });
}

function request(server, urlPath, options = {}) {
    const { port } = server.address();
    return fetch(`http://127.0.0.1:${port}${urlPath}`, options);
}

test('GET /api/source-health returns aggregate source readiness without private data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-source-health-api-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, '/api/source-health?source=telegram&now=2026-05-06T08%3A00%3A00Z');
        assert.equal(res.status, 200);
        const payload = await res.json();

        assert.equal(payload.status, 'warning');
        assert.equal(payload.sources.telegram.status, 'error');
        assert.equal(payload.sources.telegram.contactCount, 1);
        assert.equal(payload.sources.telegram.interactionCount, 1);
        assert.equal(payload.sources.telegram.evidenceContactCount, 1);
        assert.equal(payload.sources.telegram.sourceEventCount, 1);
        assert.deepEqual(payload.sources.telegram.warnings, ['sync_error']);
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.safety.contactDetailsOmitted, true);
        assert.equal(payload.safety.rawRowsOmitted, true);
        assert.equal(payload.safety.tokenPathsOmitted, true);

        const serialized = JSON.stringify(payload);
        for (const forbidden of [
            'raw-contact-source-health',
            'Source Health Sentinel',
            'source-health-sentinel@example.com',
            'raw-phone-555-0101',
            'raw-source-id-telegram',
            'Private Telegram Channel',
            'private source health message body',
            'private source event detail',
            '/private/source-health/token.json',
            'abc123',
        ]) {
            assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('GET /api/source-health invalid source filters fail closed without echoing private input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-source-health-api-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, '/api/source-health?source=telegram,private-channel%40example.com&now=2026-05-06T08%3A00%3A00Z');
        assert.equal(res.status, 200);
        const payload = await res.json();

        assert.equal(payload.status, 'error');
        assert.deepEqual(payload.sources, {});
        assert.deepEqual(payload.invalidSourceFilters, ['invalid']);
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.safety.contactDetailsOmitted, true);
        assert.equal(payload.safety.rawRowsOmitted, true);
        assert.equal(payload.safety.tokenPathsOmitted, true);

        const serialized = JSON.stringify(payload);
        assert.equal(serialized.includes('private-channel@example.com'), false);
        assert.equal(serialized.includes('telegram'), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('GET /api/source-health ignores invalid calendar dates in now query', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-source-health-api-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, '/api/source-health?source=email&now=2026-02-30T00%3A00%3A00Z');
        assert.equal(res.status, 200);
        const payload = await res.json();

        assert.equal(payload.sources.email.freshness, 'stale');
        assert.equal(payload.sources.email.status, 'stale');
        assert.ok(payload.sources.email.warnings.includes('no_recent_sync'));
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
