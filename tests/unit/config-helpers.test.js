/**
 * Characterization tests for crm/config.js pure helpers: deepMerge, deepClone, setPath.
 *
 * These functions underpin config resolution (merging defaults → legacy →
 * on-disk → env) so regressions here would silently break settings.
 * This is characterization coverage of existing behaviour, not a new feature.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deepMerge, deepClone, setPath } = require('../../crm/config');

// ---------------------------------------------------------------------------
// deepClone
// ---------------------------------------------------------------------------

test('[Config helpers] deepClone: returns an equal but distinct object', () => {
    const obj = { a: 1, b: { c: 2 } };
    const clone = deepClone(obj);
    assert.deepEqual(clone, obj);
    assert.notEqual(clone, obj);
    assert.notEqual(clone.b, obj.b);
});

test('[Config helpers] deepClone: clones arrays', () => {
    const obj = { list: [1, { x: 2 }] };
    const clone = deepClone(obj);
    assert.deepEqual(clone, obj);
    assert.notEqual(clone.list, obj.list);
    assert.notEqual(clone.list[1], obj.list[1]);
});

test('[Config helpers] deepClone: primitives pass through', () => {
    assert.equal(deepClone(null), null);
    assert.equal(deepClone(42), 42);
    assert.equal(deepClone('hello'), 'hello');
    assert.equal(deepClone(true), true);
    assert.equal(deepClone(undefined), undefined);
});

test('[Config helpers] deepClone: mutation of clone does not affect original', () => {
    const obj = { nested: { val: 'original' } };
    const clone = deepClone(obj);
    clone.nested.val = 'changed';
    assert.equal(obj.nested.val, 'original');
});

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

test('[Config helpers] deepMerge: shallow keys from source override target', () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    assert.deepEqual(result, { a: 1, b: 3, c: 4 });
});

test('[Config helpers] deepMerge: nested objects are recursively merged', () => {
    const target = { google: { clientId: 'id', clientSecret: '' } };
    const source = { google: { clientSecret: 'secret' } };
    const result = deepMerge(target, source);
    assert.equal(result.google.clientId, 'id');
    assert.equal(result.google.clientSecret, 'secret');
});

test('[Config helpers] deepMerge: does not mutate target or source', () => {
    const target = { a: { x: 1 } };
    const source = { a: { y: 2 } };
    const tClone = deepClone(target);
    const sClone = deepClone(source);
    deepMerge(target, source);
    assert.deepEqual(target, tClone);
    assert.deepEqual(source, sClone);
});

test('[Config helpers] deepMerge: null/undefined source treated as empty', () => {
    const result = deepMerge({ a: 1 }, null);
    assert.deepEqual(result, { a: 1 });
    const result2 = deepMerge({ a: 1 }, undefined);
    assert.deepEqual(result2, { a: 1 });
});

test('[Config helpers] deepMerge: arrays are replaced, not merged', () => {
    const result = deepMerge({ tags: [1, 2] }, { tags: [3] });
    assert.deepEqual(result.tags, [3]);
});

test('[Config helpers] deepMerge: undefined values in source are skipped', () => {
    const result = deepMerge({ a: 1 }, { a: undefined });
    assert.equal(result.a, 1);
});

// ---------------------------------------------------------------------------
// setPath
// ---------------------------------------------------------------------------

test('[Config helpers] setPath: sets a top-level key', () => {
    const obj = { a: 1 };
    setPath(obj, 'b', 2);
    assert.equal(obj.b, 2);
});

test('[Config helpers] setPath: sets a nested key', () => {
    const obj = { google: { clientId: '' } };
    setPath(obj, 'google.clientSecret', 'secret');
    assert.equal(obj.google.clientSecret, 'secret');
});

test('[Config helpers] setPath: creates intermediate objects when missing', () => {
    const obj = {};
    setPath(obj, 'a.b.c', 42);
    assert.equal(obj.a.b.c, 42);
});

test('[Config helpers] setPath: overwrites non-object intermediates', () => {
    const obj = { a: 'string' };
    setPath(obj, 'a.b', 1);
    assert.equal(obj.a.b, 1);
});
