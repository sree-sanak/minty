'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSourceHealth } = require('../../crm/agent-source-health');

const NOW = '2026-05-06T08:00:00Z';

function contact(overrides = {}) {
    return {
        id: 'c_private',
        name: 'Alice Private',
        emails: ['alice@example.com'],
        phones: ['+447700900123'],
        sources: { telegram: { username: 'alice_private' } },
        activeChannels: ['telegram'],
        ...overrides,
    };
}

test('[AgentSourceHealth]: summarizes fresh evidence-bearing source without PII', () => {
    const out = buildAgentSourceHealth({
        contacts: [contact()],
        interactions: [{ contactId: 'c_private', source: 'telegram', body: 'secret defi message', timestamp: '2026-05-06T07:30:00Z' }],
        contactEvidence: { c_private: { sources: ['telegram'], topics: ['defi'], updatedAt: '2026-05-06T07:35:00Z' } },
        sourceEvents: [{ source: 'telegram', contactId: 'c_private', text: 'private source event' }],
        syncState: { telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok', tokenPath: '/secret/token.json' } },
    }, { source: 'telegram', now: NOW });

    assert.equal(out.status, 'ok');
    assert.equal(out.sources.telegram.status, 'ready');
    assert.equal(out.sources.telegram.freshness, 'fresh');
    assert.equal(out.sources.telegram.contactCount, 1);
    assert.equal(out.sources.telegram.interactionCount, 1);
    assert.equal(out.sources.telegram.evidenceContactCount, 1);
    assert.equal(out.sources.telegram.sourceEventCount, 1);
    assert.equal(out.sources.telegram.lastSyncAt, '2026-05-06T07:00:00Z');

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('+447700900123'), false);
    assert.equal(serialized.includes('secret defi message'), false);
    assert.equal(serialized.includes('private source event'), false);
    assert.equal(serialized.includes('c_private'), false);
    assert.equal(serialized.includes('/secret/token.json'), false);
});

test('[AgentSourceHealth]: reports stale and empty sources honestly', () => {
    const out = buildAgentSourceHealth({
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: { email: { lastSyncAt: '2026-04-01T00:00:00Z', status: 'ok' } },
    }, { source: 'email', now: NOW });

    assert.equal(out.status, 'warning');
    assert.equal(Object.keys(out.sources).length, 1);
    assert.equal(out.sources.email.status, 'stale');
    assert.ok(out.sources.email.warnings.includes('no_contacts'));
    assert.ok(out.sources.email.warnings.includes('no_query_evidence'));
    assert.ok(out.sources.email.warnings.includes('no_recent_sync'));
});

test('[AgentSourceHealth]: invalid source filter fails closed without echoing input', () => {
    const out = buildAgentSourceHealth({ contacts: [], interactions: [], contactEvidence: {}, syncState: {} }, {
        source: 'telegram; alice@example.com',
        now: NOW,
    });

    assert.equal(out.status, 'error');
    assert.deepEqual(out.sources, {});
    assert.deepEqual(out.invalidSourceFilters, ['invalid']);
    assert.equal(JSON.stringify(out).includes('alice@example.com'), false);
});

test('[AgentSourceHealth]: mixed source and sources filters fail closed on any invalid value', () => {
    const out = buildAgentSourceHealth({ contacts: [contact()], interactions: [], contactEvidence: {}, syncState: {} }, {
        source: 'telegram; alice@example.com',
        sources: ['telegram'],
        now: NOW,
    });

    assert.equal(out.status, 'error');
    assert.deepEqual(out.sources, {});
    assert.deepEqual(out.invalidSourceFilters, ['invalid']);
    assert.equal(JSON.stringify(out).includes('alice@example.com'), false);
});

test('[AgentSourceHealth]: all-sources summary with no filter', () => {
    const out = buildAgentSourceHealth({
        contacts: [contact()],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: {},
    }, { now: NOW });

    // Should include all known sources
    assert.ok(Object.keys(out.sources).length >= 5);
    assert.ok('telegram' in out.sources);
    assert.ok('email' in out.sources);
});

test('[AgentSourceHealth]: not_configured warning when sync state missing', () => {
    const out = buildAgentSourceHealth({
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: {},
    }, { source: 'telegram', now: NOW });

    assert.ok(out.sources.telegram.warnings.includes('not_configured'));
    assert.ok(out.sources.telegram.warnings.includes('no_recent_sync'));
});

test('[AgentSourceHealth]: safety envelope always present', () => {
    const out = buildAgentSourceHealth({ contacts: [], interactions: [], contactEvidence: {}, syncState: {} }, { now: NOW });

    assert.equal(out.safety.readOnly, true);
    assert.equal(out.safety.contactDetailsOmitted, true);
    assert.equal(out.safety.rawRowsOmitted, true);
});

test('[AgentSourceHealth]: malformed nested source fields degrade safely', () => {
    assert.doesNotThrow(() => buildAgentSourceHealth({
        contacts: [{ sources: { telegram: { username: 'safe' } }, activeChannels: 'telegram' }],
        interactions: [],
        contactEvidence: {
            c_malformed: {
                sources: 'telegram',
                topicEvidence: [{ sources: 'telegram' }, null],
            },
        },
        sourceEvents: [],
        syncState: { telegram: { lastSyncAt: '2026-05-06T07:00:00Z' } },
    }, { source: 'telegram', now: NOW }));
});
