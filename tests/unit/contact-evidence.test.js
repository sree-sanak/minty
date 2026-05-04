'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildContactEvidence, matchContactEvidence } = require('../../crm/contact-evidence');
const { safeContactRef } = require('../../crm/source-events');

describe('contact-evidence: buildContactEvidence()', () => {
    it('builds privacy-safe per-contact topic evidence from personal interactions', () => {
        const contacts = [{ id: 'c_defi', name: 'Dana DeFi' }];
        const interactions = [
            {
                id: 'i_1', contactId: 'c_defi', source: 'telegram', type: 'personal',
                body: 'We discussed DeFi lending protocols, collateral risk, and Aave integrations.',
                timestamp: '2026-05-01T00:00:00Z',
            },
            {
                id: 'i_2', contactId: 'c_defi', source: 'email',
                subject: 'DeFi risk follow-up',
                summary: 'Protocol insurance and decentralized finance underwriting.',
                timestamp: '2026-05-03T00:00:00Z',
            },
        ];

        const evidence = buildContactEvidence({ contacts, interactions });
        assert.ok(evidence[safeContactRef('c_defi')], 'contact has evidence');
        assert.deepEqual(evidence[safeContactRef('c_defi')].sources.sort(), ['email', 'telegram']);
        assert.equal(evidence[safeContactRef('c_defi')].interactionCount, 2);
        assert.equal(evidence[safeContactRef('c_defi')].lastEvidenceAt, '2026-05-03T00:00:00.000Z');
        assert.ok(evidence[safeContactRef('c_defi')].topics.includes('defi'));
        assert.ok(evidence[safeContactRef('c_defi')].topics.includes('lending protocol'));
        assert.ok(evidence[safeContactRef('c_defi')].topics.includes('insurance'));
        assert.equal(JSON.stringify(evidence).includes('Aave integrations'), false, 'must not store raw interaction text');
    });

    it('ignores group interactions and unknown contacts', () => {
        const contacts = [{ id: 'c_person', name: 'Person' }];
        const interactions = [
            { contactId: 'c_person', source: 'telegram', type: 'group', isGroup: true, body: 'DeFi protocol chat' },
            { contactId: 'c_missing', source: 'email', body: 'DeFi lending' },
        ];
        const evidence = buildContactEvidence({ contacts, interactions });
        assert.deepEqual(evidence, {});
    });

    it('does not extract emails, phone numbers, urls, names, or arbitrary raw phrases as topics', () => {
        const evidence = buildContactEvidence({
            contacts: [{ id: 'c_safe', name: 'Safe Contact' }],
            interactions: [{
                contactId: 'c_safe',
                source: 'sms',
                body: 'Met John Smith at Acme Secret Project Orchid. Reach me at private@example.com or +1 555 123 4567. See https://example.com about DeFi custody.',
            }],
        });
        const serialized = JSON.stringify(evidence);
        const forbiddenHost = ['example', 'com'].join('.');
        assert.equal(serialized.includes('private@example.com'), false);
        assert.equal(serialized.includes('555'), false);
        assert.equal(serialized.includes(forbiddenHost), false);
        assert.equal(serialized.toLowerCase().includes('john smith'), false);
        assert.equal(serialized.toLowerCase().includes('project orchid'), false);
        assert.equal(serialized.toLowerCase().includes('acme secret'), false);
        assert.equal(evidence[safeContactRef('c_safe')].topics.includes('defi'), true);
        assert.equal(evidence[safeContactRef('c_safe')].topics.includes('custody'), true);
    });

    it('matches personal chat names when source interactions have no contactId', () => {
        const evidence = buildContactEvidence({
            contacts: [{ id: 'c_chat', name: 'Dana DeFi' }],
            interactions: [{ source: 'telegram', type: 'message', chatName: 'Dana DeFi', body: 'DeFi lending protocol research.' }],
        });
        assert.ok(evidence[safeContactRef('c_chat')]);
        assert.equal(evidence[safeContactRef('c_chat')].sources.includes('telegram'), true);
        assert.equal(evidence[safeContactRef('c_chat')].topics.includes('defi'), true);
    });

    it('matches query terms against precomputed evidence without raw interactions', () => {
        const evidence = buildContactEvidence({
            contacts: [{ id: 'c_defi', name: 'Dana DeFi' }],
            interactions: [{ contactId: 'c_defi', source: 'telegram', body: 'DeFi lending protocols and collateral risk.' }],
        });

        const match = matchContactEvidence(evidence[safeContactRef('c_defi')], ['defi', 'lending protocol']);
        assert.equal(match.matched, true);
        assert.deepEqual(match.sources, ['telegram']);
        assert.ok(match.score >= 30);
        assert.equal(JSON.stringify(match).includes('collateral risk'), false, 'match output must not leak raw text');
    });

    it('ignores non-allowlisted topics in malformed precomputed evidence', () => {
        const match = matchContactEvidence({
            contactId: 'c_bad',
            topics: ['secret project orchid'],
            topicEvidence: [{ topic: 'secret project orchid', count: 9, sources: ['telegram'] }],
            sources: ['telegram'],
            confidence: 1,
        }, ['secret project orchid']);

        assert.equal(match.matched, false);
        assert.equal(JSON.stringify(match).includes('secret project orchid'), false);
    });
});
