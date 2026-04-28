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

test('[Reasons] buildReasons pulls topic match from insights.json', () => {
    const parsed = { raw: 'people who work on payments', roles: [], locations: [], intent: 'find' };
    const c = { id: 'c_1', roles: ['engineer'], city: null, relationshipScore: 50 };
    const reasons = buildReasons(c, parsed, {
        insightsByContactId: { c_1: { topics: ['Stripe payments integration'] } },
    });
    assert.ok(reasons.some(r => r.kind === 'topic'));
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

test('[Reasons] explainKeywordMatch returns LinkedIn company for linkedin source match', () => {
    const c = { sources: { linkedin: { company: 'Revolut', position: 'Designer' } } };
    assert.equal(explainKeywordMatch(c, 'revolut'), 'LinkedIn company: Revolut');
});

test('[Reasons] explainKeywordMatch returns LinkedIn title for linkedin position match', () => {
    const c = { sources: { linkedin: { company: 'Acme', position: 'ML Engineer' } } };
    assert.equal(explainKeywordMatch(c, 'ml engineer'), 'LinkedIn title: ML Engineer');
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
