/**
 * Tests for crm/response-metrics.js — per-contact engagement signals.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    computeContactMetrics,
    computeAllMetrics,
    pairMessages,
    groupByThread,
    scoreEngagement,
    labelMetrics,
    isFromSelf,
    median,
} = require('../../crm/response-metrics');

function mk(ts, from, opts = {}) {
    return {
        timestamp: ts, from, body: 'x',
        chatId: opts.chatId || 'chat1', source: opts.source || 'whatsapp',
        _contactId: opts.contactId || 'c_1',
    };
}

const SELF = new Set(['me']);

test('[Metrics] isFromSelf matches "me" and any custom self ID', () => {
    assert.ok(isFromSelf('me', SELF));
    assert.ok(isFromSelf('+447911', new Set(['+447911'])));
    assert.equal(isFromSelf('+447911', SELF), false);
});

test('[Metrics] pairMessages matches user→contact within 14d window', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-10T10:30:00Z', 'them'),
        mk('2026-04-11T09:00:00Z', 'me'),
        mk('2026-04-11T10:00:00Z', 'them'),
    ];
    const pairs = pairMessages(msgs, SELF);
    assert.equal(pairs.length, 2);
    for (const p of pairs) {
        assert.ok(p.userMsg);
        assert.ok(p.contactReply);
    }
});

test('[Metrics] pairMessages leaves dangling user messages with no reply', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-05-10T10:00:00Z', 'them'), // > 14 days
    ];
    const pairs = pairMessages(msgs, SELF);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].contactReply, null);
});

test('[Metrics] computeContactMetrics — 100% reply, fast latency → high score', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-10T10:05:00Z', 'them'),
        mk('2026-04-11T09:00:00Z', 'me'),
        mk('2026-04-11T09:05:00Z', 'them'),
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.replyRate, 1);
    assert.ok(m.medianReplyLatencyHours < 1);
    assert.ok(m.engagementScore >= 80);
});

test('[Metrics] computeContactMetrics — ghosted contact → low score', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me'),
        mk('2026-04-11T10:00:00Z', 'me'),
        mk('2026-04-12T10:00:00Z', 'me'),
        // no replies
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.replyRate, 0);
    assert.equal(m.medianReplyLatencyHours, null);
    assert.ok(m.engagementScore < 25);
});

test('[Metrics] initiationRate — 0.5 is balanced', () => {
    const msgs = [];
    // Alternate: they start one, you start one (>24h apart gap each)
    const starts = [
        { ts: '2026-01-01T00:00:00Z', from: 'them' },
        { ts: '2026-01-03T00:00:00Z', from: 'me' },
        { ts: '2026-01-05T00:00:00Z', from: 'them' },
        { ts: '2026-01-07T00:00:00Z', from: 'me' },
    ];
    for (const s of starts) msgs.push(mk(s.ts, s.from));
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.initiationRate, 0.5);
});

test('[Metrics] scoreEngagement is bounded 0..100', () => {
    for (let i = 0; i < 20; i++) {
        const r = Math.random();
        const h = Math.random() * 200;
        const init = Math.random();
        const s = scoreEngagement({ replyRate: r, medianReplyLatencyHours: h, initiationRate: init });
        assert.ok(s >= 0 && s <= 100);
    }
});

test('[Metrics] labelMetrics produces human chips', () => {
    const m = { replyRate: 0.8, medianReplyLatencyHours: 2, userMessages: 10,
        initiationRate: 0.2, theyStarted: 2, youStarted: 8 };
    const chips = labelMetrics(m);
    assert.ok(chips.some(c => c.includes('80%')));
    assert.ok(chips.some(c => c.includes('2h')));
    assert.ok(chips.includes('you reach out'));
});

test('[Metrics] sparse signal — replyRate suppressed if < 3 user messages', () => {
    const m = { replyRate: 0.5, userMessages: 2, medianReplyLatencyHours: null, initiationRate: null };
    const chips = labelMetrics(m);
    assert.ok(!chips.some(c => c.includes('%')));
});

test('[Metrics] empty interactions → zeros, score 0', () => {
    const m = computeContactMetrics([], SELF);
    assert.equal(m.replyRate, null);
    assert.equal(m.engagementScore, 0);
});

test('[Metrics] messages without timestamp are dropped', () => {
    const msgs = [
        { ...mk('2026-04-10T10:00:00Z', 'me'), _contactId: 'c' },
        { from: 'them', body: 'x', _contactId: 'c' }, // no timestamp
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.userMessages, 1);
    assert.equal(m.replyRate, 0); // no matched reply
});

test('[Metrics] different chat threads are separate', () => {
    const msgs = [
        mk('2026-04-10T10:00:00Z', 'me', { chatId: 'a' }),
        mk('2026-04-10T10:05:00Z', 'them', { chatId: 'a' }),
        mk('2026-04-11T10:00:00Z', 'me', { chatId: 'b' }),
        // no reply in thread 'b'
    ];
    const m = computeContactMetrics(msgs, SELF);
    assert.equal(m.userMessages, 2);
    assert.equal(m.contactReplies, 1);
    assert.equal(m.replyRate, 0.5);
});

// --- median ---

test('[Metrics] median of empty array returns 0', () => {
    assert.equal(median([]), 0);
});

test('[Metrics] median of single element returns that element', () => {
    assert.equal(median([42]), 42);
});

test('[Metrics] median of odd-length array returns middle value', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([10, 30, 20, 50, 40]), 30);
});

test('[Metrics] median of even-length array returns average of two middles', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([10, 20]), 15);
});

test('[Metrics] median does not mutate the input array', () => {
    const arr = [3, 1, 2];
    median(arr);
    assert.deepEqual(arr, [3, 1, 2]);
});

// --- groupByThread ---

test('[Metrics] groupByThread groups by contactId|chatId|source', () => {
    const interactions = [
        mk('2026-01-01T00:00:00Z', 'me', { chatId: 'c1', source: 'whatsapp', contactId: 'a' }),
        mk('2026-01-02T00:00:00Z', 'them', { chatId: 'c1', source: 'whatsapp', contactId: 'a' }),
        mk('2026-01-03T00:00:00Z', 'me', { chatId: 'c2', source: 'gmail', contactId: 'a' }),
    ];
    const threads = groupByThread(interactions);
    const keys = Object.keys(threads);
    assert.equal(keys.length, 2);
    assert.equal(threads['a|c1|whatsapp'].length, 2);
    assert.equal(threads['a|c2|gmail'].length, 1);
});

test('[Metrics] groupByThread skips interactions without _contactId', () => {
    const interactions = [
        { timestamp: '2026-01-01', from: 'me', chatId: 'c1', source: 'wa' },
        mk('2026-01-01T00:00:00Z', 'me', { contactId: 'a' }),
    ];
    const threads = groupByThread(interactions);
    assert.equal(Object.keys(threads).length, 1);
});

test('[Metrics] groupByThread falls back when chatId is missing', () => {
    const interactions = [
        { timestamp: '2026-01-01', from: 'me', source: 'gmail', _contactId: 'b' },
        { timestamp: '2026-01-02', from: 'them', source: 'gmail', _contactId: 'b' },
    ];
    const threads = groupByThread(interactions);
    assert.equal(Object.keys(threads).length, 1);
    assert.equal(threads['b||gmail'].length, 2);
});

// --- computeAllMetrics ---

test('[Metrics] computeAllMetrics returns metrics keyed by contactId', () => {
    const interactions = [
        mk('2026-04-10T10:00:00Z', 'me', { contactId: 'alice' }),
        mk('2026-04-10T10:05:00Z', 'them', { contactId: 'alice' }),
        mk('2026-04-11T10:00:00Z', 'me', { contactId: 'bob' }),
    ];
    const result = computeAllMetrics(interactions, SELF);
    assert.ok(result.alice);
    assert.ok(result.bob);
    assert.equal(result.alice.replyRate, 1);
    assert.equal(result.bob.replyRate, 0);
});

test('[Metrics] computeAllMetrics skips interactions without _contactId', () => {
    const interactions = [
        { timestamp: '2026-01-01', from: 'me', chatId: 'c1', source: 'wa' },
    ];
    const result = computeAllMetrics(interactions, SELF);
    assert.deepEqual(result, {});
});

test('[Metrics] computeAllMetrics with empty array returns empty object', () => {
    assert.deepEqual(computeAllMetrics([], SELF), {});
});

// ---------------------------------------------------------------------------
// scoreEngagement — deterministic tier tests
// ---------------------------------------------------------------------------

test('[Metrics] scoreEngagement: all nulls → neutral baseline (30)', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: null, initiationRate: null });
    assert.equal(s, 30); // 15 + 9 + 6
});

test('[Metrics] scoreEngagement: perfect metrics → 100', () => {
    // replyRate 1.0 → 50, latency < 1h → 30, initiationRate 0.5 → 20
    const s = scoreEngagement({ replyRate: 1.0, medianReplyLatencyHours: 0.5, initiationRate: 0.5 });
    assert.equal(s, 100);
});

test('[Metrics] scoreEngagement: zero reply rate → latency + initiation only', () => {
    const s = scoreEngagement({ replyRate: 0, medianReplyLatencyHours: 0.5, initiationRate: 0.5 });
    assert.equal(s, 50); // 0 + 30 + 20
});

test('[Metrics] scoreEngagement: latency tier < 1h → 30', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: 0.5, initiationRate: null });
    assert.equal(s, 51); // 15 + 30 + 6
});

test('[Metrics] scoreEngagement: latency tier 1-6h → 24', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: 3, initiationRate: null });
    assert.equal(s, 45); // 15 + 24 + 6
});

test('[Metrics] scoreEngagement: latency tier 6-24h → 18', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: 12, initiationRate: null });
    assert.equal(s, 39); // 15 + 18 + 6
});

test('[Metrics] scoreEngagement: latency tier 24-72h → 10', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: 48, initiationRate: null });
    assert.equal(s, 31); // 15 + 10 + 6
});

test('[Metrics] scoreEngagement: latency tier > 72h → 3', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: 100, initiationRate: null });
    assert.equal(s, 24); // 15 + 3 + 6
});

test('[Metrics] scoreEngagement: one-sided initiation (0.0) penalised', () => {
    // initiationRate 0.0 → dist 0.5 → 20 - 20 = 0
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: null, initiationRate: 0 });
    assert.equal(s, 24); // 15 + 9 + 0
});

test('[Metrics] scoreEngagement: one-sided initiation (1.0) penalised', () => {
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: null, initiationRate: 1.0 });
    assert.equal(s, 24); // 15 + 9 + 0
});

test('[Metrics] scoreEngagement: slightly off-center initiation (0.4) → partial credit', () => {
    // dist = 0.1, 20 - 4 = 16
    const s = scoreEngagement({ replyRate: null, medianReplyLatencyHours: null, initiationRate: 0.4 });
    assert.equal(s, 40); // 15 + 9 + 16
});

// ---------------------------------------------------------------------------
// labelMetrics — formatting edge cases
// ---------------------------------------------------------------------------

test('[Metrics] labelMetrics: sub-minute latency floors to 1m', () => {
    const m = { replyRate: null, medianReplyLatencyHours: 0.001, userMessages: 0,
        initiationRate: null, theyStarted: 0, youStarted: 0 };
    const chips = labelMetrics(m);
    assert.ok(chips.includes('1m avg'));
});

test('[Metrics] labelMetrics: 30-minute latency → "30m avg"', () => {
    const m = { replyRate: null, medianReplyLatencyHours: 0.5, userMessages: 0,
        initiationRate: null, theyStarted: 0, youStarted: 0 };
    const chips = labelMetrics(m);
    assert.ok(chips.includes('30m avg'));
});

test('[Metrics] labelMetrics: 36-hour latency → "2d avg"', () => {
    const m = { replyRate: null, medianReplyLatencyHours: 36, userMessages: 0,
        initiationRate: null, theyStarted: 0, youStarted: 0 };
    const chips = labelMetrics(m);
    assert.ok(chips.includes('2d avg'));
});

test('[Metrics] labelMetrics: initiationRate > 0.7 with enough starts → "they reach out"', () => {
    const m = { replyRate: null, medianReplyLatencyHours: null, userMessages: 0,
        initiationRate: 0.8, theyStarted: 4, youStarted: 1 };
    const chips = labelMetrics(m);
    assert.ok(chips.includes('they reach out'));
});

test('[Metrics] labelMetrics: initiationRate between 0.3 and 0.7 → "balanced"', () => {
    const m = { replyRate: null, medianReplyLatencyHours: null, userMessages: 0,
        initiationRate: 0.5, theyStarted: 3, youStarted: 3 };
    const chips = labelMetrics(m);
    assert.ok(chips.includes('balanced'));
});

test('[Metrics] labelMetrics: < 3 conversation starts suppresses initiation label', () => {
    const m = { replyRate: null, medianReplyLatencyHours: null, userMessages: 0,
        initiationRate: 0.5, theyStarted: 1, youStarted: 1 };
    const chips = labelMetrics(m);
    assert.ok(!chips.some(c => c.includes('balanced') || c.includes('reach out')));
});

test('[Metrics] labelMetrics: all metrics present → 3 chips', () => {
    const m = { replyRate: 0.9, medianReplyLatencyHours: 0.25, userMessages: 10,
        initiationRate: 0.5, theyStarted: 5, youStarted: 5 };
    const chips = labelMetrics(m);
    assert.equal(chips.length, 3);
    assert.ok(chips[0].includes('90%'));
    assert.ok(chips[1].includes('m avg'));
    assert.ok(chips[2] === 'balanced');
});

test('[Metrics] labelMetrics: no data → empty chips', () => {
    const m = { replyRate: null, medianReplyLatencyHours: null, userMessages: 0,
        initiationRate: null, theyStarted: 0, youStarted: 0 };
    const chips = labelMetrics(m);
    assert.deepEqual(chips, []);
});
