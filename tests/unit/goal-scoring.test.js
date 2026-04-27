'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    scoreContactForGoal,
    rankContactsForGoal,
    healthRingColor,
    healthRingOffset,
} = require('../../crm/utils');

// ---------------------------------------------------------------------------
// scoreContactForGoal
// ---------------------------------------------------------------------------

test('scoreContactForGoal: returns 0 for null/missing inputs', () => {
    assert.equal(scoreContactForGoal(null, 'fundraise'), 0);
    assert.equal(scoreContactForGoal({}, null), 0);
    assert.equal(scoreContactForGoal(null, null), 0);
});

test('scoreContactForGoal: VC contact scores high for fundraise goal', () => {
    const contact = {
        name: 'Jane Doe',
        position: 'Partner at Sequoia Capital',
        company: 'Sequoia',
        relationshipScore: 80,
    };
    const score = scoreContactForGoal(contact, 'raise a seed round');
    // Should get: role match (40) + keyword overlap + warmth bonus (16)
    assert.ok(score >= 56, `expected >=56 for VC+fundraise, got ${score}`);
    assert.ok(score <= 100);
});

test('scoreContactForGoal: engineer scores high for hiring goal', () => {
    const contact = {
        name: 'Bob Smith',
        position: 'Senior Software Engineer',
        company: 'Google',
        relationshipScore: 60,
    };
    const score = scoreContactForGoal(contact, 'hire a backend engineer');
    // role match (40) + keyword overlap for "engineer"/"backend" + warmth
    assert.ok(score >= 40, `expected >=40 for engineer+hire, got ${score}`);
});

test('scoreContactForGoal: unrelated contact scores low', () => {
    const contact = {
        name: 'Alice Johnson',
        position: 'Florist',
        company: 'Local Flowers',
        relationshipScore: 90,
    };
    const score = scoreContactForGoal(contact, 'raise a seed round');
    // No role match, no keyword overlap, only warmth (18)
    assert.ok(score <= 20, `expected <=20 for unrelated contact, got ${score}`);
});

test('scoreContactForGoal: warmth bonus from relationshipScore', () => {
    const cold = { name: 'A', position: 'VC Partner', relationshipScore: 0 };
    const warm = { name: 'A', position: 'VC Partner', relationshipScore: 100 };
    const coldScore = scoreContactForGoal(cold, 'raise a round');
    const warmScore = scoreContactForGoal(warm, 'raise a round');
    assert.ok(warmScore > coldScore, 'warmer contact should score higher');
    assert.ok(warmScore - coldScore <= 20, 'warmth diff should be at most 20');
});

test('scoreContactForGoal: capped at 100', () => {
    const contact = {
        name: 'Super Contact',
        position: 'Venture Capital Investor Angel Partner GP',
        company: 'Fund Capital Partners',
        relationshipScore: 100,
        apollo: { headline: 'investor vc angel fund capital' },
    };
    const score = scoreContactForGoal(contact, 'raise venture capital fund investment round');
    assert.ok(score <= 100, `score should be capped at 100, got ${score}`);
});

test('scoreContactForGoal: apollo and linkedin sources contribute to matching', () => {
    const contact = {
        name: 'Pat Lee',
        position: '',
        company: '',
        apollo: { headline: 'Managing Director at PE firm', industry: 'Private Equity' },
        sources: { linkedin: { company: 'Blackstone', position: 'VP' } },
        relationshipScore: 50,
    };
    const score = scoreContactForGoal(contact, 'find an advisor for strategy');
    assert.ok(score > 0, `apollo/linkedin data should contribute, got ${score}`);
});

test('scoreContactForGoal: multiple intent detection stacks role matching', () => {
    // A goal that triggers both hire + advisor intents
    const contact = {
        name: 'Chris',
        position: 'Consultant at McKinsey',
        relationshipScore: 0,
    };
    const score = scoreContactForGoal(contact, 'hire a strategy consultant advisor');
    // Should match via both 'hire' (hr/engineer/operator) and 'advisor' (consultant) intents
    assert.ok(score >= 40, `consultant should match advisor intent, got ${score}`);
});

// ---------------------------------------------------------------------------
// rankContactsForGoal
// ---------------------------------------------------------------------------

test('rankContactsForGoal: returns empty for no contacts or no goal', () => {
    assert.deepEqual(rankContactsForGoal([], 'raise money'), []);
    assert.deepEqual(rankContactsForGoal(null, 'raise money'), []);
    assert.deepEqual(rankContactsForGoal([{ name: 'A' }], ''), []);
    assert.deepEqual(rankContactsForGoal([{ name: 'A' }], null), []);
});

test('rankContactsForGoal: excludes groups', () => {
    const contacts = [
        { name: 'VC Partner', position: 'Investor', isGroup: true, relationshipScore: 100 },
        { name: 'Another VC', position: 'Investor', isGroup: false, relationshipScore: 50 },
    ];
    const results = rankContactsForGoal(contacts, 'raise a round');
    assert.ok(results.every(c => !c.isGroup), 'no groups in results');
});

test('rankContactsForGoal: excludes zero-score contacts', () => {
    const contacts = [
        { name: 'Florist', position: 'Florist', company: 'Flowers', relationshipScore: 0 },
    ];
    const results = rankContactsForGoal(contacts, 'raise a seed round');
    assert.equal(results.length, 0);
});

test('rankContactsForGoal: sorted by goalRelevance descending', () => {
    const contacts = [
        { name: 'Low Match', position: 'Baker', company: 'Bakery', relationshipScore: 90 },
        { name: 'High Match', position: 'VC Partner at Sequoia', company: 'Sequoia Capital', relationshipScore: 50 },
    ];
    const results = rankContactsForGoal(contacts, 'raise a seed round');
    if (results.length >= 2) {
        assert.ok(results[0].goalRelevance >= results[1].goalRelevance,
            'should be sorted by relevance desc');
    }
});

test('rankContactsForGoal: respects limit parameter', () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({
        name: `Contact ${i}`,
        position: 'Venture Capital Investor',
        relationshipScore: i * 10,
    }));
    const results = rankContactsForGoal(contacts, 'raise a round', 3);
    assert.ok(results.length <= 3, `expected at most 3, got ${results.length}`);
});

test('rankContactsForGoal: augments contacts with goalRelevance field', () => {
    const contacts = [
        { name: 'Jane', position: 'Angel Investor', relationshipScore: 50 },
    ];
    const results = rankContactsForGoal(contacts, 'raise a round');
    assert.ok(results.length > 0);
    assert.ok('goalRelevance' in results[0], 'should have goalRelevance field');
    assert.equal(typeof results[0].goalRelevance, 'number');
});

// ---------------------------------------------------------------------------
// healthRingColor
// ---------------------------------------------------------------------------

test('healthRingColor: score >= 70 is strong', () => {
    assert.equal(healthRingColor(70), 'strong');
    assert.equal(healthRingColor(100), 'strong');
});

test('healthRingColor: 40–69 is good', () => {
    assert.equal(healthRingColor(40), 'good');
    assert.equal(healthRingColor(69), 'good');
});

test('healthRingColor: 20–39 is warm', () => {
    assert.equal(healthRingColor(20), 'warm');
    assert.equal(healthRingColor(39), 'warm');
});

test('healthRingColor: 1–19 is fading', () => {
    assert.equal(healthRingColor(1), 'fading');
    assert.equal(healthRingColor(19), 'fading');
});

test('healthRingColor: 0 or null is none', () => {
    assert.equal(healthRingColor(0), 'none');
    assert.equal(healthRingColor(null), 'none');
});

// ---------------------------------------------------------------------------
// healthRingOffset
// ---------------------------------------------------------------------------

test('healthRingOffset: score 100 gives offset ~0', () => {
    const offset = healthRingOffset(100);
    assert.ok(offset >= 0 && offset < 1, `full ring offset should be ~0, got ${offset}`);
});

test('healthRingOffset: score 0 gives full circumference', () => {
    const C = 2 * Math.PI * 21;
    const offset = healthRingOffset(0);
    assert.ok(Math.abs(offset - C) < 0.2, `empty ring offset should be ~${C.toFixed(1)}, got ${offset}`);
});

test('healthRingOffset: score 50 gives half circumference', () => {
    const C = 2 * Math.PI * 21;
    const offset = healthRingOffset(50);
    assert.ok(Math.abs(offset - C / 2) < 0.2, `half ring offset should be ~${(C / 2).toFixed(1)}, got ${offset}`);
});

test('healthRingOffset: clamps negative scores to 0', () => {
    const C = 2 * Math.PI * 21;
    const offset = healthRingOffset(-10);
    assert.ok(Math.abs(offset - C) < 0.2, 'negative should clamp to empty ring');
});

test('healthRingOffset: clamps scores above 100', () => {
    const offset = healthRingOffset(150);
    assert.ok(offset >= 0 && offset < 1, 'should clamp to full ring');
});
