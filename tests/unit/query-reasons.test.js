/**
 * Tests for crm/query-reasons.js — semantic expansion + per-result evidence.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    expandTerm,
    expandQuery,
    extractFreeTerms,
    buildReasons,
    annotateResults,
    collectContactText,
    explainKeywordMatch,
    titleCase,
    TERM_EXPANSIONS,
} = require('../../crm/query-reasons');

test('[Reasons] expandTerm returns expansions for known terms', () => {
    const x = expandTerm('notification');
    assert.ok(x.length > 1);
    assert.ok(x.includes('pubsub'));
    assert.ok(x.includes('alerts'));
});

test('[Reasons] expandTerm passes through unknown terms', () => {
    assert.deepEqual(expandTerm('xenophobia'), ['xenophobia']);
});

test('[Reasons] extractFreeTerms drops stop-words and role/location fragments', () => {
    const parsed = { raw: 'who works on notification systems at Stripe in London?', roles: [], locations: ['london'] };
    const terms = extractFreeTerms(parsed.raw, parsed);
    // Should include "notification systems" bigram or "notification"
    const joined = terms.join(' ');
    assert.ok(joined.includes('notification'));
    assert.ok(joined.includes('stripe'));
    assert.ok(!joined.split(/\s+/).includes('london'));
    assert.ok(!joined.split(/\s+/).includes('who'));
});

test('[Reasons] expandQuery expands free terms to synonyms', () => {
    const parsed = { raw: 'anyone in payments?', roles: [], locations: [] };
    const { expandedTerms } = expandQuery(parsed);
    assert.ok(expandedTerms.includes('payments'));
    assert.ok(expandedTerms.includes('billing'));
});

test('[Reasons] expandQuery keeps DeFi expansion narrow and non-protocol-specific', () => {
    const parsed = { raw: 'Who do I know working in DeFi space?', roles: [], locations: [] };
    const { freeTerms, expandedTerms } = expandQuery(parsed);
    assert.deepEqual(freeTerms, ['defi']);
    assert.ok(expandedTerms.includes('defi'));
    assert.ok(expandedTerms.includes('decentralized finance'));
    assert.ok(!expandedTerms.includes('lending protocol'));
    assert.ok(!expandedTerms.includes('staking'));
});

test('[Reasons] expandQuery expands generic building/startup phrasing around any domain', () => {
    const parsed = { raw: "Who do I know right now that's building an AI startup?", roles: [], locations: [] };
    const { freeTerms, expandedTerms } = expandQuery(parsed);
    assert.ok(freeTerms.includes('ai'));
    assert.ok(freeTerms.includes('building'));
    assert.ok(freeTerms.includes('startup'));
    assert.ok(expandedTerms.includes('llm'));
    assert.ok(expandedTerms.includes('founder'));
    assert.ok(expandedTerms.includes('company'));
});

test('[Reasons] buildReasons emits role + location evidence', () => {
    const parsed = { raw: 'founders in London', roles: ['founder'], locations: ['london'], intent: 'find' };
    const c = { id: 'c_1', name: 'X', roles: ['founder'], city: 'london', relationshipScore: 30, company: 'Hooli' };
    const reasons = buildReasons(c, parsed, {});
    const kinds = reasons.map(r => r.kind);
    assert.ok(kinds.includes('role'));
    assert.ok(kinds.includes('location'));
});

test('[Reasons] buildReasons surfaces keyword matches against Apollo/LinkedIn fields', () => {
    const parsed = { raw: 'investors in fintech', roles: ['investor'], locations: [], intent: 'find' };
    const c = {
        id: 'c_1', name: 'Y', roles: ['investor'], city: null, relationshipScore: 20,
        company: 'Seedcamp',
        sources: { linkedin: { company: 'Seedcamp', position: 'Partner, Fintech' } },
        apollo: { headline: 'Fintech investor at Seedcamp' },
    };
    const reasons = buildReasons(c, parsed, {});
    assert.ok(reasons.some(r => r.kind === 'keyword' && /fintech/i.test(r.detail || '')));
});

test('[Reasons] keyword reasons include contact-source citation metadata', () => {
    const parsed = { raw: 'stripe payments', roles: [], locations: [], intent: 'find' };
    const candidate = {
        id: 'c_stripe',
        name: 'Dana Stripe',
        company: 'Stripe',
        title: 'Payments Lead',
        relationshipScore: 70,
        daysSinceContact: 3,
    };
    const reasons = buildReasons(candidate, parsed, { contactsById: { c_stripe: candidate } });
    const keyword = reasons.find(r => r.kind === 'keyword' && r.label === 'stripe');

    assert.ok(keyword, 'keyword reason exists');
    assert.deepEqual(keyword.citation, {
        source: 'contact',
        subjectId: 'c_stripe',
        field: 'company',
        provenance: 'local-contact',
        observedAt: null,
    });
});

test('[Reasons] buildReasons pulls topic match from insights.json', () => {
    const parsed = { raw: 'people who work on payments', roles: [], locations: [], intent: 'find' };
    const c = { id: 'c_1', roles: ['engineer'], city: null, relationshipScore: 50 };
    const reasons = buildReasons(c, parsed, {
        insightsByContactId: { c_1: { topics: ['Stripe payments integration'] } },
    });
    assert.ok(reasons.some(r => r.kind === 'topic'));
});

test('[Reasons] topic reasons cite insights topics without raw message bodies', () => {
    const parsed = { raw: 'crypto insurance', roles: [], locations: [], intent: 'find' };
    const candidate = { id: 'c_alice', name: 'Alice', relationshipScore: 60 };
    const reasons = buildReasons(candidate, parsed, {
        contactsById: { c_alice: candidate },
        insightsByContactId: { c_alice: { topics: ['crypto insurance'], analyzedAt: '2026-05-01T10:00:00Z' } },
    });
    const topic = reasons.find(r => r.kind === 'topic');

    assert.ok(topic, 'topic reason exists');
    assert.deepEqual(topic.citation, {
        source: 'insights',
        subjectId: 'c_alice',
        field: 'topics',
        provenance: 'local-insight',
        observedAt: '2026-05-01T10:00:00Z',
    });
    assert.equal(JSON.stringify(topic).includes('message'), false);
});

test('[Reasons] annotateResults adds reasons + matchScore', () => {
    const parsed = { raw: 'founders in SF', roles: ['founder'], locations: ['san francisco'], intent: 'find' };
    const candidates = [
        { id: 'a', roles: ['founder'], city: 'san francisco', relationshipScore: 70 },
        { id: 'b', roles: ['engineer'], city: 'london', relationshipScore: 70 },
    ];
    const [r0, r1] = annotateResults(parsed, candidates, {});
    assert.ok(r0.reasons.length > 0);
    assert.ok(r0.matchScore > r1.matchScore);
});

test('[Reasons] warmth reason only appears for intro/meet intents', () => {
    const candidate = { id: 'c', roles: ['founder'], city: 'london', relationshipScore: 75 };

    // "find" intent → no warmth reason
    const find = buildReasons(candidate, { raw: 'founder in london', roles: ['founder'], locations: ['london'], intent: 'find' }, {});
    assert.ok(!find.some(r => r.kind === 'warmth'));

    // "intro" intent → warmth surfaces
    const intro = buildReasons(candidate, { raw: 'who can intro me to a founder in london', roles: ['founder'], locations: ['london'], intent: 'intro' }, {});
    assert.ok(intro.some(r => r.kind === 'warmth'));
});

test('[Reasons] recent tag surfaces for contacts spoken to recently', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 20, daysSinceContact: 2 };
    const r = buildReasons(candidate, { raw: 'x', roles: [], locations: [], intent: 'find' }, {});
    assert.ok(r.some(x => x.kind === 'recent' && /day/.test(x.detail || '')));
});

test('[Reasons] TERM_EXPANSIONS contains expected domain terms', () => {
    assert.ok(TERM_EXPANSIONS['ai']);
    assert.ok(TERM_EXPANSIONS['payments']);
    assert.ok(TERM_EXPANSIONS['fintech']);
    assert.ok(TERM_EXPANSIONS['defi']);
    assert.ok(TERM_EXPANSIONS['raise']);
});

// ---- titleCase ----

test('[Reasons] titleCase capitalises each word', () => {
    assert.equal(titleCase('hello world'), 'Hello World');
});

test('[Reasons] titleCase handles single word', () => {
    assert.equal(titleCase('founder'), 'Founder');
});

test('[Reasons] titleCase returns empty string for null/undefined', () => {
    assert.equal(titleCase(null), '');
    assert.equal(titleCase(undefined), '');
});

test('[Reasons] titleCase handles extra whitespace', () => {
    // split(/\s+/) collapses multiple spaces
    assert.equal(titleCase('series  a'), 'Series A');
});

// ---- collectContactText ----

test('[Reasons] collectContactText aggregates name, company, title fields', () => {
    const c = { name: 'Alice', company: 'Hooli', title: 'CTO' };
    const text = collectContactText(c);
    assert.ok(text.includes('alice'));
    assert.ok(text.includes('hooli'));
    assert.ok(text.includes('cto'));
});

test('[Reasons] collectContactText includes LinkedIn and Apollo metadata', () => {
    const c = {
        name: 'Bob',
        sources: { linkedin: { company: 'Stripe', position: 'Engineer' } },
        apollo: { headline: 'Payments expert', industry: 'Fintech', location: 'SF' },
    };
    const text = collectContactText(c);
    assert.ok(text.includes('stripe'));
    assert.ok(text.includes('engineer'));
    assert.ok(text.includes('payments expert'));
    assert.ok(text.includes('fintech'));
});

test('[Reasons] collectContactText includes Google Contacts org/title', () => {
    const c = {
        name: 'Carol',
        sources: { googleContacts: { org: 'Acme Corp', title: 'VP Sales' } },
    };
    const text = collectContactText(c);
    assert.ok(text.includes('acme corp'));
    assert.ok(text.includes('vp sales'));
});

test('[Reasons] collectContactText returns empty string for null', () => {
    assert.equal(collectContactText(null), '');
});

test('[Reasons] collectContactText skips undefined fields without crashing', () => {
    const text = collectContactText({ name: 'Dan' });
    assert.equal(text, 'dan');
});

// ---- explainKeywordMatch ----

test('[Reasons] explainKeywordMatch returns Company label for company match', () => {
    const c = { company: 'Stripe' };
    assert.equal(explainKeywordMatch(c, 'stripe'), 'Company: Stripe');
});

test('[Reasons] explainKeywordMatch returns Title label for title match', () => {
    const c = { title: 'VP Engineering' };
    assert.equal(explainKeywordMatch(c, 'engineering'), 'Title: VP Engineering');
});

test('[Reasons] explainKeywordMatch returns generic Company label for linkedin source match', () => {
    const c = { sources: { linkedin: { company: 'Revolut', position: 'Designer' } } };
    assert.equal(explainKeywordMatch(c, 'revolut'), 'Company: Revolut');
});

test('[Reasons] explainKeywordMatch returns generic Title label for linkedin position match', () => {
    const c = { sources: { linkedin: { company: 'Acme', position: 'ML Engineer' } } };
    assert.equal(explainKeywordMatch(c, 'ml engineer'), 'Title: ML Engineer');
});

test('[Reasons] explainKeywordMatch returns Headline for Apollo headline match', () => {
    const c = { apollo: { headline: 'Fintech founder' } };
    assert.equal(explainKeywordMatch(c, 'fintech'), 'Headline: Fintech founder');
});

test('[Reasons] explainKeywordMatch returns Industry for Apollo industry match', () => {
    const c = { apollo: { industry: 'Financial Services' } };
    assert.equal(explainKeywordMatch(c, 'financial'), 'Industry: Financial Services');
});

test('[Reasons] explainKeywordMatch returns null when no field matches', () => {
    const c = { company: 'Hooli', title: 'CEO' };
    assert.equal(explainKeywordMatch(c, 'quantum'), null);
});

test('[Reasons] explainKeywordMatch returns null for null contact', () => {
    assert.equal(explainKeywordMatch(null, 'test'), null);
});

test('[Reasons] explainKeywordMatch prefers first matching field (Company before Title)', () => {
    // If company contains the term, it should return Company even if title also matches
    const c = { company: 'Stripe Payments', title: 'Stripe Integration Lead' };
    const result = explainKeywordMatch(c, 'stripe');
    assert.ok(result.startsWith('Company:'));
});

test('[Reasons] explainKeywordMatch is case-insensitive', () => {
    const c = { company: 'STRIPE' };
    assert.equal(explainKeywordMatch(c, 'Stripe'), 'Company: STRIPE');
});

// ---- extractFreeTerms: bigram matching ----

test('[Reasons] extractFreeTerms picks up known bigrams (e.g. "big tech")', () => {
    const parsed = { raw: 'who works at big tech', roles: [], locations: [] };
    const terms = extractFreeTerms(parsed.raw, parsed);
    assert.ok(terms.includes('big tech'), 'should extract "big tech" bigram');
});

test('[Reasons] extractFreeTerms returns empty for empty/null input', () => {
    assert.deepEqual(extractFreeTerms('', { roles: [], locations: [] }), []);
    assert.deepEqual(extractFreeTerms(null, { roles: [], locations: [] }), []);
});

test('[Reasons] extractFreeTerms excludes tokens already in a matched bigram', () => {
    const parsed = { raw: 'big tech people', roles: [], locations: [] };
    const terms = extractFreeTerms(parsed.raw, parsed);
    // "big tech" is a known bigram — individual tokens "big" and "tech" should not duplicate
    assert.ok(terms.includes('big tech'));
    assert.ok(!terms.includes('big'), 'individual "big" should be suppressed by bigram');
    assert.ok(!terms.includes('tech'), 'individual "tech" should be suppressed by bigram');
});

// ---- buildReasons: warmth via regex ----

test('[Reasons] buildReasons surfaces warmth when query contains "warm" even if intent is find', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 60 };
    const parsed = { raw: 'warm contacts who work in finance', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    assert.ok(reasons.some(r => r.kind === 'warmth'));
});

test('[Reasons] buildReasons surfaces warmth when query contains "trust"', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 55 };
    const parsed = { raw: 'someone I trust in design', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    assert.ok(reasons.some(r => r.kind === 'warmth'));
});

test('[Reasons] buildReasons does not surface warmth for low relationship score', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 30 };
    const parsed = { raw: 'warm intro to a designer', roles: [], locations: [], intent: 'intro' };
    const reasons = buildReasons(candidate, parsed, {});
    assert.ok(!reasons.some(r => r.kind === 'warmth'));
});

// ---- buildReasons: recent label variants ----

test('[Reasons] buildReasons shows "Today" for daysSinceContact=0', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 10, daysSinceContact: 0 };
    const parsed = { raw: 'x', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    const recent = reasons.find(r => r.kind === 'recent');
    assert.ok(recent);
    assert.equal(recent.detail, 'Today');
});

test('[Reasons] buildReasons shows "Yesterday" for daysSinceContact=1', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 10, daysSinceContact: 1 };
    const parsed = { raw: 'x', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    const recent = reasons.find(r => r.kind === 'recent');
    assert.ok(recent);
    assert.equal(recent.detail, 'Yesterday');
});

test('[Reasons] buildReasons shows recent at boundary daysSinceContact=14', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 10, daysSinceContact: 14 };
    const parsed = { raw: 'x', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    assert.ok(reasons.some(r => r.kind === 'recent'));
});

test('[Reasons] buildReasons omits recent for daysSinceContact=15', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 10, daysSinceContact: 15 };
    const parsed = { raw: 'x', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    assert.ok(!reasons.some(r => r.kind === 'recent'));
});

// ---- buildReasons: keyword cap ----

test('[Reasons] buildReasons caps keyword reasons at 3', () => {
    // Put the same query tokens across multiple indexed text fields so the cap is
    // exercised by real keyword extraction rather than by synthetic reason data.
    const candidate = {
        id: 'c', roles: [], city: null, relationshipScore: 10,
        company: 'fintech payments billing checkout',
        sources: { linkedin: { company: 'fintech payments billing checkout', position: 'checkout billing' } },
        apollo: { headline: 'fintech payments billing checkout subscription' },
    };
    const parsed = { raw: 'fintech payments billing checkout subscription', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {});
    const kw = reasons.filter(r => r.kind === 'keyword');
    assert.ok(kw.length > 0, 'setup should exercise real keyword matches');
    assert.ok(kw.length <= 3, `keyword reasons should cap at 3, got ${kw.length}`);
});

// ---- buildReasons: topic match via raw query ----

test('[Reasons] buildReasons matches topic against raw query when expansion misses', () => {
    const candidate = { id: 'c', roles: [], city: null, relationshipScore: 10 };
    const parsed = { raw: 'quantum computing research', roles: [], locations: [], intent: 'find' };
    const reasons = buildReasons(candidate, parsed, {
        insightsByContactId: { c: { topics: ['quantum computing'] } },
    });
    assert.ok(reasons.some(r => r.kind === 'topic'));
});
