'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildHybridIndex, queryHybridIndex } = require('../../crm/hybrid-index');
const { safeContactRef } = require('../../crm/source-events');

test('builds a privacy-safe local hybrid index over contacts, evidence, and source events', () => {
    const contacts = [
        { id: 'c1', name: 'Alice', title: 'Investor', company: 'Fund', relationshipScore: 80 },
        { id: 'g1', name: 'Group', isGroup: true },
    ];
    const contactEvidence = {
        c1: { topics: ['defi'], sources: ['telegram'], latestAt: '2026-05-02T00:00:00.000Z', topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 2 }] },
        g1: { topics: ['defi'], sources: ['telegram'] },
    };
    const sourceEvents = [{ contactId: 'c1', source: 'telegram', type: 'message', hasTextSignal: true }];

    const index = buildHybridIndex({ contacts, contactEvidence, sourceEvents });

    assert.equal(index.length, 1);
    assert.equal(index[0].contactRef, safeContactRef('c1'));
    assert.equal(index[0].id, undefined);
    assert.equal(JSON.stringify(index).includes('Alice'), false);
    assert.equal(Object.hasOwn(index[0], 'profileTokens'), false);
    assert.equal(index[0].topicTokens.includes('defi'), true);
    assert.deepEqual(index[0].sources, ['telegram']);
});

test('hybrid index does not persist arbitrary profile metadata tokens', () => {
    const index = buildHybridIndex({
        contacts: [{
            id: 'c1',
            title: 'Secret Project Falcon investor',
            company: 'PrivateCompanyName',
            headline: 'Works on codename Aurora',
            location: 'Private Street',
            relationshipScore: 80,
        }],
        contactEvidence: {},
        sourceEvents: [],
    });

    const serialized = JSON.stringify(index);
    assert.equal(serialized.includes('Secret'), false);
    assert.equal(serialized.includes('PrivateCompanyName'), false);
    assert.equal(serialized.includes('Aurora'), false);
    assert.equal(queryHybridIndex('Secret Project Falcon', { index }).length, 0);
});

test('hybrid query ranks exact evidence over profile-only warmth', () => {
    const contacts = [
        { id: 'warm', title: 'Founder', relationshipScore: 95 },
        { id: 'defi', title: 'Operator', relationshipScore: 20 },
    ];
    const contactEvidence = {
        defi: { topics: ['defi', 'lending protocol'], sources: ['telegram'], latestAt: '2026-05-02T00:00:00.000Z', topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 2 }] },
    };
    const index = buildHybridIndex({ contacts, contactEvidence, sourceEvents: [] });
    const results = queryHybridIndex('who do I know in DeFi lending?', { index, limit: 2 });

    assert.equal(results[0].contactRef, safeContactRef('defi'));
    assert.equal(results[0].evidenceBacked, true);
    assert.equal(results[0].matchedTopics.includes('defi'), true);
});

test('hybrid query returns empty for unsupported arbitrary private phrase', () => {
    const index = buildHybridIndex({
        contacts: [{ id: 'c1', title: 'Founder', relationshipScore: 90 }],
        contactEvidence: {},
        sourceEvents: [],
    });
    const results = queryHybridIndex('secret codename from private chat', { index });
    assert.deepEqual(results, []);
});

// RED tests: buildHybridIndex must exclude isChannel/isBroadcast/isList/isMailingList contacts
test('buildHybridIndex excludes isChannel contacts', () => {
    const contacts = [
        { id: 'c_person', name: 'Alice', relationshipScore: 80 },
        { id: 'c_channel', name: 'Telegram Channel', isChannel: true },
    ];
    const index = buildHybridIndex({ contacts, contactEvidence: {}, sourceEvents: [] });
    assert.equal(index.length, 1);
    assert.equal(index[0].contactRef, safeContactRef('c_person'));
});

test('buildHybridIndex excludes isBroadcast contacts', () => {
    const contacts = [
        { id: 'c_person', name: 'Bob', relationshipScore: 80 },
        { id: 'c_broadcast', name: 'Broadcast List', isBroadcast: true },
    ];
    const index = buildHybridIndex({ contacts, contactEvidence: {}, sourceEvents: [] });
    assert.equal(index.length, 1);
    assert.equal(index[0].contactRef, safeContactRef('c_person'));
});

test('buildHybridIndex excludes isList contacts', () => {
    const contacts = [
        { id: 'c_person', name: 'Carol', relationshipScore: 80 },
        { id: 'c_list', name: 'Mailing List', isList: true },
    ];
    const index = buildHybridIndex({ contacts, contactEvidence: {}, sourceEvents: [] });
    assert.equal(index.length, 1);
    assert.equal(index[0].contactRef, safeContactRef('c_person'));
});

test('buildHybridIndex excludes isMailingList contacts', () => {
    const contacts = [
        { id: 'c_person', name: 'Dave', relationshipScore: 80 },
        { id: 'c_mailinglist', name: 'Announcements', isMailingList: true },
    ];
    const index = buildHybridIndex({ contacts, contactEvidence: {}, sourceEvents: [] });
    assert.equal(index.length, 1);
    assert.equal(index[0].contactRef, safeContactRef('c_person'));
});

test('[HybridIndex]: suppressed evidence topics are not indexed', () => {
    const { applyEvidenceOverrides, applyEvidenceOverridesToHybridIndex } = require('../../crm/evidence-review');
    const contacts = [{ id: 'c1', name: 'Alice', relationshipScore: 80 }];
    const filtered = applyEvidenceOverrides({
        contactEvidence: {
            c1: {
                topics: ['ai'],
                sources: ['email'],
                topicEvidence: [{ topic: 'ai', sources: ['email'], count: 1 }],
            },
        },
        overrides: { suppressions: [{ contactRef: safeContactRef('c1'), topic: 'ai', decision: 'suppress' }] },
    });
    const index = buildHybridIndex({ contacts, contactEvidence: filtered, sourceEvents: [] });
    assert.deepEqual(queryHybridIndex('ai', { index }), []);

    const prebuilt = buildHybridIndex({ contacts, contactEvidence: {
        c1: {
            topics: ['ai'],
            sources: ['email'],
            topicEvidence: [{ topic: 'ai', sources: ['email'], count: 1 }],
        },
    }, sourceEvents: [] });
    const filteredIndex = applyEvidenceOverridesToHybridIndex({
        index: prebuilt,
        overrides: { suppressions: [{ contactRef: safeContactRef('c1'), topic: 'ai', decision: 'suppress' }] },
    });
    assert.deepEqual(queryHybridIndex('ai', { index: filteredIndex }), []);
});
