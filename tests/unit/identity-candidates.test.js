'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { proposeIdentityCandidates } = require('../../crm/identity-candidates');

test('proposes exact source/email/phone candidates as auto-merge eligible', () => {
    const contacts = [
        { id: 'a', name: 'Alice A', emails: ['alice@example.com'], sources: { telegram: { userId: '1' } } },
        { id: 'b', name: 'Alice B', emails: ['ALICE@example.com'], sources: { linkedin: { id: 'li1' } } },
    ];

    const candidates = proposeIdentityCandidates(contacts);

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].contactIds, ['a', 'b']);
    assert.equal(candidates[0].decision, 'auto_exact');
    assert.equal(candidates[0].requiresReview, false);
    assert.equal(candidates[0].score, 100);
    assert.deepEqual(candidates[0].reasons, [{ kind: 'exact_email', detail: 'Exact private identifier match; identifier omitted.' }]);
    assert.equal(JSON.stringify(candidates).includes('alice@example.com'), false);
});

test('proposes pairwise exact email candidates for clusters with three people', () => {
    const contacts = [
        { id: 'a', name: 'Ada One', emails: ['ada-cluster@example.test'] },
        { id: 'b', name: 'Ada Two', emails: ['ADA-CLUSTER@example.test'] },
        { id: 'c', name: 'Ada Three', emails: [' ada-cluster@example.test '] },
    ];

    const candidates = proposeIdentityCandidates(contacts);

    assert.deepEqual(candidates.map(c => c.contactIds), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
    for (const candidate of candidates) {
        assert.equal(candidate.decision, 'auto_exact');
        assert.equal(candidate.requiresReview, false);
        assert.equal(candidate.score, 100);
        assert.deepEqual(candidate.reasons, [{ kind: 'exact_email', detail: 'Exact private identifier match; identifier omitted.' }]);
    }
    const serialized = JSON.stringify(candidates).toLowerCase();
    assert.equal(serialized.includes('ada-cluster@example.test'), false);
});

test('proposes pairwise exact phone candidates for clusters with three people without leaking the phone', () => {
    const contacts = [
        { id: 'a', name: 'Phone One', phones: ['+1 (555) 010-4242'] },
        { id: 'b', name: 'Phone Two', phone: '15550104242' },
        { id: 'c', name: 'Phone Three', sources: { whatsapp: { phone: '+1-555-010-4242' } } },
    ];

    const candidates = proposeIdentityCandidates(contacts);

    assert.deepEqual(candidates.map(c => c.contactIds), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
    for (const candidate of candidates) {
        assert.equal(candidate.decision, 'auto_exact');
        assert.equal(candidate.requiresReview, false);
        assert.equal(candidate.score, 100);
        assert.deepEqual(candidate.reasons, [{ kind: 'exact_phone', detail: 'Exact private identifier match; identifier omitted.' }]);
    }
    const serialized = JSON.stringify(candidates);
    assert.equal(serialized.includes('15550104242'), false);
    assert.equal(serialized.includes('5550104242'), false);
});

test('proposes pairwise exact source-id candidates for clusters with three people without leaking source ids', () => {
    const contacts = [
        { id: 'a', name: 'Source One', sources: { slack: { userId: 'UCLUSTER123' } } },
        { id: 'b', name: 'Source Two', sources: { slack: { id: 'UCLUSTER123' } } },
        { id: 'c', name: 'Source Three', sources: { slack: { handle: 'UCLUSTER123' } } },
    ];

    const candidates = proposeIdentityCandidates(contacts);

    assert.deepEqual(candidates.map(c => c.contactIds), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
    for (const candidate of candidates) {
        assert.equal(candidate.decision, 'auto_exact');
        assert.equal(candidate.requiresReview, false);
        assert.equal(candidate.score, 100);
        assert.deepEqual(candidate.reasons, [{ kind: 'exact_source_id', detail: 'Exact private identifier match; identifier omitted.' }]);
    }
    const serialized = JSON.stringify(candidates).toLowerCase();
    assert.equal(serialized.includes('ucluster123'), false);
    assert.equal(serialized.includes('slack:ucluster123'), false);
});

test('keeps fuzzy name/company matches as review-only candidates', () => {
    const contacts = [
        { id: 'a', name: 'Alice Example', company: 'Mintara Labs', title: 'Founder' },
        { id: 'b', name: 'Alicia Example', company: 'Mintara', title: 'CEO' },
    ];

    const candidates = proposeIdentityCandidates(contacts);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'possible');
    assert.equal(candidates[0].requiresReview, true);
    assert.equal(candidates[0].reasons.some(r => r.kind === 'name_similarity'), true);
});

test('does not propose group contacts or first-name-only weak guesses', () => {
    const contacts = [
        { id: 'a', name: 'Alice', company: 'One' },
        { id: 'b', name: 'Alice', company: 'Two' },
        { id: 'g', name: 'Alice Group', isGroup: true, company: 'One' },
    ];

    assert.deepEqual(proposeIdentityCandidates(contacts), []);
});

test('does not propose channel, broadcast, or mailing-list contacts as people', () => {
    const contacts = [
        { id: 'person', name: 'Morgan Founder', emails: ['morgan@example.test'], company: 'Mintara Labs' },
        { id: 'channel', name: 'Morgan Founder', emails: ['morgan@example.test'], company: 'Mintara Labs', isChannel: true },
        { id: 'broadcast', name: 'Morgan Founder', phone: '+15550001111', isBroadcast: true },
        { id: 'list', name: 'Morgan Founder', sources: { email: { email: 'morgan@example.test' } }, type: 'mailing_list' },
        { id: 'nested', name: 'Morgan Founder', sources: { whatsapp: { chatType: 'channel', id: 'minty-newsletter@newsletter' } } },
        { id: 'jid', name: 'Morgan Founder', company: 'Mintara Labs', jid: 'minty@g.us' },
        { id: 'slack-channel', name: 'Morgan Founder', company: 'Mintara Labs', sources: { slack: { source: 'slack', channelId: 'C123TEAM' } } },
    ];

    assert.deepEqual(proposeIdentityCandidates(contacts), []);
});
