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

test('emailKey: strips plus-addressing', () => {
    assert.equal(emailKey('user+work@example.com'), 'user@example.com');
    assert.equal(emailKey('alice+newsletter@outlook.com'), 'alice@outlook.com');
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
