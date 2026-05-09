const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'crm/server.js');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seedDataDir(dir, interactions = []) {
    const unified = path.join(dir, 'unified');
    const now = new Date().toISOString();
    writeJson(path.join(unified, 'contacts.json'), [
        {
            id: 'wa_12065550100',
            name: 'Sam García',
            phones: ['12065550100'],
            emails: ['sam@example.com'],
            notes: 'fintech investor monzo seed',
            tags: ['fintech', 'investor'],
            sources: {
                whatsapp: { id: '12065550100@c.us' },
                linkedin: { company: 'Index Ventures', position: 'Partner', name: 'Sam García' },
                googleContacts: null,
            },
            lastContactedAt: now,
            daysSinceContact: 0,
            relationshipScore: 91,
            interactionCount: 3,
            activeChannels: ['whatsapp'],
            isGroup: false,
        },
    ]);
    writeJson(path.join(unified, 'interactions.json'), interactions);
    writeJson(path.join(unified, 'insights.json'), {});
    writeJson(path.join(unified, 'goals.json'), [
        { id: 'g_1', text: 'find fintech investors for a seed raise', active: true, assignments: {} },
    ]);
    writeJson(path.join(unified, 'meetings.json'), []);
    writeJson(path.join(unified, 'calendar-state.json'), {});
    writeJson(path.join(unified, 'match_overrides.json'), [
        {
            confidence: 'possible',
            ids: ['wa_12065550100', 'li_sam_garcia'],
            names: ['Sam García', 'Sam García'],
            reason: 'same normalized name',
            sourceA: 'whatsapp',
            sourceB: 'linkedin',
            score: 0,
            suggestedConfidence: 'confirmed',
        },
    ]);
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function waitForReady(child, port) {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`server did not start on ${port}: ${output}`)), 10000);
        const onData = (buf) => {
            output += String(buf);
            if (output.includes('Minty is running')) {
                clearTimeout(timer);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited early with ${code}: ${output}`));
        });
    });
}

async function withServer(dataDir, fn) {
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        await waitForReady(child, port);
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        child.kill('SIGTERM');
    }
}

test('GET /api/today preserves zero-day contact recency', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-today-'));
    seedDataDir(dir, [
        { id: 'm1', source: 'whatsapp', chatId: '12065550100@c.us', from: '12065550100@c.us', body: 'sent today', timestamp: new Date().toISOString() },
    ]);

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/today`);
        assert.equal(res.status, 200);
        const payload = await res.json();
        const contact = payload.goalSections.flatMap(s => s.contacts).find(c => c.id === 'wa_12065550100');
        assert.ok(contact, 'expected goal contact in today response');
        assert.equal(contact.daysSinceContact, 0);
    });
});

test('malformed interactions.json does not expose raw parser errors on read-only routes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-bad-json-'));
    seedDataDir(dir, []);
    fs.writeFileSync(path.join(dir, 'unified/interactions.json'), '{bad json');

    await withServer(dir, async (base) => {
        for (const url of [
            '/api/search/interactions?q=test',
            '/api/contacts/wa_12065550100/interactions',
            '/api/contacts/wa_12065550100/timeline',
            '/api/goals/g_1/retro',
        ]) {
            const res = await fetch(`${base}${url}`);
            assert.notEqual(res.status, 500, `${url} should not raw-500`);
            const text = await res.text();
            assert.doesNotMatch(text, /Expected property name|JSON at position|SyntaxError/i, `${url} leaked parser text`);
            assert.doesNotMatch(text, /stack|at JSON\.parse/i, `${url} leaked stack text`);
        }
    });
});

test('identity review API rejects prototype decisions and preserves zero score', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-identity-review-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        const pendingRes = await fetch(`${base}/api/pending`);
        assert.equal(pendingRes.status, 200);
        const pending = await pendingRes.json();
        assert.equal(pending.items[0].score, 0);

        for (const decision of ['__proto__', 'constructor', 'toString']) {
            const res = await fetch(`${base}/api/decide`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idx: 0, decision }),
            });
            assert.equal(res.status, 400, `${decision} should be rejected`);
        }

        for (const idx of ['__proto__', 'constructor', 'length', -1, 0.5, '1e0']) {
            const res = await fetch(`${base}/api/decide`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idx, decision: 'same' }),
            });
            assert.equal(res.status, 400, `${idx} idx should be rejected`);
        }
    });
});

test('POST /api/goals/:id/assign rejects dangerous and unknown contactId values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-goal-assign-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        for (const contactId of ['__proto__', 'constructor', 'prototype']) {
            const res = await fetch(`${base}/api/goals/g_1/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactId, stage: 'Contacted' }),
            });
            assert.equal(res.status, 400, `${contactId} should be rejected`);
            const payload = await res.json();
            assert.equal(payload.error, 'invalid contactId');
        }

        for (const contactId of ['nonexistent_42', 123, { id: 'wa_12065550100' }]) {
            const res = await fetch(`${base}/api/goals/g_1/assign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactId, stage: 'Contacted' }),
            });
            assert.equal(res.status, 400, `${JSON.stringify(contactId)} should be rejected`);
            assert.equal((await res.json()).error, 'invalid contactId');
        }
    });
});

test('POST /api/goals/:id/assign allows valid contact and supports removal', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-goal-assign-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        // assign valid contact
        let res = await fetch(`${base}/api/goals/g_1/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId: 'wa_12065550100', stage: 'Contacted' }),
        });
        assert.equal(res.status, 200);
        let payload = await res.json();
        assert.equal(payload.goal.assignments['wa_12065550100'].stage, 'Contacted');

        // remove assignment with null stage
        res = await fetch(`${base}/api/goals/g_1/assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contactId: 'wa_12065550100', stage: null }),
        });
        assert.equal(res.status, 200);
        payload = await res.json();
        assert.equal(payload.goal.assignments['wa_12065550100'], undefined);
    });
});

test('identity review API maps same and always-separate decisions durably', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-identity-review-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        let res = await fetch(`${base}/api/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idx: 0, decision: 'same' }),
        });
        assert.equal(res.status, 200);
        let overrides = JSON.parse(fs.readFileSync(path.join(dir, 'unified/match_overrides.json'), 'utf8'));
        assert.equal(overrides[0].confidence, 'confirmed');
        assert.equal(overrides[0].reviewDecision, 'same');
        assert.ok(overrides[0].reviewedAt);
    });

    seedDataDir(dir, []);
    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idx: 0, decision: 'always-separate' }),
        });
        assert.equal(res.status, 200);
        const overrides = JSON.parse(fs.readFileSync(path.join(dir, 'unified/match_overrides.json'), 'utf8'));
        assert.equal(overrides[0].confidence, 'skip');
        assert.equal(overrides[0].reviewDecision, 'always-separate');
    });
});

test('POST /api/network/query returns agent privacy envelope and redacts direct contact details', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-envelope-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'find sam@example.com or +1 206 555 0100 fintech investor' }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.query, 'find [redacted email] or [redacted phone] fintech investor');
        assert.equal(payload.parsed.raw, payload.query);
        assert.equal(payload.safety.contactDetailsOmitted, true);
        assert.equal(payload.safety.noLlmCalls, true);
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.safety.contactIdsOmitted, true);
        assert.deepEqual(payload.safety.omittedFields, ['emails', 'phones', 'rawContact', 'sourceDerivedContactIds']);
        assert.equal(payload.diagnostics.noData, false);
        assert.equal(payload.diagnostics.resultCount, payload.results.length);
        assert.deepEqual(payload.expandedTerms.filter(term => /sam|example|206|555|0100/.test(term)), []);
        assert.doesNotMatch(JSON.stringify(payload), /sam@example\.com|206 555 0100/);
    });
});

test('POST /api/network/query uses precomputed contact evidence like the agent CLI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-contact-evidence-'));
    seedDataDir(dir, []);
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [
        {
            id: 'c_ev_http',
            name: 'Evidence Only Person',
            phones: ['12065550199'],
            emails: ['evidence@example.com'],
            notes: '',
            tags: [],
            sources: { telegram: { userId: 'tg_1' } },
            lastContactedAt: '2026-04-30T00:00:00.000Z',
            daysSinceContact: 8,
            relationshipScore: 25,
            interactionCount: 0,
            activeChannels: ['telegram'],
            isGroup: false,
        },
        {
            id: 'c_warm_unrelated',
            name: 'Warm Unrelated Person',
            notes: '',
            tags: [],
            sources: { linkedin: { position: 'Finance operator', company: 'BankCo' } },
            lastContactedAt: '2026-05-01T00:00:00.000Z',
            daysSinceContact: 1,
            relationshipScore: 90,
            interactionCount: 40,
            activeChannels: ['linkedin'],
            isGroup: false,
        },
    ]);
    writeJson(path.join(unified, 'contact-evidence.json'), {
        c_ev_http: {
            contactId: 'c_ev_http',
            topics: ['defi', 'lending protocol', 'risk'],
            topicEvidence: [
                { topic: 'defi', count: 2, sources: ['telegram'], lastEvidenceAt: '2026-05-01T00:00:00.000Z' },
                { topic: 'lending protocol', count: 1, sources: ['telegram'], lastEvidenceAt: '2026-05-01T00:00:00.000Z' },
            ],
            sources: ['telegram'],
            interactionCount: 2,
            confidence: 0.75,
        },
    });

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'Who do I know working in DeFi lending protocols?' }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.results[0].name, 'Evidence Only Person');
        assert.match(payload.results[0].id, /^contact:[a-p]+$/);
        assert.ok(payload.results[0].reasons.some(reason => reason.kind === 'contact_evidence'));
        assert.equal(payload.diagnostics.contactEvidenceContacts, 1);
        assert.equal(payload.diagnostics.evidenceBacked, true);
        assert.doesNotMatch(JSON.stringify(payload), /c_ev_http|12065550199|evidence@example\.com|2026-05-01/);
    });
});

test('POST /api/network/query does not turn contact-detail-only queries into generic results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-detail-only-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'sam@example.com +1 206 555 0100' }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.query, '[redacted email] [redacted phone]');
        assert.deepEqual(payload.results, []);
        assert.equal(payload.diagnostics.resultCount, 0);
        assert.equal(payload.diagnostics.evidenceBacked, false);
        assert.doesNotMatch(JSON.stringify(payload), /Sam García|wa_12065550100|sam@example\.com|206 555 0100/);
    });
});

test('POST /api/network/query diagnostics do not overclaim evidence for generic fallback results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-generic-'));
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [
        {
            id: 'c_generic',
            name: 'Generic Sentinel',
            notes: '',
            tags: [],
            sources: {},
            lastContactedAt: '2025-01-01T00:00:00.000Z',
            daysSinceContact: 400,
            relationshipScore: 42,
            interactionCount: 0,
            activeChannels: [],
            isGroup: false,
        },
    ]);
    writeJson(path.join(unified, 'query-index.json'), [
        {
            id: 'c_generic',
            name: 'Generic Sentinel',
            title: '',
            company: '',
            city: null,
            roles: [],
            seniority: 'ic',
            seniority_rank: 1,
            relationshipScore: 42,
            daysSinceContact: 400,
            interactionCount: 0,
            meetScore: 42,
        },
    ]);
    writeJson(path.join(unified, 'interactions.json'), []);
    writeJson(path.join(unified, 'insights.json'), {});
    writeJson(path.join(unified, 'goals.json'), []);
    writeJson(path.join(unified, 'meetings.json'), []);
    writeJson(path.join(unified, 'calendar-state.json'), {});

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'contacts', includeContactIds: true }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.ok(payload.results.length > 0, 'fixture should return a generic fallback result');
        assert.match(payload.results[0].id, /^contact:[a-p]+$/);
        assert.equal(payload.results[0].contactRef, payload.results[0].id);
        assert.doesNotMatch(JSON.stringify(payload), /c_generic/);
        const contactRes = await fetch(`${base}/api/contacts/${encodeURIComponent(payload.results[0].id)}`);
        assert.equal(contactRes.status, 200, 'trusted UI contact route should resolve safe contact refs');
        const contact = await contactRes.json();
        assert.equal(contact.id, 'c_generic');
        assert.deepEqual(payload.results.map(r => r.reasons), [[]]);
        assert.equal(payload.diagnostics.resultCount, 1);
        assert.equal(payload.diagnostics.evidenceBacked, false);
    });
});

test('POST /api/network/query no-data fallback still requires a query', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-empty-query-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '   ' }),
        });
        assert.equal(res.status, 400);
        const payload = await res.json();
        assert.equal(payload.error, 'query required');
    });
});

test('POST /api/network/query no-data fallback still returns privacy envelope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-network-empty-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/network/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'who knows +44 7700 900123' }),
        });
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.query, 'who knows [redacted phone]');
        assert.deepEqual(payload.results, []);
        assert.equal(payload.safety.contactDetailsOmitted, true);
        assert.equal(payload.safety.noLlmCalls, true);
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.diagnostics.noData, true);
        assert.equal(payload.diagnostics.resultCount, 0);
        assert.doesNotMatch(JSON.stringify(payload), /7700 900123/);
    });
});
