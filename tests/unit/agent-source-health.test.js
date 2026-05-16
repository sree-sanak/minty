'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSourceHealth, buildSourceAnswerability } = require('../../crm/agent-source-health');

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
    assert.ok('discord' in out.sources);
    assert.ok('telegram' in out.sources);
    assert.ok('email' in out.sources);
});

test('[AgentSourceHealth]: reports Discord as a fresh evidence-bearing local source', () => {
    const out = buildAgentSourceHealth({
        contacts: [contact({
            id: 'c_discord',
            name: 'Discord Friend',
            emails: [],
            phones: [],
            sources: { discord: { discordRef: 'discord_user_abc123' } },
            activeChannels: ['discord'],
        })],
        interactions: [{ contactId: 'c_discord', source: 'discord', body: 'private discord alpha note', timestamp: '2026-05-06T07:30:00Z' }],
        contactEvidence: { c_discord: { sources: ['discord'], topics: ['alpha'], updatedAt: '2026-05-06T07:35:00Z' } },
        sourceEvents: [{ source: 'discord', contactId: 'c_discord', text: 'private source event' }],
        syncState: { discord: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok' } },
    }, { source: 'Discord DM', now: NOW });

    assert.equal(out.status, 'ok');
    assert.equal(out.sources.discord.status, 'ready');
    assert.equal(out.sources.discord.contactCount, 1);
    assert.equal(out.sources.discord.interactionCount, 1);
    assert.equal(out.sources.discord.evidenceContactCount, 1);
    assert.equal(out.sources.discord.sourceEventCount, 1);

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('discord_user_abc123'), false);
    assert.equal(serialized.includes('private discord alpha note'), false);
    assert.equal(serialized.includes('c_discord'), false);
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

test('[AgentSourceHealth]: exposes privacy-safe memory refresh status', () => {
    const out = buildAgentSourceHealth({
        contacts: [contact()],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: { telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok' } },
        memoryRefreshStatus: {
            generatedAt: '2026-05-07T09:30:00Z',
            status: 'failed',
            failedStep: 'telegram',
            steps: {
                telegram: {
                    status: 'failed',
                    detail: 'failed for alice@example.com at /root/.hermes/google_token.json with api_key="private-token"',
                    error: 'raw-phone-555-0101',
                },
            },
            warnings: ['raw private path /root/.hermes/private/brain token abc123'],
        },
    }, { source: 'telegram', now: NOW });

    assert.equal(out.status, 'warning');
    assert.deepEqual(out.refresh, {
        status: 'failed',
        failedStep: 'telegram',
        generatedAt: '2026-05-07T09:30:00Z',
        warnings: ['raw private path [REDACTED_PATH] [REDACTED_TOKEN]'],
        nextActions: ['Check Telegram importer credentials and recent export freshness.'],
    });

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('/root/.hermes/google_token.json'), false);
    assert.equal(serialized.includes('private-token'), false);
    assert.equal(serialized.includes('abc123'), false);
    assert.equal(serialized.includes('raw-phone-555-0101'), false);
});

test('[AgentSourceHealth]: defaults to unknown memory refresh status', () => {
    const out = buildAgentSourceHealth({ contacts: [], interactions: [], contactEvidence: {}, syncState: {} }, { now: NOW });

    assert.deepEqual(out.refresh, {
        status: 'unknown',
        failedStep: null,
        generatedAt: null,
        warnings: [],
        nextActions: [],
    });
});

test('[AgentSourceHealth]: rejects unsafe refresh timestamp and failed step fields', () => {
    const out = buildAgentSourceHealth({
        contacts: [],
        interactions: [],
        contactEvidence: {},
        syncState: {},
        memoryRefreshStatus: {
            status: 'failed',
            failedStep: 'alice@example.com /root/private/.env',
            generatedAt: 'alice@example.com /root/private/status.json token=unsafe',
            warnings: ['safe aggregate warning'],
        },
    }, { now: NOW });
    const serialized = JSON.stringify(out.refresh);

    assert.equal(out.refresh.status, 'failed');
    assert.equal(out.refresh.failedStep, null);
    assert.equal(out.refresh.generatedAt, null);
    assert.deepEqual(out.refresh.warnings, ['safe aggregate warning']);
    assert.deepEqual(out.refresh.nextActions, ['Inspect the local memory refresh job and rerun npm run memory:refresh after fixing the failed source.']);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('/root/private'), false);
    assert.equal(serialized.includes('unsafe'), false);
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

test('[AgentSourceHealth]: source answerability blocks stale explicit sources', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c_private', sources: { telegram: {} }, activeChannels: ['telegram'] }],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: { telegram: { lastSyncAt: '2026-04-01T00:00:00Z', status: 'ok' } },
    }, { source: 'telegram', now: '2026-05-09T00:00:00Z' });

    const answerability = buildSourceAnswerability(health, { explicit: true });

    assert.equal(answerability.answerable, false);
    assert.equal(answerability.status, 'blocked');
    assert.deepEqual(answerability.sources, ['telegram']);
    assert.ok(answerability.warnings.includes('no_recent_sync'));
    assert.match(answerability.suggestedNextStep, /refresh|source_health|service/i);
});

test('[AgentSourceHealth]: source answerability blocks fresh sources with sync errors', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c_private', sources: { telegram: { username: 'synthetic' } }, activeChannels: ['telegram'] }],
        interactions: [{ contactId: 'c_private', source: 'telegram', body: 'synthetic agent infra note', at: '2026-05-08T00:00:00Z' }],
        contactEvidence: { c_private: { sources: ['telegram'], topics: ['agent infra'], evidenceCount: 1 } },
        sourceEvents: [{ source: 'telegram', timestamp: '2026-05-08T00:00:00Z', contactRef: 'contact:abcdefghijklmnop' }],
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z', status: 'error', lastError: 'Sync failed' } },
    }, { source: 'telegram', now: '2026-05-09T00:00:00Z' });

    const answerability = buildSourceAnswerability(health, {
        explicit: true,
        queryEvidenceChecked: true,
        queryMatchedSources: ['telegram'],
    });

    assert.equal(health.sources.telegram.status, 'error');
    assert.ok(health.sources.telegram.warnings.includes('sync_error'));
    assert.equal(answerability.answerable, false);
    assert.equal(answerability.status, 'blocked');
    assert.ok(answerability.warnings.includes('sync_error'));
    assert.ok(answerability.warnings.includes('source_unhealthy'));
});

test('[AgentSourceHealth]: source answerability allows fresh query-matched sources', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c_private', sources: { telegram: { username: 'synthetic' } }, activeChannels: ['telegram'] }],
        interactions: [{ contactId: 'c_private', source: 'telegram', body: 'synthetic agent infra note', at: '2026-05-08T00:00:00Z' }],
        contactEvidence: { c_private: { sources: ['telegram'], topics: ['agent infra'], evidenceCount: 1 } },
        sourceEvents: [{ source: 'telegram', timestamp: '2026-05-08T00:00:00Z', contactRef: 'contact:abcdefghijklmnop' }],
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z', status: 'ok' } },
    }, { source: 'telegram', now: '2026-05-09T00:00:00Z' });

    const answerability = buildSourceAnswerability(health, {
        explicit: true,
        queryEvidenceChecked: true,
        queryMatchedSources: ['telegram'],
    });

    assert.equal(answerability.answerable, true);
    assert.equal(answerability.status, 'answerable');
    assert.deepEqual(answerability.sources, ['telegram']);
});

test('[AgentSourceHealth]: fresh explicit source still blocks when query has no source-matched evidence', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c_private', sources: { telegram: { username: 'synthetic' } }, activeChannels: ['telegram'] }],
        interactions: [{ contactId: 'c_private', source: 'telegram', body: 'synthetic robotics note', at: '2026-05-08T00:00:00Z' }],
        contactEvidence: { c_private: { sources: ['telegram'], topics: ['robotics'], evidenceCount: 1 } },
        sourceEvents: [{ source: 'telegram', timestamp: '2026-05-08T00:00:00Z', contactRef: 'contact:abcdefghijklmnop' }],
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z', status: 'ok' } },
    }, { source: 'telegram', now: '2026-05-09T00:00:00Z' });

    const answerability = buildSourceAnswerability(health, {
        explicit: true,
        queryEvidenceChecked: true,
        queryMatchedSources: [],
    });

    assert.equal(answerability.answerable, false);
    assert.equal(answerability.status, 'blocked');
    assert.ok(answerability.warnings.includes('no_query_evidence'));
});

test('[AgentSourceHealth]: explicit multi-source answerability blocks when any requested source is unsafe', () => {
    const answerability = buildSourceAnswerability({
        status: 'warning',
        sources: {
            telegram: { status: 'ready', warnings: [] },
            linkedin: { status: 'stale', warnings: ['no_recent_sync'] },
        },
        invalidSourceFilters: [],
    }, { explicit: true });

    assert.equal(answerability.answerable, false);
    assert.equal(answerability.status, 'blocked');
    assert.deepEqual(answerability.sources, ['linkedin', 'telegram']);
    assert.deepEqual(answerability.answerableSources, ['telegram']);
    assert.ok(answerability.warnings.includes('no_recent_sync'));
});

test('[AgentSourceHealth]: source answerability keeps canonical source keys authoritative', () => {
    const answerability = buildSourceAnswerability({
        status: 'ok',
        sources: {
            telegram: { source: 'email', status: 'ready', warnings: [] },
        },
        invalidSourceFilters: [],
    }, { explicit: true });

    assert.deepEqual(answerability.sources, ['telegram']);
    assert.deepEqual(answerability.answerableSources, ['telegram']);
    assert.equal(answerability.perSource[0].source, 'telegram');
});
