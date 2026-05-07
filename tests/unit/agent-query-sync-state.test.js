'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadData } = require('../../scripts/agent-query');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test('[AgentQuery]: loadData loads sync state for source health tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok', tokenPath: '/secret/token.json' },
    });

    const data = loadData(dir);

    assert.equal(data.syncState.telegram.lastSyncAt, '2026-05-06T07:00:00Z');
    assert.equal(data.syncState.telegram.status, 'ok');
    assert.equal(Object.hasOwn(data.syncState.telegram, 'tokenPath'), false);
});

test('[AgentQuery]: loadData falls back to empty sync state when missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);

    assert.deepEqual(loadData(dir).syncState, {});

    fs.writeFileSync(path.join(dir, 'sync-state.json'), '{not-json');
    assert.deepEqual(loadData(dir).syncState, {});
});
