'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    normalizePhone,
    phoneKey,
    normalizeEmail,
    emailKey,
    normalizeName,
    recencyScore,
    frequencyScore,
    channelScore,
    relationshipScore,
    atomicWriteJsonSync,
} = require('../../crm/utils');

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

test('normalizePhone: returns null for null/undefined input', () => {
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
    assert.equal(normalizePhone(''), null);
});

test('normalizePhone: strips spaces, dashes, parens', () => {
    assert.equal(normalizePhone('+44 7911 555 333'), '+447911555333');
    assert.equal(normalizePhone('+1 (650) 123-4567'), '+16501234567');
    assert.equal(normalizePhone('(020) 7946-0000'), '02079460000');
});

test('normalizePhone: preserves leading +', () => {
    assert.equal(normalizePhone('+447911555333'), '+447911555333');
});

test('normalizePhone: converts 011 international prefix to +', () => {
    assert.equal(normalizePhone('011447911555333'), '+447911555333');
});

test('normalizePhone: does not convert short 011 numbers', () => {
    // 011 + fewer than 8 more digits — not an international call, leave as-is
    const result = normalizePhone('01147');
    assert.ok(!result.startsWith('+'));
});

// ---------------------------------------------------------------------------
// phoneKey
// ---------------------------------------------------------------------------

test('phoneKey: returns null for null/empty input', () => {
    assert.equal(phoneKey(null), null);
    assert.equal(phoneKey(''), null);
    assert.equal(phoneKey(undefined), null);
});

test('phoneKey: returns null for numbers shorter than 7 digits', () => {
    assert.equal(phoneKey('12345'), null);
    assert.equal(phoneKey('123456'), null);
});

test('phoneKey: strips + and returns digits only', () => {
    assert.equal(phoneKey('+447911555333'), '447911555333');
    assert.equal(phoneKey('+1 (650) 123-4567'), '16501234567');
});

test('phoneKey: +16308911555 and 16308911555 produce same key', () => {
    assert.equal(phoneKey('+16308911555'), phoneKey('16308911555'));
});

test('phoneKey: 7+ digit threshold', () => {
    assert.equal(phoneKey('1234567'), '1234567');
    assert.equal(phoneKey('123456'),  null);
});

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

test('normalizeEmail: returns null for null input', () => {
    assert.equal(normalizeEmail(null), null);
    assert.equal(normalizeEmail(undefined), null);
});

test('normalizeEmail: lowercases', () => {
    assert.equal(normalizeEmail('User@Example.COM'), 'user@example.com');
});

test('normalizeEmail: trims whitespace', () => {
    assert.equal(normalizeEmail('  user@example.com  '), 'user@example.com');
});

test('normalizeEmail: already normalized email unchanged', () => {
    assert.equal(normalizeEmail('user@example.com'), 'user@example.com');
});

// ---------------------------------------------------------------------------
// emailKey
// ---------------------------------------------------------------------------

test('emailKey: returns null for null/undefined/empty input', () => {
    assert.equal(emailKey(null), null);
    assert.equal(emailKey(undefined), null);
    assert.equal(emailKey(''), null);
});

test('emailKey: returns null for strings without valid @ or domain', () => {
    assert.equal(emailKey('nodomain'), null);
    assert.equal(emailKey('@nodomain'), null);
    assert.equal(emailKey('user@'), null);
    assert.equal(emailKey('user@x'), null); // no dot in domain
});

test('emailKey: lowercases and trims', () => {
    assert.equal(emailKey('  User@Example.COM  '), 'user@example.com');
});

test('emailKey: strips plus-addressing for Gmail only', () => {
    assert.equal(emailKey('user+work@gmail.com'), 'user@gmail.com');
    assert.equal(emailKey('alice+newsletter@googlemail.com'), 'alice@googlemail.com');
});

test('emailKey: preserves plus-addressing for non-Gmail domains', () => {
    assert.equal(emailKey('user+work@example.com'), 'user+work@example.com');
    assert.equal(emailKey('alice+newsletter@outlook.com'), 'alice+newsletter@outlook.com');
});

test('emailKey: strips dots from Gmail local part', () => {
    assert.equal(emailKey('j.doe@gmail.com'), 'jdoe@gmail.com');
    assert.equal(emailKey('j.o.h.n@gmail.com'), 'john@gmail.com');
});

test('emailKey: strips dots from googlemail.com local part', () => {
    assert.equal(emailKey('j.doe@googlemail.com'), 'jdoe@googlemail.com');
});

test('emailKey: does NOT strip dots from non-Gmail domains', () => {
    assert.equal(emailKey('j.doe@outlook.com'), 'j.doe@outlook.com');
    assert.equal(emailKey('first.last@company.co.uk'), 'first.last@company.co.uk');
});

test('emailKey: combined Gmail dots + plus-addressing', () => {
    assert.equal(emailKey('j.doe+work@gmail.com'), 'jdoe@gmail.com');
    assert.equal(emailKey('J.Doe+SPAM@Gmail.COM'), 'jdoe@gmail.com');
});

test('emailKey: does not strip plus when + is first char', () => {
    // Edge case: local part starts with + (unlikely but defensive)
    assert.equal(emailKey('+tag@example.com'), '+tag@example.com');
});

test('emailKey: uses last @ for edge cases', () => {
    // Pathological but valid: local part can contain @
    assert.equal(emailKey('weird@local@example.com'), 'weird@local@example.com');
});

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

test('normalizeName: returns null for null input', () => {
    assert.equal(normalizeName(null), null);
    assert.equal(normalizeName(undefined), null);
});

test('normalizeName: lowercases and takes first two words', () => {
    assert.equal(normalizeName('John Smith'), 'john smith');
    assert.equal(normalizeName('John Michael Smith'), 'john michael');
});

test('normalizeName: handles single word', () => {
    assert.equal(normalizeName('Madonna'), 'madonna');
});

test('normalizeName: trims and collapses whitespace', () => {
    assert.equal(normalizeName('  Alice   Bob  '), 'alice bob');
});

// ---------------------------------------------------------------------------
// recencyScore
// ---------------------------------------------------------------------------

test('recencyScore: null/undefined returns 0', () => {
    assert.equal(recencyScore(null), 0);
    assert.equal(recencyScore(undefined), 0);
});

test('recencyScore: <7 days returns 100', () => {
    assert.equal(recencyScore(0), 100);
    assert.equal(recencyScore(3), 100);
    assert.equal(recencyScore(6), 100);
});

test('recencyScore: boundary at 7 days returns 80', () => {
    assert.equal(recencyScore(7), 80);
    assert.equal(recencyScore(29), 80);
});

test('recencyScore: boundary at 30 days returns 60', () => {
    assert.equal(recencyScore(30), 60);
    assert.equal(recencyScore(89), 60);
});

test('recencyScore: boundary at 90 days returns 30', () => {
    assert.equal(recencyScore(90), 30);
    assert.equal(recencyScore(179), 30);
});

test('recencyScore: boundary at 180 days returns 10', () => {
    assert.equal(recencyScore(180), 10);
    assert.equal(recencyScore(364), 10);
});

test('recencyScore: >=365 days returns 0', () => {
    assert.equal(recencyScore(365), 0);
    assert.equal(recencyScore(1000), 0);
});

// ---------------------------------------------------------------------------
// frequencyScore
// ---------------------------------------------------------------------------

test('frequencyScore: zero/null count returns 0', () => {
    assert.equal(frequencyScore(0, 50), 0);
    assert.equal(frequencyScore(null, 50), 0);
    assert.equal(frequencyScore(undefined, 50), 0);
});

test('frequencyScore: count equal to p90 returns 100', () => {
    assert.equal(frequencyScore(50, 50), 100);
});

test('frequencyScore: count exceeding p90 is capped at 100', () => {
    assert.equal(frequencyScore(200, 50), 100);
});

test('frequencyScore: low count relative to p90 returns proportional score', () => {
    const score = frequencyScore(5, 100);
    assert.ok(score > 0 && score < 100, `expected 0 < ${score} < 100`);
});

test('frequencyScore: null/zero p90 treated as 1', () => {
    const s1 = frequencyScore(5, 0);
    const s2 = frequencyScore(5, null);
    assert.equal(s1, s2);
    assert.ok(s1 > 0);
});

// ---------------------------------------------------------------------------
// channelScore
// ---------------------------------------------------------------------------

test('channelScore: null/undefined channels returns 0', () => {
    assert.equal(channelScore(null), 0);
    assert.equal(channelScore(undefined), 0);
});

test('channelScore: empty array returns 0', () => {
    assert.equal(channelScore([]), 0);
});

test('channelScore: each channel adds 20 points', () => {
    assert.equal(channelScore(['email']), 20);
    assert.equal(channelScore(['email', 'whatsapp']), 40);
    assert.equal(channelScore(['email', 'whatsapp', 'linkedin']), 60);
});

test('channelScore: caps at 100 (5 channels)', () => {
    assert.equal(channelScore(['a', 'b', 'c', 'd', 'e']), 100);
    assert.equal(channelScore(['a', 'b', 'c', 'd', 'e', 'f']), 100);
});

// ---------------------------------------------------------------------------
// relationshipScore
// ---------------------------------------------------------------------------

test('relationshipScore: weights recency 50%, frequency 30%, channel 20%', () => {
    assert.equal(relationshipScore(100, 100, 100), 100);
    assert.equal(relationshipScore(0, 0, 0), 0);
    // 100*0.5 + 0*0.3 + 0*0.2 = 50
    assert.equal(relationshipScore(100, 0, 0), 50);
    // 0*0.5 + 100*0.3 + 0*0.2 = 30
    assert.equal(relationshipScore(0, 100, 0), 30);
    // 0*0.5 + 0*0.3 + 100*0.2 = 20
    assert.equal(relationshipScore(0, 0, 100), 20);
});

test('relationshipScore: rounds to nearest integer', () => {
    // 80*0.5 + 60*0.3 + 40*0.2 = 40 + 18 + 8 = 66
    assert.equal(relationshipScore(80, 60, 40), 66);
    // 33*0.5 + 33*0.3 + 33*0.2 = 16.5 + 9.9 + 6.6 = 33
    assert.equal(relationshipScore(33, 33, 33), 33);
});

// ---------------------------------------------------------------------------
// atomicWriteJsonSync
// ---------------------------------------------------------------------------

test('atomicWriteJsonSync: writes valid formatted JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-utils-'));
    const target = path.join(dir, 'contacts.json');

    atomicWriteJsonSync(target, [{ id: 'c1', name: 'Alice' }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 'c1', name: 'Alice' }]);
    assert.match(fs.readFileSync(target, 'utf8'), /\n  \{/);
});

test('atomicWriteJsonSync: replaces existing file and leaves no temp file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-utils-'));
    const target = path.join(dir, 'interactions.json');
    fs.writeFileSync(target, JSON.stringify([{ id: 'old' }]));

    atomicWriteJsonSync(target, [{ id: 'new' }]);

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), [{ id: 'new' }]);
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp.')), []);
});

test('atomicWriteJsonSync: creates missing parent directory', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-utils-'));
    const target = path.join(base, 'nested', 'deep', 'data.json');

    atomicWriteJsonSync(target, { synthetic: true });

    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { synthetic: true });
});

test('atomicWriteJsonSync: preserves existing target and cleans temp on write failure', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-utils-'));
    const target = path.join(dir, 'precious.json');
    fs.writeFileSync(target, JSON.stringify({ keep: 'me' }));

    // Create a circular reference to force JSON.stringify to throw
    const circular = {};
    circular.self = circular;

    assert.throws(() => atomicWriteJsonSync(target, circular));

    // Original file must survive
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { keep: 'me' });
    // No temp files left behind
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp.')), []);
});
