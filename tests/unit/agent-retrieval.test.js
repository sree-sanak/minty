'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { queryNetwork, warmthLabel, confidenceLevel, suggestAction } = require('../../crm/agent-retrieval');
const { safeContactRef } = require('../../crm/source-events');
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

    it('uses precomputed contact evidence as a first-class retrieval source', () => {
        const contacts = [
            {
                id: 'c_ev', name: 'Evidence Only Person',
                sources: {}, relationshipScore: 25, daysSinceContact: 90, interactionCount: 0,
                activeChannels: [], emails: [], phones: [],
            },
            {
                id: 'c_warm', name: 'Warm Unrelated Person',
                sources: { linkedin: { position: 'Finance operator', company: 'BankCo' } },
                relationshipScore: 90, daysSinceContact: 1, interactionCount: 40,
                activeChannels: ['linkedin'], emails: [], phones: [],
            },
        ];
        const contactEvidence = {
            c_ev: {
                contactId: 'c_ev',
                topics: ['defi', 'lending protocol', 'risk'],
                topicEvidence: [
                    { topic: 'defi', count: 2, sources: ['telegram'], lastEvidenceAt: '2026-05-01T00:00:00.000Z' },
                    { topic: 'lending protocol', count: 1, sources: ['telegram'], lastEvidenceAt: '2026-05-01T00:00:00.000Z' },
                ],
                sources: ['telegram'],
                interactionCount: 2,
                confidence: 0.75,
            },
        };

        const out = queryNetwork('Who do I know working in DeFi lending protocols?', { contacts, contactEvidence });
        assert.equal(out.results[0].id, 'c_ev');
        assert.ok(out.results[0].evidence.some(e => e.kind === 'contact_evidence'));
        assert.ok(out.diagnostics.searchedSources.includes('telegram'));
        assert.equal(out.diagnostics.contactEvidenceContacts, 1);
        assert.equal(JSON.stringify(out).includes('2026-05-01'), false, 'must not leak raw evidence timestamps');
    });

    it('ignores orphan and group-only precomputed contact evidence', () => {
        const contacts = [
            { id: 'c_person', name: 'Person', sources: {}, relationshipScore: 10, daysSinceContact: 20, interactionCount: 0, activeChannels: [] },
            { id: 'c_group', name: 'DeFi Group', isGroup: true, sources: {}, relationshipScore: 99, daysSinceContact: 1, interactionCount: 100, activeChannels: [] },
        ];
        const contactEvidence = {
            c_group: { contactId: 'c_group', topics: ['defi'], topicEvidence: [{ topic: 'defi', count: 5, sources: ['telegram'] }], sources: ['telegram'], confidence: 1 },
            c_orphan: { contactId: 'c_orphan', topics: ['defi'], topicEvidence: [{ topic: 'defi', count: 5, sources: ['whatsapp'] }], sources: ['whatsapp'], confidence: 1 },
        };

        const out = queryNetwork('Who do I know working in DeFi?', { contacts, contactEvidence });
        assert.deepEqual(out.results, []);
        assert.equal(out.diagnostics.contactEvidenceContacts, 0);
    });

    it('uses privacy-safe interaction evidence from non-LinkedIn sources', () => {
        const contacts = [
            {
                id: 'c_tg', name: 'Tara Patel',
                sources: { telegram: { userId: 'tg_1' } },
                relationshipScore: 62, daysSinceContact: 4, interactionCount: 12,
                activeChannels: ['telegram'], emails: [], phones: [],
            },
            {
                id: 'c_li', name: 'Generic Finance Person',
                sources: { linkedin: { position: 'Finance Associate', company: 'BankCo' } },
                relationshipScore: 80, daysSinceContact: 1, interactionCount: 30,
                activeChannels: ['linkedin'], emails: [], phones: [],
            },
        ];
        const interactions = [
            {
                id: 'i_1', source: 'telegram', contactId: 'c_tg',
                body: 'We discussed DeFi lending protocols, Aave, and collateral risk.',
                timestamp: '2026-05-01T00:00:00Z',
            },
        ];

        const out = queryNetwork('Who do I know working in DeFi lending protocols?', { contacts, interactions });
        assert.equal(out.results[0].id, 'c_tg');
        assert.ok(out.results[0].evidence.some(e => e.kind === 'interaction' && e.label === 'Telegram evidence'));
        assert.ok(!JSON.stringify(out.results).includes('Aave'), 'must not leak raw interaction text');
        assert.ok(out.diagnostics.searchedSources.includes('telegram'));
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
    });

    it('filters results to requested source and exposes safe matched source attribution', () => {
        const contacts = [
            {
                id: 'c_tg', name: 'Tara Telegram',
                sources: { telegram: { userId: 'tg_1' }, linkedin: {} },
                relationshipScore: 35, daysSinceContact: 8, interactionCount: 3,
                activeChannels: ['telegram'], emails: [], phones: [],
            },
            {
                id: 'c_li', name: 'Lina LinkedIn',
                sources: { telegram: {}, linkedin: { position: 'Founder', company: 'DeFi Protocol Co' } },
                relationshipScore: 95, daysSinceContact: 1, interactionCount: 30,
                activeChannels: ['linkedin'], emails: [], phones: [],
            },
        ];
        const interactions = [
            { id: 'i_tg', source: 'telegram', contactId: 'c_tg', body: 'DeFi protocol founder chat.' },
            { id: 'i_li', source: 'linkedin', contactId: 'c_li', body: 'DeFi protocol founder chat.' },
        ];

        const out = queryNetwork('DeFi protocol founder', { contacts, interactions, sources: ['telegram'] });
        assert.deepEqual(out.results.map(r => r.id), ['c_tg']);
        assert.deepEqual(out.results[0].matchedSources, ['telegram']);
        assert.deepEqual(out.diagnostics.sourceFilter, ['telegram']);
        assert.deepEqual(out.diagnostics.sourceCoverage.matchingSources, ['telegram']);
    });

    it('matches Telegram message rows to personal chat names when no contactId exists', () => {
        const contacts = [{
            id: 'c_named', name: 'Nina DeFi',
            sources: { telegram: { userId: null } },
            relationshipScore: 45, daysSinceContact: 10, interactionCount: 5,
            activeChannels: ['telegram'], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_named', source: 'telegram', chatName: 'Nina DeFi', type: 'message',
            body: 'Talked about AMMs, staking and Ethereum DeFi risk.',
            timestamp: '2026-05-01T00:00:00Z',
        }];

        const out = queryNetwork('ethereum defi staking', { contacts, interactions, sources: ['telegram'] });
        assert.equal(out.results[0].id, 'c_named');
        assert.ok(out.results[0].evidence.some(e => e.kind === 'interaction' && e.label === 'Telegram evidence'));
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
    });

    it('does not use group chat names as person interaction evidence', () => {
        const contacts = [{
            id: 'c_named', name: 'Nina DeFi',
            sources: { telegram: { userId: null } },
            relationshipScore: 45, daysSinceContact: 10, interactionCount: 5,
            activeChannels: ['telegram'], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_group', source: 'telegram', contactId: 'c_named', chatName: 'Nina DeFi', type: 'group', isGroup: true,
            participants: ['Nina DeFi', 'Alice', 'Bob'],
            body: 'Group discussed AMMs, staking and Ethereum DeFi risk.',
            timestamp: '2026-05-01T00:00:00Z',
        }];

        const out = queryNetwork('ethereum defi staking', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0);
        assert.ok(!out.results.some(r => (r.evidence || []).some(e => e.kind === 'interaction')));
    });

    it('does not create interaction evidence from embedded word fragments', () => {
        const contacts = [{
            id: 'c_ai', name: 'Aisha Yield',
            sources: {}, relationshipScore: 30, daysSinceContact: 20, interactionCount: 2,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_fragment', source: 'email', contactId: 'c_ai',
            body: 'Aisha discussed yield risk in DeFi markets.',
        }];

        const out = queryNetwork('yield', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1, 'standalone yield should match');

        const fragmentOnly = [{ ...interactions[0], body: 'Aisha is yielding well on unrelated operations.' }];
        const no = queryNetwork('yield', { contacts, interactions: fragmentOnly });
        assert.equal(no.diagnostics.interactionEvidenceContacts, 0, 'embedded yielding must not match yield');
        assert.ok(!no.results.some(r => (r.evidence || []).some(e => e.kind === 'interaction')));
    });

    it('requires direct query-term or multi-term expansion evidence for interactions', () => {
        const contacts = [{
            id: 'c_crypto', name: 'Casey Crypto',
            sources: {}, relationshipScore: 30, daysSinceContact: 20, interactionCount: 2,
            activeChannels: [], emails: [], phones: [],
        }];
        const weak = [{
            id: 'i_weak', source: 'email', contactId: 'c_crypto',
            body: 'We mentioned crypto once in a broad market chat.',
        }];
        const strong = [{
            id: 'i_strong', source: 'email', contactId: 'c_crypto',
            body: 'We discussed decentralized finance and DeFi markets.',
        }];

        const weakOut = queryNetwork('defi', { contacts, interactions: weak });
        assert.equal(weakOut.diagnostics.interactionEvidenceContacts, 0);

        const strongOut = queryNetwork('defi', { contacts, interactions: strong });
        assert.equal(strongOut.diagnostics.interactionEvidenceContacts, 1);
    });

    it('matches simple plural variants for interaction phrases', () => {
        const contacts = [{
            id: 'c_protocols', name: 'Paula Protocol',
            sources: {}, relationshipScore: 30, daysSinceContact: 20, interactionCount: 2,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_protocols', source: 'email', contactId: 'c_protocols',
            body: 'We discussed lending protocols for DeFi risk.',
        }];

        const out = queryNetwork('lending protocol', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
    });

    it('falls back to matching personal chat names when interactions have no contactId', () => {
        const contacts = [{
            id: 'c_named', name: 'Nina DeFi',
            sources: { telegram: { userId: null } },
            relationshipScore: 45, daysSinceContact: 10, interactionCount: 5,
            activeChannels: ['telegram'], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_named', source: 'telegram', chatName: 'Nina DeFi', type: 'personal',
            body: 'Talked about AMMs, staking and Ethereum DeFi risk.',
            timestamp: '2026-05-01T00:00:00Z',
        }];

        const out = queryNetwork('ethereum defi staking', { contacts, interactions });
        assert.equal(out.results[0].id, 'c_named');
        assert.ok(out.results[0].evidence.some(e => e.kind === 'interaction'));
    });

    it('sanitizes unknown interaction source labels in evidence and diagnostics', () => {
        const contacts = [{
            id: 'c_private', name: 'Private Source Person',
            sources: {}, relationshipScore: 50, daysSinceContact: 3, interactionCount: 1,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_private', source: '+15551234567', contactId: 'c_private',
            body: 'DeFi protocol risk and lending markets.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        const serialized = JSON.stringify(out);
        assert.equal(out.results[0].evidence.find(e => e.kind === 'interaction').label, 'Interaction evidence');
        assert.ok(out.diagnostics.searchedSources.includes('interaction'));
        assert.equal(serialized.includes('+15551234567'), false, 'must not leak raw source/channel values');
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

    it('treats prototype-like contact ids as ordinary data keys', () => {
        for (const id of ['__proto__', 'constructor', 'toString']) {
            const contacts = [{
                id, name: 'Pat AppSec',
                sources: { linkedin: { position: 'Application Security Lead', company: 'SecureFoundry' } },
                relationshipScore: 65, daysSinceContact: 3, interactionCount: 12,
                emails: ['pat@example.com'], phones: ['+155****0123'],
            }];
            const out = queryNetwork('appsec', { contacts });
            assert.equal(out.results.length, 1);
            assert.equal(out.results[0].id, id);
            assert.ok(out.results[0].evidence.some(e => e.kind === 'keyword'));
        }
    });

    it('ignores inherited insight keys when building agent evidence', () => {
        const contacts = [{
            id: 'inherited-contact', name: 'Pat Safe',
            sources: { linkedin: { position: 'Founder', company: 'SafeFoundry' } },
            relationshipScore: 65, daysSinceContact: 3, interactionCount: 12,
            emails: ['pat@example.com'], phones: ['+155****0123'],
        }];
        const insights = Object.create({
            'inherited-contact': { topics: ['zero trust security'] },
        });
        const out = queryNetwork('zero trust security', { contacts, insights });
        assert.deepEqual(out.results, [], 'inherited prototype data must not create source evidence');
    });

    it('safety envelope includes readOnly flag', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(out.safety.readOnly, true, 'readOnly must be true');
    });

    it('float limit falls back to safe default without truncating this four-result fixture', () => {
        const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS, limit: 3.5 });
        assert.deepEqual(out.results.map(r => r.id), ['c_004', 'c_001', 'c_002', 'c_003']);
    });

    it('result envelope carries exact confidence and metadata for known contact', () => {
        const out = queryNetwork('payments infrastructure', { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(out.results.length, 1);
        assert.deepEqual(out.results[0], {
            id: 'c_004',
            name: 'Dan Petrov',
            title: 'Software Engineer at Stripe',
            company: 'Stripe',
            city: 'london',
            relevance: 51,
            relationshipScore: 85,
            warmth: 'strong',
            confidence: 'high',
            matchType: 'direct_evidence',
            evidence: [
                { kind: 'keyword', label: 'stripe', detail: 'Company: Stripe' },
                { kind: 'topic', label: 'Recent conversation', detail: 'payments infrastructure' },
                { kind: 'recent', label: 'Recent', detail: '2 days ago' },
            ],
            evidenceBacked: true,
            matchedSources: ['email', 'linkedin', 'whatsapp'],
            suggestedAction: 'Reach out directly — strong existing relationship.',
            daysSinceContact: 2,
            interactionCount: 50,
        });
    });

    it('empty query string returns deterministic generic ranking without crashing', () => {
        const out = queryNetwork('', { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(out.query, '');
        assert.equal(out.intent, 'find');
        assert.deepEqual(out.results.map(r => r.id), ['c_004', 'c_001', 'c_002', 'c_003']);
        assert.equal(out.safety.readOnly, true);
    });

    it('excludes isGroup contacts from results', () => {
        const contacts = [
            {
                id: 'g_001', name: 'Crypto Founders Chat', isGroup: true,
                sources: { whatsapp: { id: 'g_001@g.us' } },
                relationshipScore: 0, daysSinceContact: 1, interactionCount: 200,
                emails: [], phones: [],
            },
            ...CONTACTS,
        ];
        const out = queryNetwork('crypto', { contacts, insights: INSIGHTS });
        const ids = out.results.map(r => r.id);
        assert.ok(!ids.includes('g_001'), 'group contact should be excluded from agent results');
        // Ensure real contacts still come through
        assert.ok(out.results.length >= 1, 'should still return non-group results');
    });

    it('DeFi query surfaces contacts with DeFi-related topics or keywords', () => {
        const out = queryNetwork('Who do I know working in DeFi?', { contacts: CONTACTS, insights: INSIGHTS });
        assert.ok(out.results.length >= 1, 'DeFi query returns at least one result');
        assert.ok(out.results.some(r => r.name === 'Bob Chen'), 'Bob (DeFi insurance topic) should be in results');
    });

    it('DeFi query ranks DeFi-topic contacts above unrelated contacts', () => {
        const out = queryNetwork('DeFi contacts', { contacts: CONTACTS, insights: INSIGHTS });
        const names = out.results.map(r => r.name);
        const bobIdx = names.indexOf('Bob Chen');
        const danIdx = names.indexOf('Dan Petrov');
        if (bobIdx !== -1 && danIdx !== -1) {
            assert.ok(bobIdx < danIdx, 'Bob (DeFi topic) ranks above Dan (payments, no DeFi)');
        }
    });

    it('evidence details do not leak source channel names', () => {
        const out = queryNetwork('crypto insurance', { contacts: CONTACTS, insights: INSIGHTS });
        for (const r of out.results) {
            for (const e of r.evidence) {
                const detail = (e.detail || '').toLowerCase();
                assert.ok(!detail.startsWith('linkedin '), `evidence detail "${e.detail}" must not start with source channel name`);
                assert.ok(!detail.startsWith('whatsapp '), `evidence detail "${e.detail}" must not start with source channel name`);
                assert.ok(!detail.startsWith('telegram '), `evidence detail "${e.detail}" must not start with source channel name`);
            }
        }
    });

    // -----------------------------------------------------------------------
    // Query normalization — envelope.query must always be a bounded string
    // -----------------------------------------------------------------------

    it('normalizes numeric query to empty string in the envelope', () => {
        const out = queryNetwork(42, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string', 'envelope query must be a string');
        assert.equal(out.query, '');
    });

    it('normalizes object query to empty string in the envelope', () => {
        const out = queryNetwork({ evil: 'payload' }, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string', 'envelope query must be a string');
        assert.equal(out.query, '');
    });

    it('normalizes array query to empty string in the envelope', () => {
        const out = queryNetwork(['a', 'b'], { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string', 'envelope query must be a string');
        assert.equal(out.query, '');
    });

    it('normalizes boolean query to empty string in the envelope', () => {
        const out = queryNetwork(true, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string', 'envelope query must be a string');
        assert.equal(out.query, '');
    });

    it('normalizes null query to empty string in the envelope', () => {
        const out = queryNetwork(null, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string');
        assert.equal(out.query, '');
    });

    it('normalizes undefined query to empty string in the envelope', () => {
        const out = queryNetwork(undefined, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(typeof out.query, 'string');
        assert.equal(out.query, '');
    });

    it('truncates excessively long queries to prevent performance degradation', () => {
        const longQuery = 'a'.repeat(2000);
        const out = queryNetwork(longQuery, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(out.query.length, 1000);
        assert.equal(out.query, 'a'.repeat(1000));
        assert.equal(typeof out.query, 'string');
    });

    it('preserves valid string queries under the length limit', () => {
        const normalQuery = 'investors in London';
        const out = queryNetwork(normalQuery, { contacts: CONTACTS, insights: INSIGHTS });
        assert.equal(out.query, normalQuery, 'normal queries pass through unchanged');
    });

    it('survives null opts without crashing', () => {
        const out = queryNetwork('anyone', null);
        assert.deepEqual(out.results, []);
        assert.ok(out.safety);
        assert.equal(out.safety.readOnly, true);
    });

    it('survives undefined opts (no second argument)', () => {
        const out = queryNetwork('anyone');
        assert.deepEqual(out.results, []);
        assert.ok(out.safety);
        assert.equal(out.safety.readOnly, true);
    });
});

// ---------------------------------------------------------------------------
// Interaction evidence: cross-source, name-fallback, and privacy edge cases
// ---------------------------------------------------------------------------

describe('agent-retrieval: interaction evidence edge cases', () => {

    it('multi-source interaction evidence uses cross-source label', () => {
        const contacts = [{
            id: 'c_multi', name: 'Multi Source Person',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 10,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [
            {
                id: 'i_tg', source: 'telegram', contactId: 'c_multi',
                body: 'Discussed DeFi protocol risk and lending strategies.',
            },
            {
                id: 'i_em', source: 'email', contactId: 'c_multi',
                body: 'Follow up on DeFi lending protocol analysis.',
            },
        ];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.results.length, 1);
        const interactionEvidence = out.results[0].evidence.find(e => e.kind === 'interaction');
        assert.ok(interactionEvidence, 'interaction evidence exists');
        assert.equal(interactionEvidence.label, 'Cross-source interaction evidence');
        assert.match(interactionEvidence.detail, /2 matching interactions across 2 source types/);
    });

    it('domain-builder interaction evidence requires a domain anchor, not only generic building/platform words', () => {
        const contacts = [
            {
                id: 'c_generic', name: 'Generic Platform Builder',
                sources: { telegram: { userId: 'tg_generic' } }, activeChannels: ['telegram'],
                relationshipScore: 50, daysSinceContact: 5, interactionCount: 3,
            },
            {
                id: 'c_domain', name: 'Payments Platform Builder',
                sources: { telegram: { userId: 'tg_domain' } }, activeChannels: ['telegram'],
                relationshipScore: 30, daysSinceContact: 20, interactionCount: 1,
            },
        ];
        const interactions = [
            {
                id: 'i_generic', source: 'telegram', type: 'direct', contactId: 'c_generic',
                body: 'They are building a new developer platform for teams.',
            },
            {
                id: 'i_domain', source: 'telegram', type: 'direct', contactId: 'c_domain',
                body: 'They are building payments checkout tooling for platforms.',
            },
        ];

        const out = queryNetwork('who is building payments platforms', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
        assert.deepEqual(out.results.map(r => r.id), ['c_domain']);
        assert.deepEqual(out.results[0].matchedSources, ['telegram']);
    });

    it('natural-language source and recency constraints become structured query plan fields', () => {
        const contacts = [
            {
                id: 'c_tg_payments', name: 'Telegram Payments Builder',
                sources: { telegram: { userId: 'tg_payments' } }, activeChannels: ['telegram'],
                relationshipScore: 45, daysSinceContact: 3, interactionCount: 4,
            },
            {
                id: 'c_li_payments', name: 'LinkedIn Payments Builder',
                sources: { linkedin: { position: 'Payments Founder', company: 'CheckoutCo' } }, activeChannels: ['linkedin'],
                relationshipScore: 90, daysSinceContact: 1, interactionCount: 20,
            },
        ];
        const interactions = [{
            id: 'i_tg_payments', source: 'telegram', type: 'direct', contactId: 'c_tg_payments',
            body: 'They are building payments platforms for checkout teams.',
        }];

        const out = queryNetwork('who from Telegram is building payments platforms recently', { contacts, interactions });
        assert.deepEqual(out.diagnostics.sourceFilter, ['telegram']);
        assert.deepEqual(out.diagnostics.queryPlan.sourceFilter, ['telegram']);
        assert.equal(out.diagnostics.queryPlan.recency, 'recent');
        assert.deepEqual(out.diagnostics.queryPlan.domainTerms, ['payments']);
        assert.deepEqual(out.results.map(r => r.id), ['c_tg_payments']);
        assert.ok(!out.results[0].evidence.some(e => e.kind === 'keyword' && e.label === 'telegram'));
    });

    it('classifies direct evidence separately from intro/router-style queries', () => {
        const contacts = [{
            id: 'c_compliance', name: 'Compliance Tool Builder',
            sources: { email: { address: 'omitted@example.com' } }, activeChannels: ['email'],
            relationshipScore: 80, daysSinceContact: 5, interactionCount: 7,
        }];
        const interactions = [{
            id: 'i_compliance', source: 'email', type: 'direct', contactId: 'c_compliance',
            body: 'Discussed building compliance tools for fintech onboarding.',
        }];

        const out = queryNetwork('who can intro me to someone building compliance tools', { contacts, interactions });
        assert.equal(out.diagnostics.queryPlan.relationshipMode, 'intro_path');
        assert.deepEqual(out.diagnostics.queryPlan.domainTerms, ['compliance', 'tools']);
        assert.equal(out.results[0].matchType, 'direct_evidence');
        assert.equal(out.results[0].confidence, 'high');
    });

    it('matchedSources prefer evidence sources over every channel on a multi-channel contact', () => {
        const contacts = [{
            id: 'c_multi_evidence', name: 'Multi Channel Person',
            sources: { telegram: { userId: 'tg_m' }, whatsapp: { id: 'wa_m' }, linkedin: { id: 'li_m' } },
            activeChannels: ['telegram', 'whatsapp'], relationshipScore: 40, daysSinceContact: 3, interactionCount: 5,
        }];
        const interactions = [{
            id: 'i_multi_evidence', source: 'telegram', type: 'direct', contactId: 'c_multi_evidence',
            body: 'Discussed DeFi staking and liquidity pool risk.',
        }];

        const out = queryNetwork('defi staking', { contacts, interactions });
        assert.equal(out.results.length, 1);
        assert.deepEqual(out.results[0].matchedSources, ['telegram']);
    });

    it('name fallback resolves via "from" field on personal DM interactions', () => {
        const contacts = [{
            id: 'c_from', name: 'Fiona Reply',
            sources: { telegram: { userId: 'tg_f' } },
            relationshipScore: 40, daysSinceContact: 8, interactionCount: 3,
            activeChannels: ['telegram'], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_from', source: 'telegram', type: 'direct',
            from: 'Fiona Reply',
            body: 'Talked about DeFi staking and yield farms.',
        }];

        const out = queryNetwork('defi staking yield', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
        assert.ok(out.results[0].evidence.some(e => e.kind === 'interaction'));
    });

    it('name fallback resolves via "senderName" field on private interactions', () => {
        const contacts = [{
            id: 'c_sender', name: 'Sam Sender',
            sources: {}, relationshipScore: 35, daysSinceContact: 12, interactionCount: 2,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_sender', source: 'whatsapp', type: 'private',
            senderName: 'Sam Sender',
            body: 'Talked about DeFi insurance and underwriting protocols.',
        }];

        const out = queryNetwork('defi insurance underwriting', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
    });

    it('name fallback resolves via "recipientName" on one-to-one interactions', () => {
        const contacts = [{
            id: 'c_recip', name: 'Rita Recipient',
            sources: {}, relationshipScore: 30, daysSinceContact: 15, interactionCount: 1,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_recip', source: 'email', type: 'one_to_one',
            recipientName: 'Rita Recipient',
            body: 'DeFi protocol lending risk and collateral management.',
        }];

        const out = queryNetwork('defi lending collateral', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 1);
    });

    it('name fallback does NOT resolve without a personal interaction type', () => {
        const contacts = [{
            id: 'c_notype', name: 'Nora NoType',
            sources: {}, relationshipScore: 30, daysSinceContact: 15, interactionCount: 1,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_notype', source: 'telegram',
            // No type, no contactId — fallback path should NOT match without type
            chatName: 'Nora NoType',
            body: 'DeFi protocol risk and lending strategies discussion.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'name fallback must require a personal interaction type for safety');
    });

    it('single-source interaction evidence uses source-specific label', () => {
        const contacts = [{
            id: 'c_wa', name: 'Wendy WhatsApp',
            sources: {}, relationshipScore: 45, daysSinceContact: 3, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [
            {
                id: 'i_wa1', source: 'whatsapp', contactId: 'c_wa',
                body: 'DeFi lending protocol risk discussion.',
            },
            {
                id: 'i_wa2', source: 'whatsapp', contactId: 'c_wa',
                body: 'Follow up on DeFi lending strategies.',
            },
        ];

        const out = queryNetwork('defi lending', { contacts, interactions });
        const interactionEvidence = out.results[0].evidence.find(e => e.kind === 'interaction');
        assert.ok(interactionEvidence);
        assert.equal(interactionEvidence.label, 'WhatsApp evidence');
        assert.match(interactionEvidence.detail, /2 matching interactions across 1 source type/);
    });

    it('interaction evidence never leaks contactId, raw text, or timestamps', () => {
        const contacts = [{
            id: 'secret_id_123', name: 'Evidence Privacy Check',
            sources: { telegram: { userId: 'tg_secret' } },
            relationshipScore: 60, daysSinceContact: 2, interactionCount: 5,
            activeChannels: ['telegram'], emails: ['secret@test.com'], phones: ['raw-phone-555-0101'],
        }];
        const interactions = [{
            id: 'i_secret', source: 'telegram', contactId: 'secret_id_123',
            body: 'Discussed DeFi protocol risk and lending market analysis.',
            timestamp: '2026-04-30T12:00:00Z',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        const evidenceJson = JSON.stringify(out.results[0].evidence);
        // Evidence should not contain raw interaction body text
        assert.ok(!evidenceJson.includes('market analysis'), 'evidence must not contain raw body text');
        // Evidence should not contain timestamps
        assert.ok(!evidenceJson.includes('2026-04-30'), 'evidence must not contain interaction timestamps');
        // Evidence should not contain contact or interaction identifiers
        assert.ok(!evidenceJson.includes('secret_id_123'), 'evidence must not contain contactId');
        assert.ok(!evidenceJson.includes('i_secret'), 'evidence must not contain interaction id');
        assert.ok(!evidenceJson.includes('tg_secret'), 'evidence must not contain source account id');
        // Evidence should not contain email/phone
        assert.ok(!evidenceJson.includes('secret@test.com'), 'evidence must not contain email');
        assert.ok(!evidenceJson.includes('raw-phone-555-0101'), 'evidence must not contain phone');
    });

    it('excludes interactions with threadType "group" from evidence', () => {
        const contacts = [{
            id: 'c_thread', name: 'Thread Group Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_thread_group', source: 'telegram', contactId: 'c_thread',
            threadType: 'group',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'threadType "group" must be excluded from interaction evidence');
    });

    it('excludes interactions with threadType "channel" from evidence', () => {
        const contacts = [{
            id: 'c_thread_chan', name: 'Thread Channel Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_thread_channel', source: 'telegram', contactId: 'c_thread_chan',
            threadType: 'Channel',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'threadType "channel" must be excluded from interaction evidence');
    });

    it('excludes interactions with threadType "broadcast" from evidence', () => {
        const contacts = [{
            id: 'c_thread_bcast', name: 'Thread Broadcast Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_thread_bcast', source: 'whatsapp', contactId: 'c_thread_bcast',
            threadType: 'BROADCAST',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'threadType "broadcast" must be excluded from interaction evidence');
    });

    it('excludes interactions with threadType "mailing_list" from evidence', () => {
        const contacts = [{
            id: 'c_thread_list', name: 'Thread List Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_thread_list', source: 'email', contactId: 'c_thread_list',
            threadType: 'mailing_list',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'threadType "mailing_list" must be excluded from interaction evidence');
    });

    it('excludes interactions with groupId set from evidence', () => {
        const contacts = [{
            id: 'c_gid', name: 'GroupId Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_groupid', source: 'whatsapp', contactId: 'c_gid',
            groupId: 'group_abc_123',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'interactions with groupId must be excluded from evidence');
    });

    it('excludes interactions with type "channel" from evidence', () => {
        const contacts = [{
            id: 'c_chan', name: 'Channel Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_channel', source: 'telegram', contactId: 'c_chan',
            type: 'channel',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'type "channel" must be excluded from interaction evidence');
    });

    it('excludes interactions with type "broadcast" from evidence', () => {
        const contacts = [{
            id: 'c_bcast', name: 'Broadcast Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_bcast', source: 'whatsapp', contactId: 'c_bcast',
            type: 'broadcast',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'type "broadcast" must be excluded from interaction evidence');
    });

    it('excludes interactions with type "mailing_list" from evidence', () => {
        const contacts = [{
            id: 'c_ml', name: 'Mailing List Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_ml', source: 'email', contactId: 'c_ml',
            type: 'mailing_list',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'type "mailing_list" must be excluded from interaction evidence');
    });

    it('excludes interactions with type "mailing-list" (hyphenated) from evidence', () => {
        const contacts = [{
            id: 'c_mlh', name: 'Mailing Hyphen Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_mlh', source: 'email', contactId: 'c_mlh',
            type: 'mailing-list',
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'type "mailing-list" (hyphenated) must be excluded from interaction evidence');
    });

    it('excludes interactions with isChannel flag from evidence', () => {
        const contacts = [{
            id: 'c_ischan', name: 'IsChannel Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_ischan', source: 'telegram', contactId: 'c_ischan',
            isChannel: true,
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'isChannel flag must be excluded from interaction evidence');
    });

    it('excludes interactions with isBroadcast flag from evidence', () => {
        const contacts = [{
            id: 'c_isbcast', name: 'IsBroadcast Contact',
            sources: {}, relationshipScore: 50, daysSinceContact: 5, interactionCount: 5,
            activeChannels: [], emails: [], phones: [],
        }];
        const interactions = [{
            id: 'i_isbcast', source: 'whatsapp', contactId: 'c_isbcast',
            isBroadcast: true,
            body: 'DeFi protocol risk and lending market strategies discussed.',
        }];

        const out = queryNetwork('defi lending', { contacts, interactions });
        assert.equal(out.diagnostics.interactionEvidenceContacts, 0,
            'isBroadcast flag must be excluded from interaction evidence');
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
// Full-envelope PII scan — characterization coverage
// ---------------------------------------------------------------------------

describe('agent-retrieval: full envelope PII exclusion (characterization)', () => {
    const PII_CONTACTS = [
        {
            id: 'pii_001', name: 'Sentinel PII Person',
            sources: { linkedin: { position: 'DeFi Analyst', company: 'CryptoVault', location: 'Zurich' } },
            relationshipScore: 70, daysSinceContact: 3, interactionCount: 15,
            activeChannels: ['telegram', 'whatsapp'],
            emails: ['sentinel-leak@pii-test.example'], phones: ['raw-phone-555-0199'],
        },
        {
            id: 'pii_002', name: 'Another PII Contact',
            sources: { whatsapp: { id: 'wa_secret_handle_xyz' } },
            relationshipScore: 40, daysSinceContact: 20, interactionCount: 4,
            activeChannels: ['whatsapp'],
            emails: ['another-leak@pii-test.example'], phones: ['raw-phone-555-0200'],
        },
    ];

    const PII_INSIGHTS = {
        pii_001: { topics: ['defi analysis', 'crypto custody'] },
    };

    const PII_INTERACTIONS = [
        {
            id: 'i_pii_secret', source: 'telegram', contactId: 'pii_001',
            body: 'We discussed DeFi custody risk and cold wallet infrastructure.',
            timestamp: '2026-05-02T10:30:00Z',
        },
    ];

    it('full JSON.stringify of queryNetwork output contains no PII sentinel strings', () => {
        const out = queryNetwork('defi custody', {
            contacts: PII_CONTACTS,
            insights: PII_INSIGHTS,
            interactions: PII_INTERACTIONS,
        });
        const serialized = JSON.stringify(out);

        // Emails must not appear anywhere in the envelope
        assert.equal(serialized.includes('sentinel-leak@pii-test.example'), false,
            'full envelope must not contain email sentinel');
        assert.equal(serialized.includes('another-leak@pii-test.example'), false,
            'full envelope must not contain second email sentinel');

        // Phones must not appear anywhere in the envelope
        assert.equal(serialized.includes('raw-phone-555-0199'), false,
            'full envelope must not contain phone sentinel');
        assert.equal(serialized.includes('raw-phone-555-0200'), false,
            'full envelope must not contain second phone sentinel');

        // Source account handles must not appear
        assert.equal(serialized.includes('wa_secret_handle_xyz'), false,
            'full envelope must not contain source account handle');

        // Raw interaction body must not appear
        assert.equal(serialized.includes('cold wallet infrastructure'), false,
            'full envelope must not contain raw interaction body text');

        // Interaction timestamps must not appear
        assert.equal(serialized.includes('2026-05-02T10:30:00Z'), false,
            'full envelope must not contain interaction timestamp');

        // Internal interaction ID must not appear
        assert.equal(serialized.includes('i_pii_secret'), false,
            'full envelope must not contain interaction id');
    });

    it('full envelope excludes PII even when query matches by name', () => {
        const out = queryNetwork('Sentinel PII Person', {
            contacts: PII_CONTACTS,
            insights: PII_INSIGHTS,
        });
        const serialized = JSON.stringify(out);

        assert.equal(serialized.includes('sentinel-leak@pii-test.example'), false,
            'name-matched envelope must not contain email');
        assert.equal(serialized.includes('raw-phone-555-0199'), false,
            'name-matched envelope must not contain phone');
    });

    it('diagnostics section specifically contains no PII sentinels', () => {
        const out = queryNetwork('defi custody', {
            contacts: PII_CONTACTS,
            insights: PII_INSIGHTS,
            interactions: PII_INTERACTIONS,
        });
        const diagSerialized = JSON.stringify(out.diagnostics);

        assert.equal(diagSerialized.includes('sentinel-leak'), false,
            'diagnostics must not contain email fragments');
        assert.equal(diagSerialized.includes('raw-phone'), false,
            'diagnostics must not contain phone fragments');
        assert.equal(diagSerialized.includes('wa_secret_handle'), false,
            'diagnostics must not contain source handle fragments');
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

    it('loads contacts, insights, interactions, and contact evidence from unified directory', () => {
        const contacts = [{ id: 'c1', name: 'Alice' }];
        const insights = { c1: { topics: ['fintech'] } };
        const interactions = [{ id: 'i1', contactId: 'c1', source: 'telegram', body: 'DeFi lending' }];
        const contactEvidence = { [safeContactRef('c1')]: { topics: ['defi'], sources: ['telegram'] } };
        writeUnified('contacts.json', contacts);
        writeUnified('insights.json', insights);
        writeUnified('interactions.json', interactions);
        writeUnified('contact-evidence.json', contactEvidence);

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, contacts);
        assert.deepEqual(data.insights, insights);
        assert.deepEqual(data.interactions, interactions);
        assert.deepEqual(data.contactEvidence, contactEvidence);
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

    it('distinguishes missing optional generated artifacts from present empty artifacts', () => {
        writeUnified('contacts.json', [{ id: 'c1' }]);
        let data = loadData(tmpDataDir);
        assert.equal(data.sourceEvents, undefined);
        assert.equal(data.hybridIndex, undefined);

        writeUnified('source-events.json', []);
        writeUnified('hybrid-index.json', []);
        data = loadData(tmpDataDir);
        assert.deepEqual(data.sourceEvents, []);
        assert.deepEqual(data.hybridIndex, []);
    });

    it('returns empty array when contacts.json contains malformed JSON', () => {
        const unified = path.join(tmpDataDir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), '{not valid json!!');
        fs.writeFileSync(path.join(unified, 'insights.json'), JSON.stringify({ c1: { topics: ['x'] } }));

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, [], 'malformed contacts.json defaults to []');
        assert.deepEqual(data.insights, { c1: { topics: ['x'] } }, 'valid insights still loads');
    });

    it('returns empty object when insights.json contains malformed JSON', () => {
        const unified = path.join(tmpDataDir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), JSON.stringify([{ id: 'c1' }]));
        fs.writeFileSync(path.join(unified, 'insights.json'), '%%%not-json%%%');

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, [{ id: 'c1' }], 'valid contacts still loads');
        assert.deepEqual(data.insights, {}, 'malformed insights.json defaults to {}');
    });

    it('returns both defaults when both files contain malformed JSON', () => {
        const unified = path.join(tmpDataDir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), 'BROKEN');
        fs.writeFileSync(path.join(unified, 'insights.json'), 'ALSO BROKEN');

        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, [], 'malformed contacts defaults to []');
        assert.deepEqual(data.insights, {}, 'malformed insights defaults to {}');
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

    // --- Shape validation: parsed but wrong type degrades to safe defaults ---

    it('returns [] for contacts.json when it parses to a non-array value (object)', () => {
        writeUnified('contacts.json', { id: 'not-an-array' });
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
    });

    it('returns [] for contacts.json when it parses to a string', () => {
        writeUnified('contacts.json', 'hello');
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
    });

    it('returns [] for contacts.json when it parses to a number', () => {
        writeUnified('contacts.json', 42);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
    });

    it('returns [] for contacts.json when it parses to null', () => {
        writeUnified('contacts.json', null);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.contacts, []);
    });

    it('returns [] for interactions.json when it parses to a non-array value', () => {
        writeUnified('interactions.json', { type: 'not-array' });
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.interactions, []);
    });

    it('returns [] for interactions.json when it parses to null', () => {
        writeUnified('interactions.json', null);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.interactions, []);
    });

    it('returns {} for insights.json when it parses to null', () => {
        writeUnified('insights.json', null);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.insights, {});
    });

    it('returns {} for insights.json when it parses to an array', () => {
        writeUnified('insights.json', ['not', 'an', 'object']);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.insights, {});
    });

    it('returns {} for insights.json when it parses to a string', () => {
        writeUnified('insights.json', 'hello');
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.insights, {});
    });

    it('returns {} for insights.json when it parses to a number', () => {
        writeUnified('insights.json', 99);
        const data = loadData(tmpDataDir);
        assert.deepEqual(data.insights, {});
    });
});
