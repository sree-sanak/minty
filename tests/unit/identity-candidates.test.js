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
    assert.equal(JSON.stringify(candidates).includes('alice@example.com'), false);
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
