'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_INTERVAL_MS,
    MAX_BACKOFF_MS,
    BACKOFF_BASE_MS,
    createSchedule,
    computeBackoff,
    nextRunAt,
    isDue,
    recordSuccess,
    recordFailure,
} = require('../../crm/source-scheduler');

// ---------------------------------------------------------------------------
// createSchedule
// ---------------------------------------------------------------------------

test('[source-scheduler] createSchedule: defaults', () => {
    const s = createSchedule();
    assert.equal(s.intervalMs, DEFAULT_INTERVAL_MS);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastRunAt, null);
    assert.equal(s.lastError, null);
});

test('[source-scheduler] createSchedule: custom interval', () => {
    const s = createSchedule({ intervalMs: 5000 });
    assert.equal(s.intervalMs, 5000);
});

// ---------------------------------------------------------------------------
// computeBackoff
// ---------------------------------------------------------------------------

test('[source-scheduler] computeBackoff: 0 failures = no backoff', () => {
    assert.equal(computeBackoff(0), 0);
});

test('[source-scheduler] computeBackoff: 1 failure = base', () => {
    assert.equal(computeBackoff(1), BACKOFF_BASE_MS);
});

test('[source-scheduler] computeBackoff: 2 failures = 2x base', () => {
    assert.equal(computeBackoff(2), BACKOFF_BASE_MS * 2);
});

test('[source-scheduler] computeBackoff: 3 failures = 4x base', () => {
    assert.equal(computeBackoff(3), BACKOFF_BASE_MS * 4);
});

test('[source-scheduler] computeBackoff: caps at MAX_BACKOFF_MS', () => {
    assert.equal(computeBackoff(100), MAX_BACKOFF_MS);
});

// ---------------------------------------------------------------------------
// nextRunAt / isDue
// ---------------------------------------------------------------------------

test('[source-scheduler] nextRunAt: never run = 0 (immediate)', () => {
    const s = createSchedule();
    assert.equal(nextRunAt(s), 0);
});

test('[source-scheduler] isDue: never run = true', () => {
    const s = createSchedule();
    assert.equal(isDue(s), true);
});

test('[source-scheduler] isDue: just ran = false', () => {
    const now = Date.now();
    let s = createSchedule({ intervalMs: 60000 });
    s = recordSuccess(s, now);
    assert.equal(isDue(s, now + 1000), false);
});

test('[source-scheduler] isDue: interval elapsed = true', () => {
    const now = Date.now();
    let s = createSchedule({ intervalMs: 60000 });
    s = recordSuccess(s, now);
    assert.equal(isDue(s, now + 60001), true);
});

test('[source-scheduler] isDue: backoff extends next run', () => {
    const now = Date.now();
    let s = createSchedule({ intervalMs: 60000 });
    s = recordFailure(s, 'err', now);
    // 1 failure → 60s backoff, which equals interval. Not due after 30s.
    assert.equal(isDue(s, now + 30000), false);
    // Due after backoff
    assert.equal(isDue(s, now + 60001), true);
});

test('[source-scheduler] nextRunAt: corrupt lastRunAt fails open instead of stalling', () => {
    const s = { ...createSchedule({ intervalMs: 60000 }), lastRunAt: 'not-a-date' };
    assert.equal(nextRunAt(s), 0);
    assert.equal(isDue(s, Date.now()), true);
});

test('[source-scheduler] isDue: multiple failures increase backoff', () => {
    const now = Date.now();
    let s = createSchedule({ intervalMs: 60000 });
    s = recordFailure(s, 'err1', now);
    s = recordFailure(s, 'err2', now);
    // 2 failures → 120s backoff > 60s interval
    assert.equal(isDue(s, now + 61000), false);
    assert.equal(isDue(s, now + 120001), true);
});

// ---------------------------------------------------------------------------
// recordSuccess / recordFailure
// ---------------------------------------------------------------------------

test('[source-scheduler] recordSuccess: resets failures', () => {
    let s = createSchedule();
    s = recordFailure(s, 'err');
    s = recordFailure(s, 'err');
    assert.equal(s.consecutiveFailures, 2);
    s = recordSuccess(s);
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.lastError, null);
    assert.ok(s.lastSuccessAt);
});

test('[source-scheduler] recordFailure: increments and records error', () => {
    let s = createSchedule();
    s = recordFailure(s, new Error('boom'));
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastError, 'boom');
    assert.ok(s.lastErrorAt);
});

test('[source-scheduler] recordFailure: truncates long errors', () => {
    let s = createSchedule();
    s = recordFailure(s, 'x'.repeat(500));
    assert.ok(s.lastError.length <= 256);
});
