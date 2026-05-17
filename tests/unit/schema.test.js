'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createContact, createInteraction } = require('../../crm/schema');

// ---------------------------------------------------------------------------
// createContact
// ---------------------------------------------------------------------------

test('createContact: returns correct shape with given id', () => {
    const c = createContact('c_001');
    assert.equal(c.id, 'c_001');
    assert.equal(c.name, null);
    assert.deepEqual(c.phones, []);
    assert.deepEqual(c.emails, []);
    assert.equal(c.notes, null);
    assert.deepEqual(c.tags, []);
    assert.equal(c.lastContactedAt, null);
    assert.ok(c.createdAt);
    assert.ok(c.updatedAt);
});

test('createContact: sources object has all expected keys', () => {
    const c = createContact('c_002');
    const expected = ['whatsapp', 'linkedin', 'telegram', 'email', 'googleContacts', 'sms'];
    for (const key of expected) {
        assert.ok(Object.prototype.hasOwnProperty.call(c.sources, key), `missing sources.${key}`);
        assert.equal(c.sources[key], null);
    }
});

test('createContact: different ids produce distinct objects', () => {
    const a = createContact('c_001');
    const b = createContact('c_002');
    a.phones.push('+447911111111');
    assert.deepEqual(b.phones, [], 'phones arrays must not be shared');
});

test('createContact: createdAt is a valid ISO string', () => {
    const c = createContact('c_test');
    assert.doesNotThrow(() => new Date(c.createdAt));
    assert.ok(!isNaN(new Date(c.createdAt)));
});

// ---------------------------------------------------------------------------
// createInteraction
// ---------------------------------------------------------------------------

test('createInteraction: maps body field correctly', () => {
    const i = createInteraction('whatsapp', { body: 'Hello!', timestamp: '2026-01-01T00:00:00Z' });
    assert.equal(i.source, 'whatsapp');
    assert.equal(i.body, 'Hello!');
    assert.equal(i.timestamp, '2026-01-01T00:00:00Z');
});

test('createInteraction: falls back to text then content for body', () => {
    const fromText    = createInteraction('telegram', { text: 'via text' });
    const fromContent = createInteraction('email',    { content: 'via content' });
    assert.equal(fromText.body, 'via text');
    assert.equal(fromContent.body, 'via content');
});

test('createInteraction: maps chatId and chatName', () => {
    const i = createInteraction('whatsapp', {
        chatId: '447911@c.us',
        chatName: 'Alice',
        body: 'test',
    });
    assert.equal(i.chatId, '447911@c.us');
    assert.equal(i.chatName, 'Alice');
});

test('createInteraction: falls back to conversationId when chatId missing', () => {
    const i = createInteraction('linkedin', { conversationId: 'li_conv_1', body: 'hey' });
    assert.equal(i.chatId, 'li_conv_1');
});

test('createInteraction: type defaults to message', () => {
    const i = createInteraction('sms', { body: 'hi' });
    assert.equal(i.type, 'message');
});

test('createInteraction: preserves raw object', () => {
    const raw = { body: 'hi', extra: 'data' };
    const i = createInteraction('sms', raw);
    assert.equal(i.raw, raw);
});

test('createInteraction: defaults safe timeline metadata to an empty object', () => {
    const i = createInteraction('sms', { body: 'hi' });
    assert.deepEqual(i.metadata, {});
});

test('createInteraction: derives safe attachment, link preview, and reaction cues from structured fields', () => {
    const i = createInteraction('linkedin', {
        body: 'structured metadata only',
        hasAttachment: true,
        linkPreviews: [
            { url: 'private-example.test/sensitive/path', title: 'Private Launch Plan' },
            { url: 'private-example.test/another/path', title: 'Private Board Deck' },
        ],
        reactions: [
            { profileUrl: 'private-profile.example/sam', name: 'Private Person' },
            { sourceId: 'raw-provider-user-123', emoji: '👍' },
            { email: 'timeline-private@example.test', type: 'like' },
        ],
        attachmentName: 'private-roadmap.pdf',
        fileName: 'private-financials.xlsx',
        providerId: 'raw-provider-message-456',
        localPath: '/private/minty/source export/private-roadmap.pdf',
        phone: '+1 415 555 0199',
        api_key: 'timeline-api-key-sentinel',
    });

    assert.deepEqual(i.metadata, {
        hasAttachment: true,
        linkPreviewCount: 2,
        reactionCount: 3,
    });
    const metadataText = JSON.stringify(i.metadata);
    assert.doesNotMatch(metadataText, /private-example|Private Launch|raw-provider|timeline-private|private-roadmap|private-financials|private\/minty|415 555 0199|timeline-api-key/);
});
