/**
 * Tests for crm/analyze.js — pure functions: buildIndex, getContactInteractions,
 * computeSourceSplit, extractKeywords.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildIndex,
    getContactInteractions,
    computeSourceSplit,
    extractKeywords,
} = require('../../crm/analyze');

// ── helpers ──────────────────────────────────────────────────────────────

function mkInteraction(overrides = {}) {
    return {
        id: overrides.id || null,
        source: 'whatsapp',
        chatId: 'chat1',
        from: 'them',
        timestamp: '2026-04-01T10:00:00Z',
        body: 'hello',
        ...overrides,
    };
}

function mkContact(overrides = {}) {
    return {
        id: 'c_1',
        name: 'Alice',
        emails: [],
        sources: {},
        ...overrides,
    };
}

// ── buildIndex ───────────────────────────────────────────────────────────

test('[Analyze] buildIndex indexes by chatId', () => {
    const items = [
        mkInteraction({ chatId: 'wa_123', from: 'me' }),
        mkInteraction({ chatId: 'wa_123', from: 'them' }),
        mkInteraction({ chatId: 'wa_456', from: 'other' }),
    ];
    const idx = buildIndex(items);
    assert.equal(idx.byChatId['wa_123'].length, 2);
    assert.equal(idx.byChatId['wa_456'].length, 1);
});

test('[Analyze] buildIndex indexes by from, skipping "me"', () => {
    const items = [
        mkInteraction({ from: 'me' }),
        mkInteraction({ from: 'alice' }),
        mkInteraction({ from: 'alice' }),
    ];
    const idx = buildIndex(items);
    assert.equal(idx.byFrom['me'], undefined);
    assert.equal(idx.byFrom['alice'].length, 2);
});

test('[Analyze] buildIndex indexes LinkedIn by chatName (multi-name split)', () => {
    const items = [
        mkInteraction({ source: 'linkedin', chatName: 'Alice, Bob' }),
    ];
    const idx = buildIndex(items);
    assert.equal(idx.byLiName['Alice'].length, 1);
    assert.equal(idx.byLiName['Bob'].length, 1);
});

test('[Analyze] buildIndex indexes email by from and to', () => {
    const items = [
        mkInteraction({ source: 'email', from: 'a@x.com', to: ['b@x.com', 'c@x.com'] }),
    ];
    const idx = buildIndex(items);
    assert.equal(idx.byEmail['a@x.com'].length, 1);
    assert.equal(idx.byEmail['b@x.com'].length, 1);
    assert.equal(idx.byEmail['c@x.com'].length, 1);
});

test('[Analyze] buildIndex handles email with string to (not array)', () => {
    const items = [
        mkInteraction({ source: 'email', from: 'a@x.com', to: 'b@x.com' }),
    ];
    const idx = buildIndex(items);
    assert.equal(idx.byEmail['b@x.com'].length, 1);
});

test('[Analyze] buildIndex returns empty buckets for empty input', () => {
    const idx = buildIndex([]);
    assert.deepEqual(idx, { byChatId: {}, byFrom: {}, byLiName: {}, byEmail: {} });
});

// ── getContactInteractions ───────────────────────────────────────────────

test('[Analyze] getContactInteractions collects via WhatsApp chatId', () => {
    const items = [
        mkInteraction({ chatId: 'wa_1', from: 'wa_1', body: 'hi' }),
        mkInteraction({ chatId: 'wa_2', from: 'wa_2', body: 'other' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { whatsapp: { id: 'wa_1' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
    assert.equal(result[0].body, 'hi');
});

test('[Analyze] getContactInteractions collects via LinkedIn name', () => {
    const items = [
        mkInteraction({ source: 'linkedin', chatName: 'Alice' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { linkedin: { name: 'Alice' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
});

test('[Analyze] getContactInteractions collects via email', () => {
    const items = [
        mkInteraction({ source: 'email', from: 'a@x.com', to: ['b@x.com'] }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ emails: ['a@x.com'] });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
});

test('[Analyze] getContactInteractions collects via SMS phone', () => {
    const items = [
        mkInteraction({ chatId: '+1234567890', source: 'sms', body: 'sms msg' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { sms: { phone: '+1234567890' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
    assert.equal(result[0].body, 'sms msg');
});

test('[Analyze] getContactInteractions deduplicates by id', () => {
    // Same interaction matched via chatId and from
    const items = [
        mkInteraction({ id: 'i_1', chatId: 'wa_1', from: 'wa_1' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { whatsapp: { id: 'wa_1' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
});

test('[Analyze] getContactInteractions deduplicates by synthetic key when no id', () => {
    const items = [
        mkInteraction({ id: null, chatId: 'wa_1', from: 'wa_1', source: 'whatsapp', timestamp: 'T1', body: 'same' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { whatsapp: { id: 'wa_1' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 1);
});

test('[Analyze] getContactInteractions sorts newest first', () => {
    const items = [
        mkInteraction({ id: 'i_1', chatId: 'wa_1', timestamp: '2026-01-01T00:00:00Z' }),
        mkInteraction({ id: 'i_2', chatId: 'wa_1', timestamp: '2026-04-01T00:00:00Z' }),
    ];
    const idx = buildIndex(items);
    const contact = mkContact({ sources: { whatsapp: { id: 'wa_1' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result[0].id, 'i_2');
    assert.equal(result[1].id, 'i_1');
});

test('[Analyze] getContactInteractions returns empty for no-match contact', () => {
    const idx = buildIndex([]);
    const contact = mkContact({ sources: { whatsapp: { id: 'wa_none' } } });
    const result = getContactInteractions(contact, idx);
    assert.equal(result.length, 0);
});

// ── computeSourceSplit ───────────────────────────────────────────────────

test('[Analyze] computeSourceSplit counts by source', () => {
    const items = [
        mkInteraction({ source: 'whatsapp' }),
        mkInteraction({ source: 'whatsapp' }),
        mkInteraction({ source: 'linkedin' }),
        mkInteraction({ source: 'email' }),
    ];
    assert.deepEqual(computeSourceSplit(items), { whatsapp: 2, linkedin: 1, email: 1 });
});

test('[Analyze] computeSourceSplit returns empty object for empty input', () => {
    assert.deepEqual(computeSourceSplit([]), {});
});

// ── extractKeywords ──────────────────────────────────────────────────────

test('[Analyze] extractKeywords filters stop words and short words', () => {
    const items = [
        mkInteraction({ body: 'the quick brown foxes jumped over lazy dogs' }),
    ];
    const kw = extractKeywords(items);
    assert.ok(!kw.includes('the'));
    assert.ok(!kw.includes('over'));
    assert.ok(kw.includes('quick'));
    assert.ok(kw.includes('foxes'));
});

test('[Analyze] extractKeywords ranks by frequency', () => {
    const items = [
        mkInteraction({ body: 'startup fundraising pitch deck' }),
        mkInteraction({ body: 'startup pitch practice' }),
        mkInteraction({ body: 'startup growth metrics' }),
    ];
    const kw = extractKeywords(items, 3);
    assert.equal(kw[0], 'startup'); // appears 3 times
});

test('[Analyze] extractKeywords respects topN limit', () => {
    const items = [
        mkInteraction({ body: 'alpha beta gamma delta epsilon' }),
    ];
    const kw = extractKeywords(items, 2);
    assert.equal(kw.length, 2);
});

test('[Analyze] extractKeywords uses subject when body is missing', () => {
    const items = [
        mkInteraction({ body: '', subject: 'quarterly review report update' }),
    ];
    const kw = extractKeywords(items);
    assert.ok(kw.includes('quarterly'));
    assert.ok(kw.includes('review'));
});

test('[Analyze] extractKeywords returns empty for empty input', () => {
    assert.deepEqual(extractKeywords([]), []);
});

test('[Analyze] extractKeywords strips non-alpha characters', () => {
    const items = [
        mkInteraction({ body: 'meeting@3pm re: project-updates (2026)' }),
    ];
    const kw = extractKeywords(items);
    // "meeting" and "project" and "updates" should survive; numbers/symbols stripped
    assert.ok(kw.includes('meeting'));
    assert.ok(kw.includes('project'));
    assert.ok(kw.includes('updates'));
});
