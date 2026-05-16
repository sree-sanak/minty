'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSourceQualityWorkbench } = require('../../crm/source-quality-workbench');

const NOW = '2026-05-06T08:00:00Z';

function baseData(overrides = {}) {
    return {
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: {},
        identityDecisions: {},
        ...overrides,
    };
}

test('[SourceQualityWorkbench]: returns populated privacy-safe trust gap buckets', () => {
    const payload = buildSourceQualityWorkbench(baseData({
        contacts: [
            {
                id: 'raw-contact-alpha',
                name: 'Alice Sentinel',
                email: 'alice.private@example.com',
                phones: ['raw-phone-555-0101'],
                company: 'SensitiveCo',
                sources: { linkedin: { id: 'raw-linkedin-id', url: 'https://private.example/alice' } },
            },
            {
                id: 'raw-contact-beta',
                name: 'Alicia Sentinel',
                emails: ['alicia.private@example.com'],
                company: 'SensitiveCo',
                sources: { linkedin: { id: 'raw-linkedin-id-2' } },
            },
            {
                id: 'raw-contact-telegram',
                name: 'Telegram Sentinel',
                sources: { telegram: { username: 'raw_telegram_handle' } },
                activeChannels: ['telegram'],
            },
        ],
        interactions: [{
            id: 'raw-message-id',
            source: 'telegram',
            contactId: 'raw-contact-telegram',
            text: 'private telegram body with alice.private@example.com',
            timestamp: '2026-05-06T07:30:00Z',
        }],
        contactEvidence: {
            'raw-contact-telegram': { sources: ['telegram'], topics: [] },
        },
        sourceEvents: [{ source: 'telegram', contactId: 'raw-contact-telegram', detail: 'private event text' }],
        syncState: {
            telegram: { status: 'ok', lastSyncAt: '2026-05-06T07:00:00Z' },
            email: { status: 'error', lastSyncAt: '2026-04-01T00:00:00Z', lastError: 'token abc123 /root/private/email.json' },
        },
    }), { now: NOW });

    assert.equal(payload.status, 'needs_review');
    assert.equal(payload.summary.totalOpenItems, 4);
    assert.equal(payload.buckets.ambiguousIdentityClusters.count, 1);
    assert.equal(payload.buckets.weakEvidenceSources.count, 1);
    assert.equal(payload.buckets.staleOrUnhealthySources.count, 1);
    assert.equal(payload.buckets.ingestionGaps.count, 1);
    assert.deepEqual(payload.buckets.ambiguousIdentityClusters.items[0], {
        ref: 'identity:1',
        severity: 'review',
        candidateCount: 2,
        reasonKinds: ['name_similarity', 'org_overlap'],
        action: 'Review ambiguous identity match before trusting cross-source context.',
    });
    assert.deepEqual(payload.buckets.weakEvidenceSources.items[0], {
        ref: 'source:telegram:evidence',
        source: 'telegram',
        severity: 'watch',
        evidenceContactCount: 1,
        interactionCount: 1,
        warning: 'weak_or_missing_contact_evidence',
        action: 'Review source events or contact evidence so agents can cite why this source is relevant.',
    });
    assert.deepEqual(payload.buckets.staleOrUnhealthySources.items[0], {
        ref: 'source:email:health',
        source: 'email',
        severity: 'fix',
        status: 'error',
        freshness: 'stale',
        warnings: ['no_contacts', 'no_query_evidence', 'no_recent_sync', 'sync_error'],
        action: 'Refresh or repair this local source before relying on it for source-specific answers.',
    });
    assert.deepEqual(payload.buckets.ingestionGaps.items[0], {
        ref: 'source:email:ingestion',
        source: 'email',
        severity: 'setup',
        warning: 'configured_without_usable_records',
        contactCount: 0,
        interactionCount: 0,
        action: 'Check importer output and run merge so this source contributes usable network memory.',
    });
    assert.equal(payload.safety.readOnly, true);
    assert.equal(payload.safety.contactDetailsOmitted, true);
    assert.equal(payload.safety.rawRowsOmitted, true);
    assert.equal(payload.safety.opaqueRefsOnly, true);

    const serialized = JSON.stringify(payload);
    for (const forbidden of [
        'raw-contact-alpha',
        'raw-contact-beta',
        'raw-contact-telegram',
        'Alice Sentinel',
        'Alicia Sentinel',
        'alice.private@example.com',
        'raw-phone-555-0101',
        'raw-linkedin-id',
        'https://private.example',
        'raw_telegram_handle',
        'private telegram body',
        'private event text',
        'abc123',
        '/root/private/email.json',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});

test('[SourceQualityWorkbench]: returns honest empty state without synthetic work', () => {
    const payload = buildSourceQualityWorkbench(baseData({
        contacts: [{
            id: 'safe-ready-contact',
            name: 'Ready Person',
            sources: { telegram: { username: 'ready_person' } },
            activeChannels: ['telegram'],
        }],
        interactions: [{ source: 'telegram', contactId: 'safe-ready-contact', text: 'synthetic evidence note' }],
        contactEvidence: { 'safe-ready-contact': { sources: ['telegram'], topics: ['agents'] } },
        sourceEvents: [{ source: 'telegram', contactId: 'safe-ready-contact' }],
        syncState: { telegram: { status: 'ok', lastSyncAt: '2026-05-06T07:00:00Z' } },
    }), { now: NOW, sources: ['telegram'] });

    assert.equal(payload.status, 'clear');
    assert.equal(payload.summary.totalOpenItems, 0);
    assert.deepEqual(payload.buckets.ambiguousIdentityClusters.items, []);
    assert.deepEqual(payload.buckets.weakEvidenceSources.items, []);
    assert.deepEqual(payload.buckets.staleOrUnhealthySources.items, []);
    assert.deepEqual(payload.buckets.ingestionGaps.items, []);
    assert.equal(payload.emptyState, 'No source-quality trust gaps found for the selected local sources.');
});

test('[SourceQualityWorkbench]: source filters scope identity-review gaps', () => {
    const data = baseData({
        contacts: [
            {
                id: 'linkedin-alpha',
                name: 'Filtered Sentinel',
                company: 'FilterCo',
                sources: { linkedin: { id: 'raw-linkedin-alpha' } },
            },
            {
                id: 'linkedin-beta',
                name: 'Filter Sentinel',
                company: 'FilterCo',
                sources: { linkedin: { id: 'raw-linkedin-beta' } },
            },
            {
                id: 'telegram-ready',
                name: 'Telegram Ready',
                sources: { telegram: { username: 'telegram_ready' } },
                activeChannels: ['telegram'],
            },
        ],
        interactions: [{ source: 'telegram', contactId: 'telegram-ready', text: 'synthetic telegram evidence' }],
        contactEvidence: { 'telegram-ready': { sources: ['telegram'], topics: ['agents'] } },
        sourceEvents: [{ source: 'telegram', contactId: 'telegram-ready' }],
        syncState: {
            telegram: { status: 'ok', lastSyncAt: '2026-05-06T07:00:00Z' },
            linkedin: { status: 'ok', lastSyncAt: '2026-05-06T07:00:00Z' },
        },
    });

    const telegramPayload = buildSourceQualityWorkbench(data, { now: NOW, sources: ['telegram'] });
    assert.equal(telegramPayload.status, 'clear');
    assert.equal(telegramPayload.buckets.ambiguousIdentityClusters.count, 0);
    assert.equal(telegramPayload.summary.totalOpenItems, 0);

    const scalarTelegramPayload = buildSourceQualityWorkbench(data, { now: NOW, source: 'telegram' });
    assert.equal(scalarTelegramPayload.status, 'clear');
    assert.equal(scalarTelegramPayload.buckets.ambiguousIdentityClusters.count, 0);

    const linkedinPayload = buildSourceQualityWorkbench(data, { now: NOW, sources: ['linkedin'] });
    assert.equal(linkedinPayload.status, 'needs_review');
    assert.equal(linkedinPayload.buckets.ambiguousIdentityClusters.count, 1);
    assert.equal(linkedinPayload.summary.totalOpenItems, 1);
});

test('[SourceQualityWorkbench]: invalid source filters fail closed for identity-review gaps', () => {
    const payload = buildSourceQualityWorkbench(baseData({
        contacts: [
            { id: 'alpha', name: 'Private Alpha', company: 'PrivateCo', sources: { linkedin: { id: 'raw-a' } } },
            { id: 'beta', name: 'Private Alfa', company: 'PrivateCo', sources: { linkedin: { id: 'raw-b' } } },
        ],
    }), { now: NOW, sources: ['linkedin', 'private-channel@example.com'] });

    assert.equal(payload.status, 'clear');
    assert.equal(payload.buckets.ambiguousIdentityClusters.count, 0);
    assert.equal(JSON.stringify(payload).includes('private-channel@example.com'), false);
});
