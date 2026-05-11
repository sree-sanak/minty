'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    extractEvidencePatchesFromEvent,
    validateEvidencePatch,
    applyEvidencePatches,
} = require('../../crm/evidence-patches');

test('extracts structured allowlisted evidence patches without raw text leakage', () => {
    const event = {
        id: 'evt_1',
        contactId: 'c1',
        source: 'telegram',
        type: 'message',
        timestamp: '2026-05-01T10:00:00.000Z',
        text: 'Alice said the private URL https://example.com and phone +15551234567 while discussing DeFi custody and lending protocols',
    };

    const patches = extractEvidencePatchesFromEvent(event);

    assert.equal(patches.length >= 2, true);
    assert.deepEqual([...new Set(patches.map(p => p.topic))].sort(), ['custody', 'defi', 'lending protocol'].sort());
    const forbiddenHost = ['example', 'com'].join('.');
    assert.equal(JSON.stringify(patches).includes('Alice'), false);
    assert.equal(JSON.stringify(patches).includes(forbiddenHost), false);
    assert.equal(JSON.stringify(patches).includes('15551234567'), false);
    assert.equal(JSON.stringify(patches).includes('evt_1'), false);
    assert.equal(patches.some(p => Object.hasOwn(p, 'eventId')), false);
    assert.equal(patches.every(p => validateEvidencePatch(p).ok), true);
});

test('rejects invalid, orphan, group, and arbitrary-topic evidence patches', () => {
    const validContacts = [{ id: 'c1' }, { id: 'g1', isGroup: true }];
    const bad = [
        { contactId: 'missing', topic: 'defi', source: 'telegram' },
        { contactId: 'g1', topic: 'defi', source: 'telegram' },
        { contactId: 'c1', topic: 'Secret Project Codename', source: 'telegram' },
        { contactId: 'c1', topic: 'defi', source: 'private channel name' },
    ];

    const applied = applyEvidencePatches({ contacts: validContacts, patches: bad });

    assert.deepEqual(Object.keys(applied), []);
});

test('rejects channel, broadcast, and mailing-list evidence targets and events', () => {
    const contacts = [
        { id: 'person' },
        { id: 'channel', isChannel: true },
        { id: 'broadcast', isBroadcast: true },
        { id: 'list', type: 'distribution_list' },
        { id: 'nested', sources: { whatsapp: { chatType: 'channel', id: 'team@newsletter' } } },
        { id: 'jid', jid: 'team@g.us' },
        { id: 'slack-channel', sources: { slack: { source: 'slack', channelId: 'C123TEAM' } } },
    ];
    const patches = contacts.slice(1).map(c => ({ contactId: c.id, topic: 'defi', source: 'telegram' }));

    const applied = applyEvidencePatches({ contacts, patches });

    assert.deepEqual(Object.keys(applied), []);
    assert.deepEqual(extractEvidencePatchesFromEvent({ contactId: 'person', isChannel: true, text: 'DeFi custody' }), []);
    assert.deepEqual(extractEvidencePatchesFromEvent({ contactId: 'person', threadType: 'mailing_list', text: 'DeFi custody' }), []);
    assert.deepEqual(extractEvidencePatchesFromEvent({ contactId: 'person', source: 'slack', channelId: 'C123TEAM', text: 'DeFi custody' }), []);
});

test('applies structured patches into compact contact evidence summaries', () => {
    const contacts = [{ id: 'c1' }];
    const patches = [
        { contactId: 'c1', topic: 'defi', source: 'telegram', timestamp: '2026-05-01T10:00:00.000Z', confidence: 0.8, eventId: 'e1' },
        { contactId: 'c1', topic: 'defi', source: 'sms', timestamp: '2026-05-02T10:00:00.000Z', confidence: 0.6, eventId: 'e2' },
    ];

    const evidence = applyEvidencePatches({ contacts, patches });

    assert.deepEqual(Object.keys(evidence), ['c1']);
    assert.deepEqual(evidence.c1.sources.sort(), ['sms', 'telegram']);
    assert.deepEqual(evidence.c1.topics, ['defi']);
    assert.equal(evidence.c1.topicEvidence[0].count, 2);
    assert.equal(evidence.c1.topicEvidence[0].latestAt, '2026-05-02T10:00:00.000Z');
    assert.equal(JSON.stringify(evidence).includes('eventId'), false);
    assert.equal(JSON.stringify(evidence).includes('e1'), false);
    assert.equal(JSON.stringify(evidence).includes('e2'), false);
});
