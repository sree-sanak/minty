'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    asId,
    entityName,
    toIsoDate,
    telegramQrLoginUrl,
    normalizeContact,
    normalizeMessage,
    normalizeDialog,
    fetchContacts,
    shouldIncludeDialog,
} = require('../../sources/telegram/live');

test('[telegram-live] asId normalizes bigint and nested ids', () => {
    assert.equal(asId(123n), '123');
    assert.equal(asId({ value: 456n }), '456');
    assert.equal(asId(null), null);
});

test('[telegram-live] entityName prefers person name, then title, then username', () => {
    assert.equal(entityName({ firstName: 'Ada', lastName: 'Lovelace', username: 'ada' }), 'Ada Lovelace');
    assert.equal(entityName({ title: 'DeFi chat', username: 'defi' }), 'DeFi chat');
    assert.equal(entityName({ username: 'defi' }), 'defi');
});

test('[telegram-live] toIsoDate handles Telegram unix seconds', () => {
    assert.equal(toIsoDate(1735689600), '2025-01-01T00:00:00.000Z');
    assert.equal(toIsoDate('not-a-date'), null);
});

test('[telegram-live] telegramQrLoginUrl uses Telegram base64url token format', () => {
    assert.equal(telegramQrLoginUrl(Buffer.from([251, 255, 238])), 'tg://login?token=-__u');
});

test('[telegram-live] normalizeContact preserves userId and username for attribution', () => {
    const contact = normalizeContact({
        id: 123n,
        accessHash: 999n,
        firstName: 'Alice',
        lastName: 'Protocol',
        username: 'alicep',
        phone: '+15551234567',
        mutualContact: true,
    });
    assert.equal(contact.name, 'Alice Protocol');
    assert.equal(contact.userId, '123');
    assert.equal(contact.accessHash, '999');
    assert.equal(contact.username, 'alicep');
    assert.equal(contact.sourceMode, 'live');
});

test('[telegram-live] normalizeMessage keeps sender id and text without raw dependency objects', () => {
    const msg = normalizeMessage({
        id: 7,
        date: 1735689600,
        out: false,
        senderId: 123n,
        message: 'hello',
        media: { className: 'MessageMediaPhoto' },
        replyTo: { replyToMsgId: 6 },
        fwdFrom: {},
    });
    assert.deepEqual(msg, {
        id: '7',
        timestamp: '2025-01-01T00:00:00.000Z',
        from: null,
        fromId: '123',
        body: 'hello',
        type: 'message',
        mediaType: 'MessageMediaPhoto',
        replyToId: '6',
        forwarded: true,
    });
});

test('[telegram-live] normalizeDialog emits import-compatible chat shape', () => {
    const chat = normalizeDialog({
        id: 99,
        name: 'Alice Protocol',
        entity: { id: 123n, accessHash: 555n, username: 'alicep', firstName: 'Alice', lastName: 'Protocol', className: 'User' },
    }, [{ id: 1, date: 1735689600, message: 'hi' }]);
    assert.equal(chat.id, '123');
    assert.equal(chat.accessHash, '555');
    assert.equal(chat.username, 'alicep');
    assert.equal(chat.name, 'Alice Protocol');
    assert.equal(chat.type, 'User');
    assert.equal(chat.sourceMode, 'live');
    assert.equal(chat.messages.length, 1);
});

test('[telegram-live] shouldIncludeDialog includes group chats by default for network memory', () => {
    assert.equal(shouldIncludeDialog({ isGroup: true }), true);
    assert.equal(shouldIncludeDialog({ isGroup: false }), true);
});

test('[telegram-live] shouldIncludeDialog can explicitly exclude group chats', () => {
    assert.equal(shouldIncludeDialog({ isGroup: true }, { includeGroups: false }), false);
    assert.equal(shouldIncludeDialog({ isGroup: false }, { includeGroups: false }), true);
});

test('[telegram-live] fetchContacts falls back to GramJS contacts.GetContacts', async () => {
    class GetContacts {
        constructor(args) { this.args = args; }
    }
    const client = {
        async invoke(request) {
            assert.ok(request instanceof GetContacts);
            assert.equal(request.args.hash, 0);
            return { users: [{ id: 123n, firstName: 'Alice' }] };
        },
    };
    const users = await fetchContacts(client, { contacts: { GetContacts } });
    assert.equal(users.length, 1);
    assert.equal(users[0].firstName, 'Alice');
});
