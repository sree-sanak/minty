/**
 * Characterization tests for goal-retro.js edge cases.
 *
 * These cover narrate() branches and buildGoalRetro() input variations
 * that the main test file doesn't exercise.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildGoalRetro, narrate, DEFAULT_STAGES } = require('../../crm/goal-retro');

function mk(id, overrides = {}) {
    return {
        id, name: id, phones: [], emails: [],
        sources: { linkedin: { company: 'X' }, googleContacts: null, whatsapp: null, telegram: null, email: null, sms: null },
        relationshipScore: 50, daysSinceContact: null, isGroup: false,
        ...overrides,
    };
}

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const SELF = new Set(['me']);

// -----------------------------------------------------------------------
// buildGoalRetro — input edge cases
// -----------------------------------------------------------------------

test('[Retro] null goal returns null', () => {
    assert.equal(buildGoalRetro(null, [], {}, SELF, NOW), null);
});

test('[Retro] goal without stages uses DEFAULT_STAGES', () => {
    const goal = { id: 'g_1', text: 'X', assignments: {} };
    const r = buildGoalRetro(goal, [], {}, SELF, NOW);
    assert.deepEqual(r.stages, DEFAULT_STAGES);
});

test('[Retro] goal with empty stages array uses DEFAULT_STAGES', () => {
    const goal = { id: 'g_1', text: 'X', stages: [], assignments: {} };
    const r = buildGoalRetro(goal, [], {}, SELF, NOW);
    assert.deepEqual(r.stages, DEFAULT_STAGES);
});

test('[Retro] assignment stage matching is case-insensitive', () => {
    const goal = {
        id: 'g_1', text: 'X',
        stages: ['Contacted', 'Meeting'],
        assignments: {
            c_1: { stage: 'contacted', updatedAt: '2026-04-15T00:00:00Z' },
            c_2: { stage: 'MEETING', updatedAt: '2026-04-15T00:00:00Z' },
        },
    };
    const contacts = [mk('c_1'), mk('c_2')];
    const r = buildGoalRetro(goal, contacts, {}, SELF, NOW);
    assert.equal(r.funnel[0].count, 1, 'lowercase "contacted" matches "Contacted"');
    assert.equal(r.funnel[1].count, 1, 'uppercase "MEETING" matches "Meeting"');
});

test('[Retro] assignment with unknown stage is skipped', () => {
    const goal = {
        id: 'g_1', text: 'X',
        stages: ['A', 'B'],
        assignments: { c_1: { stage: 'Nonexistent', updatedAt: '2026-04-15T00:00:00Z' } },
    };
    const r = buildGoalRetro(goal, [mk('c_1')], {}, SELF, NOW);
    assert.equal(r.aggregate.totalAssigned, 0);
});

test('[Retro] contact missing from contacts list is skipped', () => {
    const goal = {
        id: 'g_1', text: 'X',
        stages: ['A'],
        assignments: { c_missing: { stage: 'A', updatedAt: '2026-04-15T00:00:00Z' } },
    };
    const r = buildGoalRetro(goal, [], {}, SELF, NOW);
    assert.equal(r.aggregate.totalAssigned, 0);
});

// -----------------------------------------------------------------------
// narrate — branch coverage
// -----------------------------------------------------------------------

test('[Retro] narrate singular: "1 contact in pipeline"', () => {
    const agg = { totalAssigned: 1, progressed: 100, stuck: 0, moving: 1, ghosted: 0, replied: 0 };
    const funnel = [{ stage: 'A', count: 0, contacts: [] }, { stage: 'B', count: 1, contacts: [] }];
    const n = narrate({ text: 'X' }, agg, ['A', 'B'], funnel);
    assert.match(n, /1 contact in pipeline/);
    assert.ok(!n.includes('contacts in pipeline'), 'should not pluralize for 1');
});

test('[Retro] narrate ghosted branch', () => {
    const agg = { totalAssigned: 5, progressed: 20, stuck: 0, moving: 3, ghosted: 2, replied: 0 };
    const funnel = [{ stage: 'A', count: 5, contacts: [] }];
    const n = narrate({ text: 'X' }, agg, ['A'], funnel);
    assert.match(n, /ghosted you/);
    assert.match(n, /2 ghosted/);
});

test('[Retro] narrate no callout when no stuck, no ghosted, low replies', () => {
    // Not stuck, not ghosted, replied < 1/3 of total → no third sentence
    const agg = { totalAssigned: 9, progressed: 33, stuck: 0, moving: 5, ghosted: 0, replied: 1 };
    const funnel = [{ stage: 'A', count: 6, contacts: [] }, { stage: 'B', count: 3, contacts: [] }];
    const n = narrate({ text: 'X' }, agg, ['A', 'B'], funnel);
    assert.ok(!n.includes('ghosted'), 'no ghosted callout');
    assert.ok(!n.includes('No movement'), 'no stuck callout');
    assert.ok(!n.includes('Strong response'), 'no strong response callout');
    // Should still have pipeline count + busiest stage
    assert.match(n, /9 contacts in pipeline/);
    assert.match(n, /Most people are at "A"/);
});

test('[Retro] narrate empty goal text falls back to "this goal"', () => {
    const agg = { totalAssigned: 0 };
    const n = narrate({ text: '' }, agg, [], []);
    assert.match(n, /this goal/);
});
