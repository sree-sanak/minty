/**
 * crm/source-scheduler.js — Pure source scheduling and backoff logic.
 *
 * Models per-source poll schedules with exponential backoff on failure.
 * Scaffolding for future daemon scheduler integration — no side effects,
 * no timers, just pure functions over state objects.
 */

'use strict';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;    // 6 hours cap
const BACKOFF_BASE_MS = 60 * 1000;             // 1 minute base

/**
 * Create a fresh schedule state for a source.
 */
function createSchedule(opts = {}) {
    return {
        intervalMs: opts.intervalMs || DEFAULT_INTERVAL_MS,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        lastError: null,
    };
}

/**
 * Compute exponential backoff delay: base * 2^(failures-1), capped.
 */
function computeBackoff(consecutiveFailures) {
    if (consecutiveFailures <= 0) return 0;
    const delay = BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1);
    return Math.min(delay, MAX_BACKOFF_MS);
}

/**
 * Compute the next run time (ms since epoch) for a schedule.
 * Returns 0 (run immediately) if never run before.
 */
function nextRunAt(schedule) {
    if (!schedule.lastRunAt) return 0;
    const base = new Date(schedule.lastRunAt).getTime();
    const backoff = computeBackoff(schedule.consecutiveFailures);
    const interval = Math.max(schedule.intervalMs, backoff);
    const next = base + interval;
    return next;
}

/**
 * Returns true if a source is due to run.
 */
function isDue(schedule, now) {
    const ts = typeof now === 'number' ? now : Date.now();
    return ts >= nextRunAt(schedule);
}

/**
 * Record a successful run. Resets backoff.
 */
function recordSuccess(schedule, now) {
    const ts = typeof now === 'number' ? now : Date.now();
    const isoNow = new Date(ts).toISOString();
    return {
        ...schedule,
        consecutiveFailures: 0,
        lastRunAt: isoNow,
        lastSuccessAt: isoNow,
        lastError: null,
    };
}

/**
 * Record a failed run. Increments backoff.
 */
function recordFailure(schedule, error, now) {
    const ts = typeof now === 'number' ? now : Date.now();
    const isoNow = new Date(ts).toISOString();
    const msg = (typeof error === 'string' ? error : (error && error.message) || 'unknown error');
    return {
        ...schedule,
        consecutiveFailures: schedule.consecutiveFailures + 1,
        lastRunAt: isoNow,
        lastErrorAt: isoNow,
        lastError: msg.slice(0, 256),
    };
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    MAX_BACKOFF_MS,
    BACKOFF_BASE_MS,
    createSchedule,
    computeBackoff,
    nextRunAt,
    isDue,
    recordSuccess,
    recordFailure,
};
