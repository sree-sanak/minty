'use strict';
const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildInteractionIndex,
    getContactInteractionStats,
} = require('../../crm/merge');

// Helper: build a minimal contact with specific sources
function mkContact(overrides = {}) {
    return {
        id: 'c1',
        name: 'Test',
        emails: [],
        sources: {},
        ...overrides,
    };
}

let interactionId = 0;

beforeEach(() => {
    interactionId = 0;
});

// Helper: build an interaction
function mkInteraction(overrides = {}) {
    interactionId += 1;
    return {
        id: `i_${interactionId}`,
        source: 'whatsapp',
        timestamp: '2026-01-15T10:00:00.000Z',
        body: 'hello',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// getContactInteractionStats — WhatsApp matching
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: WhatsApp', () => {
    it('matches interactions by WhatsApp chatId', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: '447711111111@c.us' } },
        });
        const interactions = [
            mkInteraction({ chatId: '447711111111@c.us' }),
            mkInteraction({ chatId: '447711111111@c.us', timestamp: '2026-01-16T10:00:00.000Z' }),
            mkInteraction({ chatId: 'other@c.us' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 2);
        assert.deepEqual(stats.activeChannels, ['whatsapp']);
    });

    it('matches interactions by WhatsApp from field', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: '447711111111@c.us' } },
        });
        const interactions = [
            mkInteraction({ from: '447711111111@c.us', chatId: 'group@g.us' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 1);
    });

    it('deduplicates interactions found via both chatId and from', () => {
        const waId = '447711111111@c.us';
        const contact = mkContact({
            sources: { whatsapp: { id: waId } },
        });
        const shared = mkInteraction({ id: 'dup1', chatId: waId, from: waId });
        const interactions = [shared];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 1, 'same interaction should not be double-counted');
    });
});

// ---------------------------------------------------------------------------
// getContactInteractionStats — LinkedIn matching
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: LinkedIn', () => {
    it('matches interactions by LinkedIn name', () => {
        const contact = mkContact({
            sources: { linkedin: { name: 'Jane Doe' } },
        });
        const interactions = [
            mkInteraction({ source: 'linkedin', chatName: 'Jane Doe', id: 'li1' }),
            mkInteraction({ source: 'linkedin', chatName: 'Bob, Jane Doe', id: 'li2' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 2);
        assert.deepEqual(stats.activeChannels, ['linkedin']);
    });

    it('skips LinkedIn match when name is missing', () => {
        const contact = mkContact({
            sources: { linkedin: { company: 'Acme' } }, // no name
        });
        const interactions = [
            mkInteraction({ source: 'linkedin', chatName: 'Anyone' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 0);
    });
});

// ---------------------------------------------------------------------------
// getContactInteractionStats — Email matching
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: Email', () => {
    it('matches interactions by email address', () => {
        const contact = mkContact({
            emails: ['jane@example.com'],
        });
        const interactions = [
            mkInteraction({ source: 'email', from: 'jane@example.com', to: ['bob@co.com'], id: 'e1' }),
            mkInteraction({ source: 'email', from: 'bob@co.com', to: ['jane@example.com'], id: 'e2' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 2);
        assert.deepEqual(stats.activeChannels, ['email']);
    });

    it('handles multiple email addresses', () => {
        const contact = mkContact({
            emails: ['jane@work.com', 'jane@personal.com'],
        });
        const interactions = [
            mkInteraction({ source: 'email', from: 'jane@work.com', to: ['x@x.com'], id: 'e1' }),
            mkInteraction({ source: 'email', from: 'jane@personal.com', to: ['x@x.com'], id: 'e2' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 2);
    });
});

// ---------------------------------------------------------------------------
// getContactInteractionStats — SMS matching
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: SMS', () => {
    it('matches interactions by SMS phone as chatId', () => {
        const contact = mkContact({
            sources: { sms: { phone: '+14155551234' } },
        });
        const interactions = [
            mkInteraction({ source: 'sms', chatId: '+14155551234', id: 's1' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 1);
        assert.deepEqual(stats.activeChannels, ['sms']);
    });
});

// ---------------------------------------------------------------------------
// getContactInteractionStats — Telegram matching
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: Telegram', () => {
    it('matches interactions by Telegram userId as chatId', () => {
        const contact = mkContact({
            sources: { telegram: { userId: 123456 } },
        });
        const interactions = [
            mkInteraction({ source: 'telegram', chatId: '123456', id: 't1' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 1);
        assert.deepEqual(stats.activeChannels, ['telegram']);
    });
});

// ---------------------------------------------------------------------------
// getContactInteractionStats — cross-channel & timestamps
// ---------------------------------------------------------------------------

describe('getContactInteractionStats: cross-channel', () => {
    it('aggregates interactions from multiple channels', () => {
        const contact = mkContact({
            emails: ['jane@co.com'],
            sources: {
                whatsapp: { id: '447700000000@c.us' },
                linkedin: { name: 'Jane Smith' },
            },
        });
        const interactions = [
            mkInteraction({ source: 'whatsapp', chatId: '447700000000@c.us', id: 'w1', timestamp: '2026-01-10T00:00:00Z' }),
            mkInteraction({ source: 'linkedin', chatName: 'Jane Smith', id: 'l1', timestamp: '2026-01-12T00:00:00Z' }),
            mkInteraction({ source: 'email', from: 'jane@co.com', to: ['x@x.com'], id: 'e1', timestamp: '2026-01-14T00:00:00Z' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 3);
        assert.equal(stats.activeChannels.length, 3);
        assert.ok(stats.activeChannels.includes('whatsapp'));
        assert.ok(stats.activeChannels.includes('linkedin'));
        assert.ok(stats.activeChannels.includes('email'));
    });

    it('returns the most recent timestamp as lastContactedAt', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: 'wa1@c.us' } },
        });
        const interactions = [
            mkInteraction({ chatId: 'wa1@c.us', id: 'i1', timestamp: '2026-01-10T00:00:00.000Z' }),
            mkInteraction({ chatId: 'wa1@c.us', id: 'i2', timestamp: '2026-03-20T12:00:00.000Z' }),
            mkInteraction({ chatId: 'wa1@c.us', id: 'i3', timestamp: '2026-02-15T06:00:00.000Z' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.lastContactedAt, '2026-03-20T12:00:00.000Z');
    });

    it('returns null lastContactedAt when no timestamps present', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: 'wa1@c.us' } },
        });
        const interactions = [
            mkInteraction({ chatId: 'wa1@c.us', id: 'i1', timestamp: undefined }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.lastContactedAt, null);
    });

    it('ignores invalid timestamps', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: 'wa1@c.us' } },
        });
        const interactions = [
            mkInteraction({ chatId: 'wa1@c.us', id: 'i1', timestamp: 'not-a-date' }),
            mkInteraction({ chatId: 'wa1@c.us', id: 'i2', timestamp: '2026-01-10T00:00:00.000Z' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.lastContactedAt, '2026-01-10T00:00:00.000Z');
    });
});

describe('getContactInteractionStats: empty', () => {
    it('returns zeros for contact with no matching interactions', () => {
        const contact = mkContact({
            sources: { whatsapp: { id: 'nobody@c.us' } },
        });
        const idx = buildInteractionIndex([]);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 0);
        assert.equal(stats.lastContactedAt, null);
        assert.deepEqual(stats.activeChannels, []);
    });

    it('returns zeros for contact with no source identifiers', () => {
        const contact = mkContact(); // no sources, no emails
        const interactions = [
            mkInteraction({ chatId: 'someone@c.us' }),
        ];
        const idx = buildInteractionIndex(interactions);
        const stats = getContactInteractionStats(contact, idx);
        assert.equal(stats.interactionCount, 0);
    });
});
