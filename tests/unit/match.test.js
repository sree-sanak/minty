'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    COMMON_NAMES,
    INSTITUTION_ABBREVS,
    RELATION_WORDS,
    cleanWaName,
    cleanLiName,
    cleanBySource,
    lev,
    fuzzyMatch,
    inferCountryFromPhone,
    scoreGenericPair,
    matchGroups,
} = require('../../crm/match');
const { makeContact } = require('../helpers/fixtures');

// ---------------------------------------------------------------------------
// cleanWaName
// ---------------------------------------------------------------------------

test('cleanWaName: returns nulls for empty/null input', () => {
    const r = cleanWaName(null);
    assert.equal(r.firstName, null);
    assert.equal(r.lastName, null);
    assert.equal(r.cleaned, null);
});

test('cleanWaName: simple two-word name', () => {
    const r = cleanWaName('Alice Smith');
    assert.equal(r.firstName, 'alice');
    assert.equal(r.lastName, 'smith');
    assert.equal(r.cleaned, 'alice smith');
});

test('cleanWaName: strips parenthesized content', () => {
    const r = cleanWaName('Ravi (UCL friend)');
    assert.equal(r.firstName, 'ravi');
    assert.equal(r.lastName, null);
});

test('cleanWaName: strips institution abbreviations as suffix', () => {
    const r = cleanWaName('Priya Sharma UCL');
    assert.equal(r.firstName, 'priya');
    assert.equal(r.lastName, 'sharma');
    assert.equal(r.cleaned, 'priya sharma');
});

test('cleanWaName: strips relation words as suffix', () => {
    const r = cleanWaName('Deepak Uncle');
    assert.equal(r.firstName, 'deepak');
    assert.equal(r.lastName, null);
});

test('cleanWaName: strips uppercase short codes', () => {
    const r = cleanWaName('Sam Jones BW');
    assert.equal(r.firstName, 'sam');
    assert.equal(r.lastName, 'jones');
});

test('cleanWaName: strips leading emoji', () => {
    const r = cleanWaName('🦔 Sam Jones');
    assert.equal(r.firstName, 'sam');
    assert.equal(r.lastName, 'jones');
});

test('cleanWaName: single word name', () => {
    const r = cleanWaName('Priya');
    assert.equal(r.firstName, 'priya');
    assert.equal(r.lastName, null);
});

test('cleanWaName: does not strip non-suffix institution words', () => {
    // "Google Deepak" — Google is first word, should be kept (only trailing stripped)
    const r = cleanWaName('Google');
    assert.equal(r.firstName, 'google');
});

// ---------------------------------------------------------------------------
// cleanLiName
// ---------------------------------------------------------------------------

test('cleanLiName: returns nulls for empty/null input', () => {
    const r = cleanLiName(null);
    assert.equal(r.firstName, null);
    assert.equal(r.lastName, null);
});

test('cleanLiName: simple name', () => {
    const r = cleanLiName('Alex Rivera');
    assert.equal(r.firstName, 'alex');
    assert.equal(r.lastName, 'rivera');
});

test('cleanLiName: extracts nickname from parentheses', () => {
    const r = cleanLiName('Jamie (JJ) Patel');
    assert.equal(r.firstName, 'jamie');
    assert.equal(r.nickname, 'jj');
    assert.equal(r.lastName, 'patel');
});

test('cleanLiName: strips leading emoji', () => {
    const r = cleanLiName('🦔 Sam Jones');
    assert.equal(r.firstName, 'sam');
    assert.equal(r.lastName, 'jones');
});

test('cleanLiName: strips CJK characters', () => {
    const r = cleanLiName('Alex Rivera 山田');
    assert.equal(r.firstName, 'alex');
    assert.equal(r.lastName, 'rivera');
});

// ---------------------------------------------------------------------------
// cleanBySource
// ---------------------------------------------------------------------------

test('cleanBySource: routes linkedin to cleanLiName', () => {
    const r = cleanBySource('Jamie (JJ) Patel', 'linkedin');
    assert.equal(r.nickname, 'jj');
});

test('cleanBySource: routes whatsapp to cleanWaName', () => {
    const r = cleanBySource('Priya Sharma UCL', 'whatsapp');
    assert.equal(r.cleaned, 'priya sharma');
});

test('cleanBySource: routes sms to cleanWaName', () => {
    const r = cleanBySource('Ravi Uncle', 'sms');
    assert.equal(r.firstName, 'ravi');
    assert.equal(r.lastName, null);
});

// ---------------------------------------------------------------------------
// lev (Levenshtein distance)
// ---------------------------------------------------------------------------

test('lev: identical strings → 0', () => {
    assert.equal(lev('hello', 'hello'), 0);
});

test('lev: single insertion → 1', () => {
    assert.equal(lev('hell', 'hello'), 1);
});

test('lev: single deletion → 1', () => {
    assert.equal(lev('hello', 'hell'), 1);
});

test('lev: single substitution → 1', () => {
    assert.equal(lev('hello', 'hella'), 1);
});

test('lev: completely different strings', () => {
    assert.equal(lev('abc', 'xyz'), 3);
});

test('lev: null input → 99', () => {
    assert.equal(lev(null, 'abc'), 99);
    assert.equal(lev('abc', null), 99);
});

test('lev: empty string vs non-empty', () => {
    assert.equal(lev('', 'abc'), 99); // empty is falsy
});

// ---------------------------------------------------------------------------
// fuzzyMatch
// ---------------------------------------------------------------------------

test('fuzzyMatch: exact match → true', () => {
    assert.equal(fuzzyMatch('alice', 'alice'), true);
});

test('fuzzyMatch: one char diff in long string → true', () => {
    assert.equal(fuzzyMatch('alexander', 'alexender'), true);
});

test('fuzzyMatch: very different → false', () => {
    assert.equal(fuzzyMatch('alice', 'bobby'), false);
});

test('fuzzyMatch: null input → false', () => {
    assert.equal(fuzzyMatch(null, 'alice'), false);
});

test('fuzzyMatch: short strings with 1 diff → true', () => {
    // "sam" vs "sim" — dist 1, max 3, threshold max(1, floor(0.6))=1
    assert.equal(fuzzyMatch('sam', 'sim'), true);
});

test('fuzzyMatch: short strings with 2 diff → false', () => {
    assert.equal(fuzzyMatch('sam', 'bob'), false);
});

// ---------------------------------------------------------------------------
// inferCountryFromPhone
// ---------------------------------------------------------------------------

test('inferCountryFromPhone: UK number', () => {
    const r = inferCountryFromPhone('+447911555001');
    assert.ok(r);
    assert.equal(r.code, '+44');
    assert.ok(r.keywords.includes('uk'));
});

test('inferCountryFromPhone: India number', () => {
    const r = inferCountryFromPhone('+919876543210');
    assert.ok(r);
    assert.equal(r.code, '+91');
    assert.ok(r.keywords.includes('india'));
});

test('inferCountryFromPhone: US/Canada number', () => {
    const r = inferCountryFromPhone('+16505551234');
    assert.ok(r);
    assert.equal(r.code, '+1');
});

test('inferCountryFromPhone: UAE number', () => {
    const r = inferCountryFromPhone('+971501234567');
    assert.ok(r);
    assert.equal(r.code, '+971');
    assert.ok(r.keywords.includes('dubai'));
});

test('inferCountryFromPhone: unknown prefix → null', () => {
    assert.equal(inferCountryFromPhone('+999123456'), null);
});

// ---------------------------------------------------------------------------
// COMMON_NAMES constant
// ---------------------------------------------------------------------------

test('COMMON_NAMES: contains expected common names', () => {
    assert.ok(COMMON_NAMES.has('ali'));
    assert.ok(COMMON_NAMES.has('james'));
    assert.ok(COMMON_NAMES.has('priya'));
    assert.ok(COMMON_NAMES.has('alex'));
});

test('COMMON_NAMES: does not contain uncommon names', () => {
    assert.ok(!COMMON_NAMES.has('zarquon'));
    assert.ok(!COMMON_NAMES.has('persephone'));
});

// ---------------------------------------------------------------------------
// scoreGenericPair — exact and fuzzy matches
// ---------------------------------------------------------------------------

let _testIdSeq = 0;
function nextId(prefix) { return `${prefix}_test_${++_testIdSeq}`; }

function waContact(name, overrides = {}) {
    return makeContact({
        id: nextId('wa'),
        name,
        sources: {
            whatsapp: { id: '447911555099@c.us', number: '447911555099', ...(overrides.waSrc || {}) },
            linkedin: null, telegram: null, email: null, googleContacts: null, sms: null,
        },
        phones: ['+447911555099'],
        ...overrides,
    });
}

function liContact(name, overrides = {}) {
    return makeContact({
        id: nextId('li'),
        name,
        sources: {
            whatsapp: null, telegram: null, email: null, googleContacts: null, sms: null,
            linkedin: { name, company: overrides.company || null, position: overrides.position || null, profileUrl: overrides.profileUrl || null },
        },
        phones: [],
        ...overrides,
    });
}

test('scoreGenericPair: exact first + last name match → confirmed', () => {
    const wa = waContact('Alice Smith');
    const li = liContact('Alice Smith');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'confirmed');
    assert.ok(r.score >= 70);
    assert.ok(r.reasons.some(r => r.includes('First name exact')));
    assert.ok(r.reasons.some(r => r.includes('Last name exact')));
});

test('scoreGenericPair: first name mismatch → skip', () => {
    const wa = waContact('Alice Smith');
    const li = liContact('Bobby Jones');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'skip');
    assert.equal(r.score, 0);
});

test('scoreGenericPair: fuzzy first name match', () => {
    const wa = waContact('Aleksander Nowak');
    const li = liContact('Alexander Nowak');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.score > 0);
    assert.ok(r.reasons.some(r => r.includes('fuzzy')));
});

test('scoreGenericPair: last name mismatch reduces score', () => {
    const wa = waContact('Alice Smith');
    const li = liContact('Alice Jones');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.reasons.some(r => r.includes('Last name mismatch')));
    // Score should be lower than exact match
    const exact = scoreGenericPair(waContact('Alice Smith'), 'whatsapp', liContact('Alice Smith'), 'linkedin');
    assert.ok(r.score < exact.score);
});

test('scoreGenericPair: common name penalty applied', () => {
    const wa = waContact('James Wilson');
    const li = liContact('James Wilson');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.reasons.some(r => r.includes('Common first name')));

    // Compare with uncommon name — uncommon should score higher
    const waU = waContact('Zarquon Wilson');
    const liU = liContact('Zarquon Wilson');
    const rU = scoreGenericPair(waU, 'whatsapp', liU, 'linkedin');
    assert.ok(rU.score > r.score, 'Uncommon name should score higher than common name');
});

test('scoreGenericPair: company match boosts score', () => {
    const wa = waContact('Alice Smith');
    const li = liContact('Alice Smith', { company: 'Acme Corp' });
    // WA contact with company in name won't trigger company match directly,
    // but LI company vs WA name containing company word will
    const base = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');

    const li2 = liContact('Alice Smith', { company: 'TechCorp' });
    const wa2 = waContact('Alice Smith TechCorp');
    const boosted = scoreGenericPair(wa2, 'whatsapp', li2, 'linkedin');
    // The one with company appearing in WA name should get a boost
    assert.ok(boosted.reasons.some(r => r.includes('Company')));
});

test('scoreGenericPair: phone country consistent with LI context boosts', () => {
    const wa = waContact('Priya Sharma', { phones: ['+919876543210'] });
    // Override the phone field to ensure it's picked up
    wa.sources.whatsapp.number = '919876543210';
    const li = liContact('Priya Sharma', { company: 'TCS Mumbai', position: 'Engineer in India' });
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.reasons.some(r => r.includes('Phone prefix')));
});

test('scoreGenericPair: nickname match', () => {
    const wa = waContact('JJ');
    const li = liContact('Jamie (JJ) Patel');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.score > 0);
    assert.ok(r.reasons.some(r => r.includes('nickname')));
});

// ---------------------------------------------------------------------------
// scoreGenericPair — cross-source evidence (LI↔SMS, LI↔GC)
// ---------------------------------------------------------------------------

function smsContact(name, phone) {
    return makeContact({
        id: nextId('sms'),
        name,
        phones: [phone],
        sources: {
            whatsapp: null, linkedin: null, telegram: null, email: null, googleContacts: null,
            sms: { phone, name },
        },
    });
}

function gcContact(name, overrides = {}) {
    return makeContact({
        id: nextId('gc'),
        name,
        sources: {
            whatsapp: null, linkedin: null, telegram: null, email: null, sms: null,
            googleContacts: { name, org: overrides.org || null },
        },
        phones: overrides.phones || [],
    });
}

test('scoreGenericPair: LI↔SMS exact name match', () => {
    const li = liContact('Zarquon Chen');
    const sms = smsContact('Zarquon Chen', '+447911555099');
    const r = scoreGenericPair(li, 'linkedin', sms, 'sms');
    assert.ok(r.confidence !== 'skip');
    assert.ok(r.score >= 70); // exact first + exact last (uncommon name, no penalty)
});

test('scoreGenericPair: LI↔GC with org match', () => {
    const li = liContact('Emma Watson', { company: 'DeepMind' });
    const gc = gcContact('Emma Watson', { org: 'DeepMind' });
    const r = scoreGenericPair(li, 'linkedin', gc, 'googleContacts');
    assert.ok(r.confidence === 'confirmed');
    assert.ok(r.reasons.some(r => r.includes('Company/org match')));
});

// ---------------------------------------------------------------------------
// matchGroups — output structure and basic matching
// ---------------------------------------------------------------------------

test('matchGroups: returns matches array and candidatePairs count', () => {
    const groupA = [waContact('Alice Smith')];
    const groupB = [liContact('Alice Smith')];
    const result = matchGroups(groupA, 'whatsapp', groupB, 'linkedin');
    assert.ok(Array.isArray(result.matches));
    assert.equal(typeof result.candidatePairs, 'number');
    assert.ok(result.candidatePairs >= 1);
});

test('matchGroups: finds confirmed match for identical names', () => {
    const groupA = [waContact('Alice Smith')];
    const groupB = [liContact('Alice Smith')];
    const result = matchGroups(groupA, 'whatsapp', groupB, 'linkedin');
    assert.equal(result.matches.length, 1);
    const m = result.matches[0];
    assert.ok(['confirmed', 'likely'].includes(m.confidence));
    assert.ok(m.aName);
    assert.ok(m.bName);
    assert.ok(m.sourceA === 'whatsapp');
    assert.ok(m.sourceB === 'linkedin');
});

test('matchGroups: no match for completely different names', () => {
    const groupA = [waContact('Alice Smith')];
    const groupB = [liContact('Bobby Jones')];
    const result = matchGroups(groupA, 'whatsapp', groupB, 'linkedin');
    assert.equal(result.matches.length, 0);
});

test('matchGroups: keeps best match per A contact when multiple B candidates', () => {
    const groupA = [waContact('Alice Smith')];
    const groupB = [
        liContact('Alice Smith'),    // exact match
        liContact('Alice Jones'),    // same first, different last
    ];
    const result = matchGroups(groupA, 'whatsapp', groupB, 'linkedin');
    // Should pick Smith over Jones
    assert.ok(result.matches.length >= 1);
    const best = result.matches.reduce((a, b) => a.score > b.score ? a : b);
    assert.ok(best.bName.includes('Smith') || best.bName.includes('smith'));
});

test('matchGroups: location match boosts score', () => {
    const a = waContact('Alice Smith');
    const b = liContact('Alice Smith');
    const locById = { [a.id]: 'london', [b.id]: 'london' };
    const result = matchGroups([a], 'whatsapp', [b], 'linkedin', locById);
    assert.ok(result.matches.length === 1);
    assert.ok(result.matches[0].reason.includes('Location match'));
});

test('matchGroups: location mismatch penalizes score', () => {
    const a = waContact('Alice Smith');
    const b = liContact('Alice Smith');
    const locMatch = { [a.id]: 'london', [b.id]: 'london' };
    const locMismatch = { [a.id]: 'london', [b.id]: 'mumbai' };
    const rMatch = matchGroups([a], 'whatsapp', [b], 'linkedin', locMatch);
    const rMismatch = matchGroups([a], 'whatsapp', [b], 'linkedin', locMismatch);
    assert.ok(rMatch.matches[0].score > rMismatch.matches[0].score);
});

// ---------------------------------------------------------------------------
// WhatsApp name cleaning edge cases
// ---------------------------------------------------------------------------

test('cleanWaName: multiple suffixes stripped', () => {
    const r = cleanWaName('Rahul Sharma IIT BW');
    assert.equal(r.firstName, 'rahul');
    assert.equal(r.lastName, 'sharma');
});

test('cleanWaName: relation word as only word kept', () => {
    // If name is just "Uncle", first word is kept
    const r = cleanWaName('Uncle');
    assert.equal(r.firstName, 'uncle');
});

// ---------------------------------------------------------------------------
// Confidence thresholds
// ---------------------------------------------------------------------------

test('scoreGenericPair: confidence thresholds are correct', () => {
    // Exact first + exact last + no common name penalty = 80 → confirmed
    const wa = waContact('Zarquon Smith');
    const li = liContact('Zarquon Smith');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'confirmed');
    assert.ok(r.score >= 70);
});

// ---------------------------------------------------------------------------
// matchGroups — B-side deduplication (multiple A contacts competing for same B)
// ---------------------------------------------------------------------------

test('matchGroups: when multiple A contacts match same B, keeps those within 15 pts of best', () => {
    // Two WA contacts with same first name but different last names competing for one LI contact
    const wa1 = waContact('Zarquon Smith');       // exact first + exact last → high score
    const wa2 = waContact('Zarquon Jones');       // exact first + last mismatch → lower score
    const li = liContact('Zarquon Smith');

    const bestScore = scoreGenericPair(wa1, 'whatsapp', li, 'linkedin').score;
    const weakerScore = scoreGenericPair(wa2, 'whatsapp', li, 'linkedin').score;
    assert.equal(bestScore, 80);
    assert.equal(weakerScore, 20);

    const result = matchGroups([wa1, wa2], 'whatsapp', [li], 'linkedin');

    // wa1 is best-per-A for wa1, wa2 is best-per-A for wa2 (only one B candidate)
    // Then B-side dedup: both map to same B, best score wins.
    // Gap > 15, so only wa1 should survive.
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].aId, wa1.id);
});

test('matchGroups: B-side dedup keeps close competitors (within 15 pts)', () => {
    // Two WA contacts whose scores are close enough both survive B-side dedup
    const wa1 = waContact('Zarquon Smith');       // exact first + exact last = 80
    const wa2 = waContact('Zarquon Smyth');       // exact first + fuzzy last = 70
    const li = liContact('Zarquon Smith');

    const bestScore = scoreGenericPair(wa1, 'whatsapp', li, 'linkedin').score;
    const closeScore = scoreGenericPair(wa2, 'whatsapp', li, 'linkedin').score;
    assert.equal(bestScore, 80);
    assert.equal(closeScore, 70);

    const result = matchGroups([wa1, wa2], 'whatsapp', [li], 'linkedin');

    // Score difference is 10 (within 15), so both kept.
    assert.equal(result.matches.length, 2);
    const ids = result.matches.map(m => m.aId);
    assert.ok(ids.includes(wa1.id));
    assert.ok(ids.includes(wa2.id));
});
