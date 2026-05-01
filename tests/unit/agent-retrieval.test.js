'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { queryNetwork, warmthLabel, confidenceLevel, suggestAction } = require('../../crm/agent-retrieval');
const { resolveDataDir, hasContacts, loadData } = require('../../scripts/agent-query');

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

    it('evidenceBacked is true only when evidence exists', () => {
        const out = queryNetwork('Who can help me with EU crypto insurance distribution?', { contacts: CONTACTS, insights: INSIGHTS });
        assert.ok(out.results.length >= 1, 'returns at least 1 result');
        for (const r of out.results) {
            assert.equal(typeof r.evidenceBacked, 'boolean', 'evidenceBacked is boolean');
            assert.equal(r.evidenceBacked, r.evidence.length > 0, 'evidenceBacked mirrors evidence presence');
        }
    });

    it('evidenceBacked is false for generic fallback results with no evidence', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS });
        const unsupported = out.results.find(r => r.evidence.length === 0);
        assert.ok(unsupported, 'generic query keeps at least one low-evidence fallback result');
        assert.equal(unsupported.evidenceBacked, false);
    });

    it('impossible query returns empty results', () => {
        const out = queryNetwork('quantum physics researchers in Antarctica', { contacts: CONTACTS, insights: INSIGHTS });
        assert.deepEqual(out.results, [], 'impossible query returns empty');
    });

    it('survives null contacts without crashing', () => {
        const out = queryNetwork('anyone', { contacts: null, insights: {} });
        assert.deepEqual(out.results, []);
        assert.ok(out.safety);
    });

    it('treats non-array contacts as empty input', () => {
        const out = queryNetwork('anyone', { contacts: 'not-an-array', insights: {} });
        assert.deepEqual(out.results, []);
        assert.ok(out.safety);
    });

    it('survives null insights without crashing', () => {
        const out = queryNetwork('anyone', { contacts: CONTACTS, insights: null });
        assert.ok(Array.isArray(out.results));
        assert.ok(out.safety);
    });
});

// ---------------------------------------------------------------------------
// warmthLabel — isolated boundary tests
// ---------------------------------------------------------------------------

describe('agent-retrieval: warmthLabel()', () => {
    it('returns "strong" at and above 70', () => {
        assert.equal(warmthLabel(70), 'strong');
        assert.equal(warmthLabel(100), 'strong');
    });

    it('returns "warm" for 50–69', () => {
        assert.equal(warmthLabel(50), 'warm');
        assert.equal(warmthLabel(69), 'warm');
    });

    it('returns "cool" for 30–49', () => {
        assert.equal(warmthLabel(30), 'cool');
        assert.equal(warmthLabel(49), 'cool');
    });

    it('returns "cold" below 30', () => {
        assert.equal(warmthLabel(29), 'cold');
        assert.equal(warmthLabel(0), 'cold');
    });

    it('returns "cold" for negative scores', () => {
        assert.equal(warmthLabel(-1), 'cold');
        assert.equal(warmthLabel(-100), 'cold');
    });

    it('returns "cold" for NaN (falls through all comparisons)', () => {
        assert.equal(warmthLabel(NaN), 'cold');
    });

    it('returns "cold" for undefined (falls through all comparisons)', () => {
        assert.equal(warmthLabel(undefined), 'cold');
    });
});

// ---------------------------------------------------------------------------
// confidenceLevel — isolated boundary tests
// ---------------------------------------------------------------------------

describe('agent-retrieval: confidenceLevel()', () => {
    it('returns "high" when combined score >= 60', () => {
        // matchScore=60, relationship=0 → combined=60
        assert.equal(confidenceLevel(60, 0), 'high');
        // matchScore=30, relationship=100 → combined=30+30=60
        assert.equal(confidenceLevel(30, 100), 'high');
    });

    it('returns "medium" when combined score >= 30 but < 60', () => {
        assert.equal(confidenceLevel(30, 0), 'medium');
        assert.equal(confidenceLevel(0, 100), 'medium'); // 0+30=30
    });

    it('returns "low" when combined score < 30', () => {
        assert.equal(confidenceLevel(0, 0), 'low');
        assert.equal(confidenceLevel(10, 50), 'low'); // 10+15=25
    });

    it('treats null/undefined scores as 0', () => {
        assert.equal(confidenceLevel(null, null), 'low');
        assert.equal(confidenceLevel(undefined, undefined), 'low');
        assert.equal(confidenceLevel(60, null), 'high');
    });

    it('exact boundary: combined=59.9 is medium, combined=60 is high', () => {
        // matchScore=59.9, relationship=0 → combined=59.9 → medium
        assert.equal(confidenceLevel(59.9, 0), 'medium');
        // matchScore=60, relationship=0 → combined=60 → high
        assert.equal(confidenceLevel(60, 0), 'high');
    });

    it('exact boundary: combined=29.9 is low, combined=30 is medium', () => {
        assert.equal(confidenceLevel(29.9, 0), 'low');
        assert.equal(confidenceLevel(30, 0), 'medium');
    });

    it('negative matchScore reduces combined score', () => {
        // matchScore=-10, relationship=100, relationship weight=0.3 → combined=20 → low
        assert.equal(confidenceLevel(-10, 100), 'low');
    });

    it('NaN matchScore falls back to 0 via || operator', () => {
        assert.equal(confidenceLevel(NaN, 0), 'low');
        // matchScore=0, relationship=200 → combined=0+(200*0.3)=60 → high
        assert.equal(confidenceLevel(NaN, 200), 'high');
    });
});

// ---------------------------------------------------------------------------
// suggestAction — isolated intent/warmth combination tests
// ---------------------------------------------------------------------------

describe('agent-retrieval: suggestAction()', () => {
    function makeResult(relationshipScore, daysSinceContact) {
        return { relationshipScore, daysSinceContact };
    }

    it('intro intent + strong warmth → warm intro suggestion', () => {
        assert.equal(
            suggestAction(makeResult(80, 5), 'intro'),
            'Ask for a warm intro — you have an active relationship.'
        );
    });

    it('intro intent + cold warmth → re-establish contact', () => {
        assert.equal(
            suggestAction(makeResult(10, 200), 'intro'),
            'Re-establish contact before requesting an intro.'
        );
    });

    it('reconnect intent → low-pressure check-in', () => {
        assert.equal(
            suggestAction(makeResult(80, 5), 'reconnect'),
            'Send a low-pressure check-in referencing your last conversation.'
        );
    });

    it('stale contact (>60 days) without specific intent → check-in', () => {
        assert.equal(
            suggestAction(makeResult(80, 90), 'general'),
            'Send a low-pressure check-in referencing your last conversation.'
        );
    });

    it('strong warmth, recent contact, general intent → reach out directly', () => {
        assert.equal(
            suggestAction(makeResult(80, 5), 'general'),
            'Reach out directly — strong existing relationship.'
        );
    });

    it('warm warmth, recent, general intent → reference shared context', () => {
        assert.equal(
            suggestAction(makeResult(55, 10), 'general'),
            'Reference shared context or recent interaction to re-engage.'
        );
    });

    it('cool warmth, recent, general intent → find mutual connection', () => {
        assert.equal(
            suggestAction(makeResult(35, 10), 'general'),
            'Find mutual connection or shared interest before reaching out.'
        );
    });

    it('cold warmth, recent, general intent → research before outreach', () => {
        assert.equal(
            suggestAction(makeResult(5, 10), 'general'),
            'Research shared context before cold outreach.'
        );
    });

    it('intro intent + warm warmth → warm intro suggestion', () => {
        assert.equal(
            suggestAction(makeResult(55, 10), 'intro'),
            'Ask for a warm intro — you have an active relationship.'
        );
    });

    it('intro intent + cool warmth → re-establish contact', () => {
        assert.equal(
            suggestAction(makeResult(35, 10), 'intro'),
            'Re-establish contact before requesting an intro.'
        );
    });

    it('daysSinceContact exactly 60 does NOT trigger reconnect fallback', () => {
        assert.equal(
            suggestAction(makeResult(80, 60), 'general'),
            'Reach out directly — strong existing relationship.'
        );
    });

    it('daysSinceContact 61 triggers reconnect even without reconnect intent', () => {
        assert.equal(
            suggestAction(makeResult(80, 61), 'general'),
            'Send a low-pressure check-in referencing your last conversation.'
        );
    });

    it('missing relationshipScore defaults to cold warmth', () => {
        const result = { daysSinceContact: 10 };
        assert.equal(
            suggestAction(result, 'general'),
            'Research shared context before cold outreach.'
        );
    });

    it('null daysSinceContact skips stale-contact branch', () => {
        const result = { relationshipScore: 80, daysSinceContact: null };
        assert.equal(
            suggestAction(result, 'general'),
            'Reach out directly — strong existing relationship.'
        );
    });

    it('undefined daysSinceContact skips stale-contact branch', () => {
        const result = { relationshipScore: 35 };
        assert.equal(
            suggestAction(result, 'general'),
            'Find mutual connection or shared interest before reaching out.'
        );
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

    it('falls back to ./data-demo when ./data has malformed JSON', () => {
        const dataDir = path.join(tmpRoot, 'data', 'unified');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'contacts.json'), 'not-json{{');
        seedContacts(path.join(tmpRoot, 'data-demo'), [{ id: 'demo1' }]);
        assert.equal(resolveDataDir(tmpRoot), path.join(tmpRoot, 'data-demo'));
    });

    it('falls back to ./data-demo when ./data contacts.json is a non-array object', () => {
        const dataDir = path.join(tmpRoot, 'data', 'unified');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'contacts.json'), JSON.stringify({ id: 'x' }));
        seedContacts(path.join(tmpRoot, 'data-demo'), [{ id: 'demo2' }]);
        assert.equal(resolveDataDir(tmpRoot), path.join(tmpRoot, 'data-demo'));
    });
});

// ---------------------------------------------------------------------------
// loadData — characterization coverage for MCP/agent data loading
// ---------------------------------------------------------------------------

describe('agent-query: loadData()', () => {
    let tmpDataDir;

    beforeEach(() => {
        tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-loaddata-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    function writeUnified(filename, content) {
        const unified = path.join(tmpDataDir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, filename), JSON.stringify(content));
    }

    it('loads contacts and insights from unified directory', () => {
        const contacts = [{ id: 'c1', name: 'Alice' }];
        const insights = { c1: { topics: ['fintech'] } };
        writeUnified('contacts.json', contacts);
        writeUnified('insights.json', insights);

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, contacts);
        assert.deepEqual(data.insights, insights);
    });

    it('returns empty array for contacts when file is missing', () => {
        // No unified dir at all
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
    });

    it('returns empty object for insights when file is missing', () => {
        writeUnified('contacts.json', [{ id: 'c1' }]);
        // insights.json intentionally not written

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, [{ id: 'c1' }]);
        assert.deepEqual(data.insights, {});
    });

    it('returns both defaults when unified directory does not exist', () => {
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
        assert.deepEqual(data.insights, {});
    });

    it('preserves full contact shape through round-trip', () => {
        const contacts = [{
            id: 'wa_001', name: 'Bob Chen',
            phones: ['+441234'], emails: ['bob@example.com'],
            sources: { whatsapp: { id: '441234@c.us' } },
            relationshipScore: 65, daysSinceContact: 10,
        }];
        writeUnified('contacts.json', contacts);
        writeUnified('insights.json', {});

        const data = loadData(tmpDataDir);
        assert.equal(data.contacts.length, 1);
        assert.equal(data.contacts[0].name, 'Bob Chen');
        assert.equal(data.contacts[0].relationshipScore, 65);
        assert.deepEqual(data.contacts[0].phones, ['+441234']);
    });
});
