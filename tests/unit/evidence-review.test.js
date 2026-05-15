'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { safeContactRef } = require('../../crm/source-events');
const {
    buildEvidenceReviewRows,
    applyEvidenceOverrides,
    updateEvidenceOverride,
} = require('../../crm/evidence-review');

test('[EvidenceReview]: builds redacted topic review rows', () => {
    const rows = buildEvidenceReviewRows({
        contacts: [{
            id: 'c_private',
            name: 'Alice Private',
            emails: ['alice@example.com'],
            phones: ['+15550120123'],
            sources: { telegram: { id: 'secret-chat-id', name: 'Secret Group' } },
        }],
        contactEvidence: {
            c_private: {
                topics: ['defi'],
                sources: ['telegram'],
                evidenceCount: 3,
                latestAt: '2026-05-06T10:00:00.000Z',
                confidence: 0.8,
                topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 3, confidence: 0.8, latestAt: '2026-05-06T10:00:00.000Z' }],
            },
        },
    });

    assert.equal(rows.status, 'ok');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].contactRef, safeContactRef('c_private'));
    assert.equal(rows.rows[0].contactName, 'Alice Private');
    assert.equal(rows.rows[0].topic, 'defi');
    assert.deepEqual(rows.rows[0].sources, ['telegram']);
    assert.equal(rows.rows[0].evidenceCount, 3);
    assert.equal(rows.rows[0].decision, 'active');

    const serialized = JSON.stringify(rows);
    for (const forbidden of ['c_private', 'alice@example.com', '+15550120123', 'secret-chat-id', 'Secret Group']) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});

test('[EvidenceReview]: marks suppressed rows and omits non-person contacts', () => {
    const contactRef = safeContactRef('c1');
    const rows = buildEvidenceReviewRows({
        contacts: [
            { id: 'c1', name: 'Bob' },
            { id: 'g1', name: 'Group Chat', isGroup: true },
            { id: 'channel1', name: 'Announcements', isChannel: true },
            { id: 'broadcast1', name: 'Broadcast', isBroadcast: true },
        ],
        contactEvidence: {
            c1: { topics: ['ai'], sources: ['email'], topicEvidence: [{ topic: 'ai', sources: ['email'], count: 1 }] },
            g1: { topics: ['ai'], sources: ['whatsapp'], topicEvidence: [{ topic: 'ai', sources: ['whatsapp'], count: 9 }] },
            channel1: { topics: ['ai'], sources: ['telegram'], topicEvidence: [{ topic: 'ai', sources: ['telegram'], count: 9 }] },
            broadcast1: { topics: ['ai'], sources: ['sms'], topicEvidence: [{ topic: 'ai', sources: ['sms'], count: 9 }] },
        },
        overrides: { suppressions: [{ contactRef, topic: 'ai', decision: 'suppress', reviewedAt: '2026-05-06T11:00:00.000Z' }] },
    });

    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].decision, 'suppressed');
    assert.equal(rows.rows[0].reviewedAt, '2026-05-06T11:00:00.000Z');
    assert.equal(JSON.stringify(rows).includes('Group Chat'), false);
    assert.equal(JSON.stringify(rows).includes('Announcements'), false);
});

test('[EvidenceReview]: applyEvidenceOverrides removes suppressed topics only', () => {
    const out = applyEvidenceOverrides({
        contactEvidence: {
            c1: {
                topics: ['ai', 'defi'],
                sources: ['email', 'telegram'],
                evidenceCount: 4,
                topicEvidence: [
                    { topic: 'ai', sources: ['email'], count: 1 },
                    { topic: 'defi', sources: ['telegram'], count: 3 },
                ],
            },
        },
        overrides: { suppressions: [{ contactRef: safeContactRef('c1'), topic: 'ai', decision: 'suppress' }] },
    });

    assert.deepEqual(out.c1.topics, ['defi']);
    assert.deepEqual(out.c1.topicEvidence.map(r => r.topic), ['defi']);
    assert.deepEqual(out.c1.sources, ['telegram']);
    assert.equal(out.c1.evidenceCount, 3);
});

test('[EvidenceReview]: updateEvidenceOverride validates opaque refs and allowlisted topics', () => {
    const reviewedAt = '2026-05-06T12:00:00.000Z';
    const contactRef = safeContactRef('c1');
    const suppressed = updateEvidenceOverride({ overrides: {}, contactRef, topic: 'ai', decision: 'suppress', now: reviewedAt });
    assert.deepEqual(suppressed.suppressions, [{ contactRef, topic: 'ai', decision: 'suppress', reviewedAt }]);

    const restored = updateEvidenceOverride({ overrides: suppressed, contactRef, topic: 'ai', decision: 'restore', now: reviewedAt });
    assert.deepEqual(restored.suppressions, []);

    assert.throws(() => updateEvidenceOverride({ overrides: {}, contactRef: 'c1', topic: 'ai', decision: 'suppress', now: reviewedAt }), /invalid contactRef/);
    assert.throws(() => updateEvidenceOverride({ overrides: {}, contactRef, topic: 'private codename', decision: 'suppress', now: reviewedAt }), /invalid topic/);
    assert.throws(() => updateEvidenceOverride({ overrides: {}, contactRef, topic: 'ai', decision: 'delete', now: reviewedAt }), /invalid decision/);
});
