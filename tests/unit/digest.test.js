'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock modules BEFORE requiring digest
const mockBuildWarmIntroBriefs = () => [];
require.cache[require.resolve('../../crm/people-graph')] = {
    exports: { buildWarmIntroBriefs: mockBuildWarmIntroBriefs }
};

// Clear digest from require cache so we can re-require with fresh DATA path
function clearDigestCache() {
    const p = require.resolve('../../crm/digest');
    delete require.cache[p];
}

const { contactSummary } = require('../../crm/digest');

test('contactSummary: extracts key fields from full contact', () => {
    const contact = {
        id: 'c1',
        name: 'Alice Smith',
        sources: {
            linkedin: { position: 'Engineer', company: 'Acme' },
        },
        relationshipScore: 75,
        daysSinceContact: 10,
        activeChannels: ['whatsapp'],
        lastContactedAt: '2026-04-20T00:00:00.000Z',
    };
    const summary = contactSummary(contact);
    assert.equal(summary.id, 'c1');
    assert.equal(summary.name, 'Alice Smith');
    assert.equal(summary.position, 'Engineer');
    assert.equal(summary.company, 'Acme');
    assert.equal(summary.relationshipScore, 75);
    assert.equal(summary.daysSinceContact, 10);
    assert.deepEqual(summary.activeChannels, ['whatsapp']);
    assert.equal(summary.lastContactedAt, '2026-04-20T00:00:00.000Z');
});

test('contactSummary: falls back to googleContacts title/org when linkedin missing', () => {
    const contact = {
        id: 'c2',
        name: 'Bob Jones',
        sources: { googleContacts: { title: 'Manager', org: 'Corp' } },
        relationshipScore: 60,
    };
    const summary = contactSummary(contact);
    assert.equal(summary.position, 'Manager');
    assert.equal(summary.company, 'Corp');
});

test('contactSummary: returns null for missing fields', () => {
    const contact = { id: 'c3', name: 'No Data' };
    const summary = contactSummary(contact);
    assert.equal(summary.position, null);
    assert.equal(summary.company, null);
    assert.equal(summary.relationshipScore, 0);
    assert.equal(summary.daysSinceContact, null);
    assert.deepEqual(summary.activeChannels, []);
    assert.equal(summary.lastContactedAt, null);
});

test('contactSummary: handles contact with no sources at all', () => {
    const contact = { id: 'c4', name: 'Anon' };
    const summary = contactSummary(contact);
    assert.equal(summary.position, null);
    assert.equal(summary.company, null);
});

test('contactSummary: handles contact with empty sources object', () => {
    const contact = { id: 'c5', name: 'Empty', sources: {} };
    const summary = contactSummary(contact);
    assert.equal(summary.position, null);
    assert.equal(summary.company, null);
});

// --- Algorithmic pipeline tests (isolated via temp data dir) ---

function makeContact(overrides) {
    return {
        id: 'x',
        name: 'X',
        relationshipScore: 0,
        daysSinceContact: null,
        activeChannels: [],
        lastContactedAt: null,
        isGroup: false,
        ...overrides,
    };
}

function runDigest(contacts, interactions, insights) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
    const unifiedDir = path.join(tmp, 'unified');
    fs.mkdirSync(unifiedDir, { recursive: true });
    fs.writeFileSync(path.join(unifiedDir, 'contacts.json'), JSON.stringify(contacts));
    if (interactions !== undefined) {
        fs.writeFileSync(path.join(unifiedDir, 'interactions.json'), JSON.stringify(interactions));
    }
    if (insights !== undefined) {
        fs.writeFileSync(path.join(unifiedDir, 'insights.json'), JSON.stringify(insights));
    }
    // Mock group-memberships to empty to avoid hitting people-graph with temp data
    fs.writeFileSync(path.join(unifiedDir, 'group-memberships.json'), JSON.stringify({}));

    const prevData = process.env.CRM_DATA_DIR;
    process.env.CRM_DATA_DIR = tmp;

    const digestPath = require.resolve('../../crm/digest');
    delete require.cache[digestPath];
    // Need to re-require people-graph mock too
    require.cache[require.resolve('../../crm/people-graph')] = {
        exports: { buildWarmIntroBriefs: () => [] }
    };

    const { run } = require('../../crm/digest');
    try { run(); } catch (e) { /* run() calls process.exit on missing contacts */ }

    const digest = JSON.parse(fs.readFileSync(path.join(unifiedDir, 'digest.json'), 'utf8'));

    if (prevData === undefined) delete process.env.CRM_DATA_DIR;
    else process.env.CRM_DATA_DIR = prevData;

    fs.rmSync(tmp, { recursive: true, force: true });
    return digest;
}

test('run: filters out groups and unnamed contacts', () => {
    const contacts = [
        makeContact({ id: 'p1', name: 'Alice', relationshipScore: 80 }),
        makeContact({ id: 'g1', name: 'Family Chat', isGroup: true, relationshipScore: 99 }),
        makeContact({ id: 'p2', name: '', relationshipScore: 70 }),
        makeContact({ id: 'p3' }), // no name
    ];
    const digest = runDigest(contacts);
    const ids = digest.strongRelationships.map(c => c.id);
    const allIds = [...digest.strongRelationships, ...digest.topReconnects, ...digest.activeThisWeek];
    assert.ok(!ids.includes('g1'), 'group should be excluded');
    assert.ok(!allIds.find(c => c.id === 'p2'), 'unnamed excluded');
    assert.ok(!allIds.find(c => c.id === 'p3'), 'no-name excluded');
    assert.deepEqual(ids, ['p1']);
});

test('run: topReconnects selects score>=50 and days>=60', () => {
    const now = Date.now();
    const contacts = [
        makeContact({ id: 'hi-score-yes', relationshipScore: 80, daysSinceContact: 90 }),
        makeContact({ id: 'hi-score-no', relationshipScore: 80, daysSinceContact: 30 }),
        makeContact({ id: 'lo-score-yes', relationshipScore: 55, daysSinceContact: 70 }),
        makeContact({ id: 'lo-score-no', relationshipScore: 40, daysSinceContact: 90 }),
    ];
    const digest = runDigest(contacts);
    const ids = digest.topReconnects.map(c => c.id);
    assert.ok(ids.includes('hi-score-yes'), 'high score + long gap');
    assert.ok(ids.includes('lo-score-yes'), 'borderline score + long gap');
    assert.ok(!ids.includes('hi-score-no'), 'high score but short gap');
    assert.ok(!ids.includes('lo-score-no'), 'low score even with long gap');
});

test('run: activeThisWeek selects contacts contacted in last 7 days', () => {
    const now = Date.now();
    const ms7 = 7 * 24 * 60 * 60 * 1000;
    const contacts = [
        makeContact({ id: 'recent', lastContactedAt: new Date(now - ms7 + 1000).toISOString(), relationshipScore: 60 }),
        makeContact({ id: 'old', lastContactedAt: new Date(now - ms7 - 1000).toISOString(), relationshipScore: 70 }),
        makeContact({ id: 'never', lastContactedAt: null, relationshipScore: 80 }),
    ];
    const digest = runDigest(contacts);
    const ids = digest.activeThisWeek.map(c => c.id);
    assert.ok(ids.includes('recent'), 'contacted within 7 days');
    assert.ok(!ids.includes('old'), 'contacted more than 7 days ago');
    assert.ok(!ids.includes('never'), 'never contacted');
});

test('run: strongRelationships selects score>=70 sorted descending', () => {
    const contacts = [
        makeContact({ id: 'strongest', relationshipScore: 95 }),
        makeContact({ id: 'strong', relationshipScore: 75 }),
        makeContact({ id: 'medium', relationshipScore: 60 }),
    ];
    const digest = runDigest(contacts);
    const ids = digest.strongRelationships.map(c => c.id);
    assert.deepEqual(ids, ['strongest', 'strong']);
});

test('run: openLoops pulled from insights.json, sorted by score', () => {
    const contacts = [
        makeContact({ id: 'alice', name: 'Alice', relationshipScore: 80 }),
        makeContact({ id: 'bob', name: 'Bob', relationshipScore: 55 }),
    ];
    const insights = {
        alice: { openLoops: ['Send the doc'] },
        bob: { openLoops: ['Coffee next week'] },
    };
    const digest = runDigest(contacts, undefined, insights);
    assert.equal(digest.openLoops.length, 2);
    assert.equal(digest.openLoops[0].contactId, 'alice');
    assert.equal(digest.openLoops[0].loop, 'Send the doc');
    assert.equal(digest.openLoops[1].contactId, 'bob');
});

test('run: networkStats counts total, strong, atRisk, dormant', () => {
    const contacts = [
        makeContact({ id: 's1', relationshipScore: 80, daysSinceContact: 30 }),    // strong, recently contacted
        makeContact({ id: 's2', relationshipScore: 75, daysSinceContact: 10 }),    // strong, recently contacted
        makeContact({ id: 'a1', relationshipScore: 60, daysSinceContact: 70 }),    // at-risk: score>=50, days>=60
        makeContact({ id: 'd1', relationshipScore: 10 }),                           // dormant
        makeContact({ id: 'd2', relationshipScore: 5 }),                           // dormant
    ];
    const digest = runDigest(contacts);
    assert.equal(digest.networkStats.total, 5);
    assert.equal(digest.networkStats.strong, 2);
    assert.equal(digest.networkStats.atRisk, 1);
    assert.equal(digest.networkStats.dormant, 2);
});

test('run: topReconnects capped at 8, sorted by score*days desc', () => {
    const contacts = Array.from({ length: 12 }, (_, i) =>
        makeContact({ id: `c${i}`, relationshipScore: 90 - i, daysSinceContact: 60 + i * 5 })
    );
    const digest = runDigest(contacts);
    assert.ok(digest.topReconnects.length <= 8, 'max 8 reconnects');
    // Verify descending sort
    for (let i = 1; i < digest.topReconnects.length; i++) {
        const prev = digest.topReconnects[i - 1];
        const curr = digest.topReconnects[i];
        const prevScore = (prev.relationshipScore || 0) * (prev.daysSinceContact || 0);
        const currScore = (curr.relationshipScore || 0) * (curr.daysSinceContact || 0);
        assert.ok(prevScore >= currScore, `index ${i-1} should rank >= index ${i}`);
    }
});

test('run: activeThisWeek capped at 10, sorted by score desc', () => {
    const now = Date.now();
    const ms7 = 7 * 24 * 60 * 60 * 1000;
    const contacts = Array.from({ length: 15 }, (_, i) =>
        makeContact({
            id: `c${i}`,
            lastContactedAt: new Date(now - 1000).toISOString(),
            relationshipScore: 100 - i,
        })
    );
    const digest = runDigest(contacts);
    assert.ok(digest.activeThisWeek.length <= 10, 'max 10 active');
    for (let i = 1; i < digest.activeThisWeek.length; i++) {
        const prev = digest.activeThisWeek[i - 1];
        const curr = digest.activeThisWeek[i];
        assert.ok(prev.relationshipScore >= curr.relationshipScore, 'descending by score');
    }
});

test('run: contactSummary embedded in each digest contact entry', () => {
    const contacts = [
        makeContact({
            id: 'alice',
            name: 'Alice',
            sources: { linkedin: { position: 'CEO', company: 'Startup' } },
            relationshipScore: 85,
            daysSinceContact: 65,
            activeChannels: ['whatsapp', 'email'],
            lastContactedAt: '2026-04-25T00:00:00.000Z',
        }),
    ];
    const digest = runDigest(contacts);
    const entry = digest.topReconnects[0];
    assert.equal(entry.id, 'alice');
    assert.equal(entry.name, 'Alice');
    assert.equal(entry.position, 'CEO');
    assert.equal(entry.company, 'Startup');
    assert.equal(entry.relationshipScore, 85);
    assert.equal(entry.daysSinceContact, 65);
    assert.deepEqual(entry.activeChannels, ['whatsapp', 'email']);
    assert.equal(entry.lastContactedAt, '2026-04-25T00:00:00.000Z');
});
