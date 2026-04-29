'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { queryNetwork } = require('../../crm/agent-retrieval');
const { resolveDataDir, hasContacts } = require('../../scripts/agent-query');

// ---------------------------------------------------------------------------
// Fixtures: minimal but realistic demo-shaped data
// ---------------------------------------------------------------------------

const CONTACTS = [
    {
        id: 'c_001', name: 'Alice Müller',
        sources: { linkedin: { position: 'Partner at EU Insurance Ventures', company: 'EU Insurance Ventures', location: 'Berlin, Germany' } },
        relationshipScore: 72, daysSinceContact: 5, interactionCount: 20, activeChannels: ['email', 'whatsapp'],
        emails: ['alice@euiv.de'], phones: ['+4930123456'],
    },
    {
        id: 'c_002', name: 'Bob Chen',
        sources: { linkedin: { position: 'Crypto Compliance Lead', company: 'ChainGuard', location: 'Zurich, Switzerland' } },
        relationshipScore: 55, daysSinceContact: 30, interactionCount: 8, activeChannels: ['email'],
        emails: ['bob@chainguard.ch'], phones: [],
    },
    {
        id: 'c_003', name: 'Carol Okafor',
        sources: { linkedin: { position: 'Head of Distribution, InsureTech Africa', company: 'InsureTech Africa', location: 'Lagos, Nigeria' } },
        relationshipScore: 30, daysSinceContact: 120, interactionCount: 3, activeChannels: ['linkedin'],
        emails: [], phones: [],
    },
    {
        id: 'c_004', name: 'Dan Petrov',
        sources: { linkedin: { position: 'Software Engineer at Stripe', company: 'Stripe', location: 'London, UK' } },
        relationshipScore: 85, daysSinceContact: 2, interactionCount: 50, activeChannels: ['whatsapp', 'email'],
        emails: ['dan@stripe.com'], phones: ['+447911123456'],
    },
];

const INSIGHTS = {
    c_001: { topics: ['crypto regulation', 'EU insurance distribution', 'Solvency II'] },
    c_002: { topics: ['crypto compliance', 'DeFi insurance', 'Swiss FINMA'] },
    c_003: { topics: ['insurance distribution', 'Africa fintech'] },
    c_004: { topics: ['payments infrastructure', 'Node.js'] },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-retrieval: queryNetwork()', () => {

    it('returns stable schema with query, intent, results, safety', () => {
        const out = queryNetwork('investors in London', { contacts: CONTACTS, insights: INSIGHTS });
        assert.ok(out.query, 'has query');
        assert.ok(out.intent, 'has intent');
        assert.ok(Array.isArray(out.results), 'results is array');
        assert.ok(out.safety, 'has safety');
        assert.equal(typeof out.safety.contactDetailsOmitted, 'boolean');
        assert.equal(out.safety.contactDetailsOmitted, true);
        assert.deepEqual(out.safety.omittedFields, ['emails', 'phones', 'rawContact']);
        assert.equal(typeof out.safety.noLlmCalls, 'boolean');
        assert.equal(out.safety.noLlmCalls, true);
    });

    it('each result has required agent-friendly fields', () => {
        const out = queryNetwork('founders', { contacts: CONTACTS, insights: INSIGHTS });
        for (const r of out.results) {
            assert.ok(r.id, 'has id');
            assert.ok(r.name, 'has name');
            assert.ok('relevance' in r, 'has relevance');
            assert.ok('relationshipScore' in r, 'has relationshipScore');
            assert.ok('warmth' in r, 'has warmth');
            assert.ok('confidence' in r, 'has confidence');
            assert.ok(Array.isArray(r.evidence), 'evidence is array');
            assert.ok('suggestedAction' in r, 'has suggestedAction');
        }
    });

    it('ranks crypto+insurance+EU contacts highest for EU crypto insurance query', () => {
        const out = queryNetwork('Who can help me with EU crypto insurance distribution?', { contacts: CONTACTS, insights: INSIGHTS });
        assert.ok(out.results.length >= 1, 'returns at least 1 result');
        // Alice and Bob should rank above Dan (engineer, no insurance)
        const names = out.results.map(r => r.name);
        const aliceIdx = names.indexOf('Alice Müller');
        const danIdx = names.indexOf('Dan Petrov');
        assert.ok(aliceIdx !== -1, 'Alice is in results');
        if (danIdx !== -1) {
            assert.ok(aliceIdx < danIdx, 'Alice ranks above Dan');
        }
    });

    it('respects limit option', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS, limit: 2 });
        assert.ok(out.results.length <= 2, 'respects limit');
    });

    it('returns empty results for impossible query without crashing', () => {
        const out = queryNetwork('martian astronauts', { contacts: CONTACTS, insights: INSIGHTS });
        assert.deepEqual(out.results, []);
    });

    it('omits direct contact details from the agent envelope', () => {
        const out = queryNetwork('Who can help me with EU crypto insurance distribution?', { contacts: CONTACTS, insights: INSIGHTS });
        for (const r of out.results) {
            assert.equal('emails' in r, false, 'does not expose emails');
            assert.equal('phones' in r, false, 'does not expose phones');
            assert.equal('rawContact' in r, false, 'does not expose raw contact');
        }
    });

    it('normalizes invalid limits to a safe default', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS, limit: -1 });
        assert.ok(out.results.length > 0, 'still returns default-sized result set');
        assert.ok(out.results.length <= 10, 'safe default limit is bounded');
    });

    it('works with empty contacts', () => {
        const out = queryNetwork('anyone', { contacts: [], insights: {} });
        assert.deepEqual(out.results, []);
    });

    it('warmth label reflects relationship score tiers', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS });
        const alice = out.results.find(r => r.id === 'c_001');
        const carol = out.results.find(r => r.id === 'c_003');
        if (alice) assert.ok(['strong', 'warm'].includes(alice.warmth), 'high score = strong/warm');
        if (carol) assert.ok(['cool', 'cold', 'fading'].includes(carol.warmth), 'low score = cool/cold/fading');
    });

    it('suggestedAction is contextual', () => {
        const out = queryNetwork('Who can help me with EU crypto insurance distribution?', { contacts: CONTACTS, insights: INSIGHTS });
        for (const r of out.results) {
            assert.ok(typeof r.suggestedAction === 'string' && r.suggestedAction.length > 0, 'action is non-empty string');
        }
    });
});

// ---------------------------------------------------------------------------
// resolveDataDir / hasContacts
// ---------------------------------------------------------------------------

describe('agent-query: resolveDataDir()', () => {
    let tmpRoot;
    const savedEnv = {};

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-test-'));
        savedEnv.CRM_DATA_DIR = process.env.CRM_DATA_DIR;
        delete process.env.CRM_DATA_DIR;
    });

    afterEach(() => {
        if (savedEnv.CRM_DATA_DIR !== undefined) {
            process.env.CRM_DATA_DIR = savedEnv.CRM_DATA_DIR;
        } else {
            delete process.env.CRM_DATA_DIR;
        }
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    function seedContacts(dir, contacts) {
        const unified = path.join(dir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), JSON.stringify(contacts));
    }

    it('CRM_DATA_DIR env var wins over everything', () => {
        const custom = path.join(tmpRoot, 'custom');
        seedContacts(custom, [{ id: 'x' }]);
        seedContacts(path.join(tmpRoot, 'data'), [{ id: 'y' }]);
        process.env.CRM_DATA_DIR = custom;
        assert.equal(resolveDataDir(tmpRoot), path.resolve(custom));
    });

    it('falls back to ./data when it has contacts', () => {
        seedContacts(path.join(tmpRoot, 'data'), [{ id: 'a' }]);
        seedContacts(path.join(tmpRoot, 'data-demo'), [{ id: 'b' }]);
        assert.equal(resolveDataDir(tmpRoot), path.join(tmpRoot, 'data'));
    });

    it('falls back to ./data-demo when ./data has no contacts', () => {
        seedContacts(path.join(tmpRoot, 'data-demo'), [{ id: 'c' }]);
        assert.equal(resolveDataDir(tmpRoot), path.join(tmpRoot, 'data-demo'));
    });

    it('falls back to ./data-demo when ./data has empty array', () => {
        seedContacts(path.join(tmpRoot, 'data'), []);
        seedContacts(path.join(tmpRoot, 'data-demo'), [{ id: 'd' }]);
        assert.equal(resolveDataDir(tmpRoot), path.join(tmpRoot, 'data-demo'));
    });

    it('returns null when neither dir has contacts', () => {
        assert.equal(resolveDataDir(tmpRoot), null);
    });

    it('hasContacts returns false for missing file', () => {
        assert.equal(hasContacts(path.join(tmpRoot, 'nope')), false);
    });

    it('hasContacts returns false for malformed JSON', () => {
        const dir = path.join(tmpRoot, 'bad');
        const unified = path.join(dir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), 'not-json');
        assert.equal(hasContacts(dir), false);
    });
});
