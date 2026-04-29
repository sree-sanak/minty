/**
 * Characterization tests for palette.js scoreString — the core ranking
 * function behind Cmd+K search.
 *
 * Pins all branches: exact, startsWith, word-start substring, mid-word
 * substring, proximity bonus, length ratio, and no-match. These tests
 * prevent accidental ranking regressions that would degrade the palette UX.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreString } = require('../../crm/palette');

// ---------------------------------------------------------------------------
// Exact match → 100
// ---------------------------------------------------------------------------

test('[Palette scoring] exact match (case-insensitive) → 100', () => {
    assert.equal(scoreString('Alex Chen', 'alex chen'), 100);
    assert.equal(scoreString('stripe', 'Stripe'), 100);
    assert.equal(scoreString('PM', 'pm'), 100);
});

// ---------------------------------------------------------------------------
// startsWith → 70 + length bonus (up to 20)
// ---------------------------------------------------------------------------

test('[Palette scoring] startsWith: short needle on long haystack → ~70', () => {
    const score = scoreString('Alexander Hamilton', 'alex');
    assert.ok(score >= 70 && score <= 90, `expected 70-90, got ${score}`);
});

test('[Palette scoring] startsWith: needle covers most of haystack → near 90', () => {
    const score = scoreString('Alex', 'ale');
    assert.ok(score >= 80 && score <= 90, `expected 80-90, got ${score}`);
});

test('[Palette scoring] startsWith: length ratio bonus increases with coverage', () => {
    const short = scoreString('Engineering Manager at Stripe', 'eng');
    const long = scoreString('Engineering', 'engineerin');
    assert.ok(long > short, `longer needle coverage (${long}) should beat shorter (${short})`);
});

// ---------------------------------------------------------------------------
// Word-start substring → 60 + proximity + length bonus
// ---------------------------------------------------------------------------

test('[Palette scoring] word-start: needle at word boundary mid-string → ~60+', () => {
    const score = scoreString('Lead Engineer at Stripe', 'stripe');
    assert.ok(score >= 60, `word-start match should be ≥60, got ${score}`);
});

test('[Palette scoring] word-start: second word matches → higher than mid-word', () => {
    const wordStart = scoreString('Alex Chen', 'chen');
    const midWord = scoreString('kitchen', 'chen');
    assert.ok(wordStart > midWord, `word-start (${wordStart}) should beat mid-word (${midWord})`);
});

// ---------------------------------------------------------------------------
// Mid-word substring → 40 + proximity + length bonus
// ---------------------------------------------------------------------------

test('[Palette scoring] mid-word: substring not at word boundary → ~40+', () => {
    const score = scoreString('kitchen', 'chen');
    // Base 40 + proximity bonus (20-3=17) + length ratio (9) = 66
    assert.ok(score >= 40, `mid-word should be ≥40, got ${score}`);
});

test('[Palette scoring] mid-word: earlier position gets proximity bonus', () => {
    const early = scoreString('achenbacher', 'chen');
    const late = scoreString('aaaaaaaaachenbacher', 'chen');
    assert.ok(early >= late, `earlier match (${early}) should score ≥ later (${late})`);
});

// ---------------------------------------------------------------------------
// No match → 0
// ---------------------------------------------------------------------------

test('[Palette scoring] no match → 0', () => {
    assert.equal(scoreString('Alex Chen', 'zzzz'), 0);
    assert.equal(scoreString('Stripe', 'google'), 0);
});

test('[Palette scoring] null/empty inputs → 0', () => {
    assert.equal(scoreString(null, 'test'), 0);
    assert.equal(scoreString('test', null), 0);
    assert.equal(scoreString('', 'test'), 0);
    assert.equal(scoreString('test', ''), 0);
    assert.equal(scoreString(null, null), 0);
});

// ---------------------------------------------------------------------------
// Ranking invariants — relative ordering that matters for UX
// ---------------------------------------------------------------------------

test('[Palette scoring] exact > startsWith > word-start > mid-word > no-match', () => {
    const exact = scoreString('stripe', 'stripe');
    const starts = scoreString('stripe inc', 'stripe');
    const wordStart = scoreString('at stripe inc', 'stripe');
    const midWord = scoreString('pinstripe', 'stripe');
    const none = scoreString('google', 'stripe');

    assert.ok(exact > starts, `exact (${exact}) > startsWith (${starts})`);
    assert.ok(starts > wordStart, `startsWith (${starts}) > wordStart (${wordStart})`);
    assert.ok(wordStart > midWord, `wordStart (${wordStart}) > midWord (${midWord})`);
    assert.ok(midWord > none, `midWord (${midWord}) > none (${none})`);
});

test('[Palette scoring] contact name "Alex" ranks above company "Alexion Pharmaceuticals" for query "alex"', () => {
    const nameScore = scoreString('Alex', 'alex');
    const companyScore = scoreString('Alexion Pharmaceuticals', 'alex');
    assert.ok(nameScore >= companyScore,
        `short exact-ish name (${nameScore}) should rank ≥ long company (${companyScore})`);
});

test('[Palette scoring] first name match ranks higher than email substring match', () => {
    const nameScore = scoreString('Priya Sharma', 'priya');
    const emailScore = scoreString('priya.sharma@company.com', 'priya');
    assert.ok(nameScore >= emailScore,
        `name startsWith (${nameScore}) ≥ email startsWith (${emailScore})`);
});
