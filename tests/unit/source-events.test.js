'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSourceEvents,
    summarizeSourceCoverage,
    canonicalSafeSource,
    safeContactRef,
} = require('../../crm/source-events');

test('builds privacy-safe canonical source events from interactions and profile evidence', () => {
    const contacts = [
        { id: 'c1', name: 'Alice Example', sources: { telegram: { userId: 'u1' }, linkedin: { headline: 'Founder' } } },
        { id: 'c2', name: 'Group Chat', isGroup: true, sources: { telegram: { userId: 'g1' } } },
        { id: 'c3', name: 'Announcements Channel', isChannel: true, sources: { slack: { channelId: 'C1' } } },
        { id: 'c4', name: 'Broadcast List', type: 'broadcast', sources: { whatsapp: { id: 'b1' } } },
    ];
    const interactions = [
        { id: 'i1', contactId: 'c1', source: 'telegram', body: 'secret raw DeFi lending thing', timestamp: '2026-05-01T10:00:00Z' },
        { id: 'i2', contactId: 'missing', source: 'sms', body: 'unattributed', timestamp: '2026-05-02T10:00:00Z' },
        { id: 'i3', contactId: 'c2', source: 'telegram', body: 'group', timestamp: '2026-05-03T10:00:00Z' },
        { id: 'i4', contactId: 'c3', source: 'slack', body: 'channel', timestamp: '2026-05-04T10:00:00Z' },
        { id: 'i5', contactId: 'c4', source: 'whatsapp', body: 'broadcast', timestamp: '2026-05-05T10:00:00Z' },
        { id: 'i6', isChannel: true, source: 'slack', body: 'direct channel marker', timestamp: '2026-05-06T10:00:00Z' },
    ];

    const events = buildSourceEvents({ contacts, interactions });

    assert.equal(events.length, 4);
    assert.deepEqual(events.map(e => e.type).sort(), ['message', 'profile', 'profile', 'unattributed_interaction']);
    const message = events.find(e => e.type === 'message');
    assert.equal(message.contactRef, safeContactRef('c1'));
    assert.equal(message.contactId, undefined);
    assert.equal(message.source, 'telegram');
    assert.equal(message.timestamp, '2026-05-01T10:00:00.000Z');
    assert.equal(message.hasTextSignal, true);
    assert.equal(JSON.stringify(message).includes('secret raw'), false);
    assert.equal(JSON.stringify(message).includes('Alice Example'), false);
    assert.equal(JSON.stringify(events).includes(safeContactRef('c2')), false);
    assert.equal(JSON.stringify(events).includes(safeContactRef('c3')), false);
    assert.equal(JSON.stringify(events).includes(safeContactRef('c4')), false);
    assert.equal(events.some(e => e.source === 'slack' || e.source === 'whatsapp'), false);
});

test('source coverage diagnostics are aggregate-only and source-aware', () => {
    const contacts = [
        { id: 'c1', sources: { telegram: { userId: 'u1' }, email: {}, slack: { userId: 'U1' } } },
        { id: 'c2', sources: { whatsapp: { id: 'w2' } } },
        { id: 'c3', isChannel: true, sources: { slack: { channelId: 'C3' }, email: { listId: 'L3' } } },
        { id: 'c4', chatType: 'mailing_list', sources: { googleContacts: { id: 'list-4' } } },
    ];
    const events = buildSourceEvents({
        contacts,
        interactions: [
            { contactId: 'c1', source: 'telegram', body: 'hi', timestamp: '2026-05-01T10:00:00Z' },
            { source: 'telegram', body: 'lost', timestamp: '2026-05-02T10:00:00Z' },
        ],
    });
    const summary = summarizeSourceCoverage({ contacts, sourceEvents: events, matchingContactIds: ['c1'] });

    assert.deepEqual(summary.availableSources, ['slack', 'telegram', 'whatsapp']);
    assert.deepEqual(summary.matchingSources, ['slack', 'telegram']);
    assert.equal(summary.profileContactsBySource.slack, 1);
    assert.equal(summary.profileContactsBySource.telegram, 1);
    assert.equal(summary.profileContactsBySource.whatsapp, 1);
    assert.equal(summary.profileContactsBySource.email, undefined);
    assert.equal(summary.profileContactsBySource.googlecontacts, undefined);
    assert.equal(summary.eventCountsBySource.telegram, 3);
    assert.equal(summary.eventCountsBySource.slack, 1);
    assert.equal(summary.attributedEvents, 4);
    assert.equal(summary.unattributedEvents, 1);
    assert.equal(summary.matchingContacts, 1);
});

test('source coverage ignores malformed source event rows without crashing', () => {
    const contacts = [{ id: 'c1', sources: { linkedin: { id: 'li1' } } }];
    const summary = summarizeSourceCoverage({
        contacts,
        sourceEvents: [null, undefined, 'bad row', 42, { contactId: 'c1', source: 'linkedin', attributed: true }],
        matchingContactIds: ['c1'],
    });

    assert.deepEqual(summary.availableSources, ['linkedin']);
    assert.deepEqual(summary.matchingSources, ['linkedin']);
    assert.equal(summary.eventCountsBySource.linkedin, 1);
    assert.equal(summary.totalEvents, 1);
    assert.equal(summary.attributedEvents, 1);
    assert.equal(summary.unattributedEvents, 0);
});

test('canonicalSafeSource never echoes arbitrary channel names', () => {
    assert.equal(canonicalSafeSource('Alice private thread'), 'interaction');
    assert.equal(canonicalSafeSource('google contacts'), 'googlecontacts');
    assert.equal(canonicalSafeSource('SMS'), 'sms');
});

test('source event ids do not persist raw upstream ids or contact handles', () => {
    const contacts = [{ id: 'alice@example.com', sources: { telegram: { userId: '+15551234567' } } }];
    const interactions = [{
        id: 'https://private.example/thread/alice@example.com',
        eventId: '+15551234567',
        contactId: 'alice@example.com',
        source: 'telegram',
        body: 'DeFi lending protocol note',
        timestamp: '2026-05-01T10:00:00Z',
    }];

    const events = buildSourceEvents({ contacts, interactions, insights: { 'alice@example.com': { topics: ['defi'] } } });
    const ids = events.map(e => e.id).join('\n');

    assert.equal(ids.includes('alice@example.com'), false);
    assert.equal(ids.includes('15551234567'), false);
    assert.equal(ids.includes('private.example'), false);
    assert.deepEqual(events.map(e => e.id), ['insight:2', 'interaction:0', 'profile:0:telegram']);
});
