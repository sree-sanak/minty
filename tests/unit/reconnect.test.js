'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    daysToTimePhrase,
    buildReconnectTemplate,
    shuffleSentences,
    alternateOpener,
    regenerateDraft,
} = require('../../crm/reconnect');

// ---------------------------------------------------------------------------
// daysToTimePhrase
// ---------------------------------------------------------------------------

test('reconnect/daysToTimePhrase: null → "a while"', () => {
    assert.equal(daysToTimePhrase(null), 'a while');
});

test('reconnect/daysToTimePhrase: undefined → "a while"', () => {
    assert.equal(daysToTimePhrase(undefined), 'a while');
});

test('reconnect/daysToTimePhrase: 3 days → "recently"', () => {
    assert.equal(daysToTimePhrase(3), 'recently');
});

test('reconnect/daysToTimePhrase: 14 days → "a couple weeks"', () => {
    assert.equal(daysToTimePhrase(14), 'a couple weeks');
});

test('reconnect/daysToTimePhrase: 25 days → "about a month"', () => {
    assert.equal(daysToTimePhrase(25), 'about a month');
});

test('reconnect/daysToTimePhrase: 30 days → "about a month"', () => {
    assert.equal(daysToTimePhrase(30), 'about a month');
});

test('reconnect/daysToTimePhrase: 45 days → "about a month"', () => {
    assert.equal(daysToTimePhrase(45), 'about a month');
});

test('reconnect/daysToTimePhrase: 60 days → "a couple months"', () => {
    assert.equal(daysToTimePhrase(60), 'a couple months');
});

test('reconnect/daysToTimePhrase: 90 days → "a couple months"', () => {
    assert.equal(daysToTimePhrase(90), 'a couple months');
});

test('reconnect/daysToTimePhrase: 200 days → "a few months"', () => {
    assert.equal(daysToTimePhrase(200), 'a few months');
});

test('reconnect/daysToTimePhrase: 400 days → "a while"', () => {
    assert.equal(daysToTimePhrase(400), 'a while');
});

// ---------------------------------------------------------------------------
// buildReconnectTemplate
// ---------------------------------------------------------------------------

const makeContact = (overrides = {}) => ({
    name: 'Sarah Chen',
    daysSinceContact: 45,
    sources: { linkedin: { company: 'Acme Corp' }, whatsapp: null },
    apollo: {},
    activeChannels: ['linkedin'],
    ...overrides,
});

test('reconnect/buildReconnectTemplate: returns a non-empty string', () => {
    const draft = buildReconnectTemplate(makeContact());
    assert.ok(typeof draft === 'string');
    assert.ok(draft.length > 20);
});

test('reconnect/buildReconnectTemplate: uses first name only', () => {
    const draft = buildReconnectTemplate(makeContact({ name: 'Sarah Chen' }));
    assert.ok(draft.includes('Sarah'));
    assert.ok(!draft.includes('Sarah Chen'));
});

test('reconnect/buildReconnectTemplate: includes company when available', () => {
    const draft = buildReconnectTemplate(makeContact());
    assert.ok(draft.includes('Acme Corp'));
});

test('reconnect/buildReconnectTemplate: omits company line when none available', () => {
    const contact = makeContact({ sources: { linkedin: null } });
    const draft = buildReconnectTemplate(contact);
    assert.ok(!draft.includes('undefined'));
    assert.ok(!draft.includes('null'));
});

test('reconnect/buildReconnectTemplate: uses topic from insights', () => {
    const insights = { topics: ['machine learning', 'career change'], openLoops: [], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.ok(draft.includes('machine learning'));
});

test('reconnect/buildReconnectTemplate: uses open loop from insights', () => {
    const insights = { topics: [], openLoops: ['follow up on the job application'], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.ok(draft.toLowerCase().includes('follow up'));
});

test('reconnect/buildReconnectTemplate: falls back gracefully with no insights and no snippets', () => {
    const draft = buildReconnectTemplate(makeContact({ name: 'Jay' }), null, []);
    assert.ok(draft.startsWith('Hey Jay'));
    assert.ok(!draft.includes('undefined'));
    assert.ok(!draft.includes('null'));
});

test('reconnect/buildReconnectTemplate: uses recent snippet when no topic in insights', () => {
    const snippets = ['machine learning conference'];
    const draft = buildReconnectTemplate(makeContact({ name: 'Jay' }), null, snippets);
    assert.ok(draft.length > 20);
    assert.ok(!draft.includes('undefined'));
});

test('reconnect/buildReconnectTemplate: handles missing name gracefully', () => {
    const draft = buildReconnectTemplate(makeContact({ name: null }), null, []);
    assert.ok(draft.includes('there'));
    assert.ok(!draft.includes('null'));
});

// ---------------------------------------------------------------------------
// shuffleSentences
// ---------------------------------------------------------------------------

test('reconnect/shuffleSentences: returns string', () => {
    const result = shuffleSentences('Hello there. How are you? Hope all is well.');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
});

test('reconnect/shuffleSentences: single sentence returns unchanged', () => {
    const input = 'Just one sentence.';
    assert.equal(shuffleSentences(input), input);
});

test('reconnect/shuffleSentences: two sentences returns unchanged (no middle to shuffle)', () => {
    const input = 'First sentence. Second sentence.';
    assert.equal(shuffleSentences(input), input);
});

test('reconnect/shuffleSentences: three+ sentences modifies middle', () => {
    const input = 'Start sentence. Middle one. Middle two. End sentence.';
    const result = shuffleSentences(input);
    // First and last should be preserved
    assert.ok(result.startsWith('Start sentence.'));
    assert.ok(result.trimEnd().endsWith('End sentence.'));
    // Should contain all sentences
    assert.ok(result.includes('Middle one.'));
    assert.ok(result.includes('Middle two.'));
});

test('reconnect/shuffleSentences: preserves all content', () => {
    const input = 'Hey Sarah. I miss our chats. Hope you are well. Catch up soon?';
    const result = shuffleSentences(input);
    const originalWords = input.replace(/[.?!]/g, '').split(/\s+/).sort();
    const resultWords = result.replace(/[.?!]/g, '').split(/\s+/).sort();
    assert.deepEqual(originalWords, resultWords);
});

// ---------------------------------------------------------------------------
// alternateOpener
// ---------------------------------------------------------------------------

test('reconnect/alternateOpener: returns string with name', () => {
    const result = alternateOpener('Original draft sentence.', 'Sarah');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Sarah'));
});

test('reconnect/alternateOpener: result differs from input', () => {
    const input = 'Hey Sarah, it has been a while. Hope you are well.';
    const result = alternateOpener(input, 'Sarah');
    assert.notEqual(result, input);
});

test('reconnect/alternateOpener: uses "there" when no firstName', () => {
    const result = alternateOpener('Some draft.', '');
    assert.ok(result.includes('there'));
});

// ---------------------------------------------------------------------------
// regenerateDraft
// ---------------------------------------------------------------------------

test('reconnect/regenerateDraft: returns a string', () => {
    const result = regenerateDraft('Hey Jay. Hope all is well. Looking forward to catching up.', 'Jay');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
});

test('reconnect/regenerateDraft: result differs from input for shuffleable draft', () => {
    const input = 'Hey Sarah. I wanted to reach out. Hope you are well. Would love to catch up.';
    const result = regenerateDraft(input, 'Sarah');
    assert.notEqual(result, input);
});

test('reconnect/regenerateDraft: never produces empty string', () => {
    const result = regenerateDraft('', 'Jay');
    assert.ok(typeof result === 'string');
});

test('reconnect/regenerateDraft: no null or undefined in output', () => {
    const result = regenerateDraft('Short text.', 'Jay');
    assert.ok(!result.includes('null'));
    assert.ok(!result.includes('undefined'));
});

// ---------------------------------------------------------------------------
// alternateOpener — punctuation when draft is a single sentence
// ---------------------------------------------------------------------------

test('reconnect/alternateOpener: single-sentence draft never produces double periods', () => {
    const result = alternateOpener('Only one sentence here.', 'Alex');
    assert.ok(!result.includes('..'), `double period found in: "${result}"`);
});

test('reconnect/alternateOpener: single-sentence draft never produces em-dash then period', () => {
    const cases = [
        { input: 'X sentence.', expectedPrefix: 'Hi Alex!' },
        { input: 'XX sentence.', expectedPrefix: 'Alex!' },
        { input: ' sentence.', expectedPrefix: 'Hey Alex,' },
    ];

    for (const { input, expectedPrefix } of cases) {
        const result = alternateOpener(input, 'Alex');
        assert.ok(result.startsWith(expectedPrefix), `expected ${expectedPrefix} opener, got: "${result}"`);
        assert.ok(!result.includes('—.'), `em-dash + period found in: "${result}"`);
        assert.ok(!result.includes('..'), `double period found in: "${result}"`);
    }
});

// ---------------------------------------------------------------------------
// buildReconnectTemplate — edge cases (characterization coverage)
// ---------------------------------------------------------------------------

test('reconnect/buildReconnectTemplate: open loop too short after stripping is omitted', () => {
    // "Asked him to do" → loopCore = "do" (length 2, ≤ 4) → skipped
    const insights = { topics: [], openLoops: ['Asked him to do'], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about you and wanted to reach out. Hope things are going well at Acme Corp. Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: open loop long enough after stripping is included', () => {
    const insights = { topics: [], openLoops: ['Asked him to review the pitch deck'], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about you and wanted to reach out. Hope things are going well at Acme Corp. Also wanted to follow up on review the pitch deck — did that ever work out? Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: Apollo currentCompany fallback for company line', () => {
    const contact = makeContact({ sources: {}, apollo: { currentCompany: 'Neo Corp' } });
    const draft = buildReconnectTemplate(contact);
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about you and wanted to reach out. Hope things are going well at Neo Corp. Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: keywords fallback when no topics and >= 2 keywords', () => {
    const insights = { topics: [], openLoops: [], keywords: ['fundraising', 'strategy'] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about our conversation around fundraising and strategy and wanted to reach out. Hope things are going well at Acme Corp. Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: single keyword used as standalone topic ref', () => {
    const insights = { topics: [], openLoops: [], keywords: ['blockchain'] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about our conversation around blockchain and wanted to reach out. Hope things are going well at Acme Corp. Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: snippet with only short words falls back to generic opening', () => {
    // All words are ≤ 4 chars, so the words filter produces empty and the generic fallback fires
    const draft = buildReconnectTemplate(makeContact({ name: 'Jay' }), null, ['hi ok bye']);
    assert.equal(
        draft,
        "Hey Jay, it's been about a month — I was thinking about you and wanted to check in. Hope things are going well at Acme Corp. Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});

test('reconnect/buildReconnectTemplate: open loop with em-dash strips after dash', () => {
    const insights = { topics: [], openLoops: ['Pending follow-up — waiting on their side'], keywords: [] };
    const draft = buildReconnectTemplate(makeContact(), insights);
    // loopCore should be derived from text before the em-dash, with "Pending" stripped
    assert.equal(
        draft,
        "Hey Sarah, it's been about a month — I was thinking about you and wanted to reach out. Hope things are going well at Acme Corp. Also wanted to follow up on follow-up — did that ever work out? Would love to catch up — are you up for a coffee or a quick call sometime soon?"
    );
});
