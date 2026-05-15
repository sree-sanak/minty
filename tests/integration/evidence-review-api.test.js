'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../../crm/server');
const { safeContactRef } = require('../../crm/source-events');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seed(dir) {
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [{
        id: 'c_private',
        name: 'Alice Private',
        emails: ['alice@example.com'],
        phones: ['+15550120123'],
        sources: { telegram: { id: 'secret-chat-id', name: 'Secret Group' } },
    }]);
    writeJson(path.join(unified, 'interactions.json'), []);
    writeJson(path.join(unified, 'insights.json'), {});
    writeJson(path.join(unified, 'contact-evidence.json'), {
        c_private: {
            topics: ['defi'],
            sources: ['telegram'],
            topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 2, confidence: 0.7 }],
        },
    });
}

function request(server, urlPath, options = {}) {
    const { port } = server.address();
    return fetch(`http://127.0.0.1:${port}${urlPath}`, options);
}

test('evidence review API returns redacted rows and persists suppression/restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-evidence-review-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    const contactRef = safeContactRef('c_private');
    try {
        const listRes = await request(server, '/api/evidence/review');
        assert.equal(listRes.status, 200);
        const list = await listRes.json();
        assert.equal(list.rows[0].contactRef, contactRef);
        assert.equal(list.rows[0].topic, 'defi');
        const serialized = JSON.stringify(list);
        for (const forbidden of ['c_private', 'alice@example.com', '+15550120123', 'secret-chat-id', 'Secret Group']) {
            assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
        }

        const suppressRes = await request(server, `/api/evidence/review/${encodeURIComponent(contactRef)}/defi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'suppress' }),
        });
        assert.equal(suppressRes.status, 200);
        const suppressPayload = await suppressRes.json();
        assert.equal(suppressPayload.ok, true);
        assert.equal(suppressPayload.row.decision, 'suppressed');

        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'unified', 'evidence-overrides.json'), 'utf8'));
        assert.equal(saved.suppressions[0].contactRef, contactRef);
        assert.equal(saved.suppressions[0].topic, 'defi');
        assert.equal(saved.suppressions[0].decision, 'suppress');
        assert.equal(JSON.stringify(saved).includes('c_private'), false);

        const restoreRes = await request(server, `/api/evidence/review/${encodeURIComponent(contactRef)}/defi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'restore' }),
        });
        assert.equal(restoreRes.status, 200);
        const restored = JSON.parse(fs.readFileSync(path.join(dir, 'unified', 'evidence-overrides.json'), 'utf8'));
        assert.deepEqual(restored.suppressions, []);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('evidence review API rejects arbitrary topics and raw contact ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-evidence-review-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const badTopic = await request(server, `/api/evidence/review/${encodeURIComponent(safeContactRef('c_private'))}/private-codename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'suppress' }),
        });
        assert.equal(badTopic.status, 400);

        const rawId = await request(server, '/api/evidence/review/c_private/defi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'suppress' }),
        });
        assert.equal(rawId.status, 400);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
