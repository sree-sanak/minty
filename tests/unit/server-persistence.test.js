'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'crm/server.js');

function serverSource() {
    return fs.readFileSync(SERVER_PATH, 'utf8');
}

test('[ServerPersistence]: core local JSON state writes use atomic writer', () => {
    const source = serverSource();
    for (const expectedPattern of [
        'atomicWriteJsonSync(paths.overrides, overrides)',
        'atomicWriteJsonSync(p, store)',
        'atomicWriteJsonSync(paths.goals, goals)',
        'atomicWriteJsonSync(paths.contacts, contacts)',
    ]) {
        assert.equal(
            source.includes(expectedPattern),
            true,
            `server.js must keep atomic JSON write: ${expectedPattern}`
        );
    }
    for (const unsafePattern of [
        'fs.writeFileSync(paths.overrides, JSON.stringify(overrides, null, 2))',
        'fs.writeFileSync(p, JSON.stringify(store, null, 2))',
        'fs.writeFileSync(paths.goals, JSON.stringify(goals, null, 2))',
        'fs.writeFileSync(paths.contacts, JSON.stringify(contacts, null, 2))',
    ]) {
        assert.equal(
            source.includes(unsafePattern),
            false,
            `server.js must not use non-atomic JSON write: ${unsafePattern}`
        );
    }
});
