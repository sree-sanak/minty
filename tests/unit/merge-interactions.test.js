/**
 * tests/unit/merge-interactions.test.js — unit tests for buildInteractions
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function setupFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-interactions-'));
    const dataDir = path.join(tmp, 'data');
    // source subdirs
    for (const d of ['whatsapp', 'telegram', 'linkedin', 'email', 'sms', 'slack']) {
        fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    }
    return { tmp, dataDir };
}

function buildInteractionsWithEnv(dataDir) {
    const modulePath = require.resolve('../../crm/merge');
    delete require.cache[modulePath];
    const prev = process.env.CRM_DATA_DIR;
    process.env.CRM_DATA_DIR = dataDir;
    try {
        const { buildInteractions } = require('../../crm/merge');
        return buildInteractions();
    } finally {
        if (prev === undefined) delete process.env.CRM_DATA_DIR;
        else process.env.CRM_DATA_DIR = prev;
    }
}

// ---------------------------------------------------------------------------
// WhatsApp

test('[WA Interactions]: 1:1 chat messages get correct from field', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'whatsapp/chats.json'), JSON.stringify({
        'Alice Smith': {
            meta: { id: '447111111111@c.us', isGroup: false },
            messages: [
                { id: 'm1', from: 'me',        timestamp: '2024-01-01T10:00:00Z', body: 'Hi Alice' },
                { id: 'm2', from: '447111111111@c.us', timestamp: '2024-01-01T10:01:00Z', body: 'Hey!' },
            ],
        },
    }));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 2);
    // 1:1 — m.from is counterparty; m.author is undefined
    assert.equal(interactions[0].from, 'me');
    assert.equal(interactions[0].source, 'whatsapp');
    assert.equal(interactions[0].body, 'Hi Alice');
    assert.equal(interactions[1].from, '447111111111@c.us');
    assert.equal(interactions[1].body, 'Hey!');
});

test('[WA Interactions]: group chat messages prefer author over from', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'whatsapp/chats.json'), JSON.stringify({
        'Founders': {
            meta: { id: 'group1@g.us', name: 'Founders', isGroup: true },
            messages: [
                { id: 'm1', from: 'group1@g.us', author: '447111111111@c.us', timestamp: '2024-01-02T10:00:00Z', body: 'Hello group' },
                { id: 'm2', from: 'group1@g.us', author: '447222222222@c.us', timestamp: '2024-01-02T10:01:00Z', body: 'Nice!' },
            ],
        },
    }));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 2);
    // For groups, realFrom = m.author (not m.from = group id)
    assert.equal(interactions[0].from, '447111111111@c.us');
    assert.equal(interactions[1].from, '447222222222@c.us');
    // chatId should be set to the group id
    assert.equal(interactions[0].chatId, 'group1@g.us');
    assert.equal(interactions[0].chatName, 'Founders');
});

test('[WA Interactions]: missing chats.json is gracefully skipped', () => {
    const { dataDir } = setupFixture();
    // No chats.json — should not throw
    const interactions = buildInteractionsWithEnv(dataDir);
    assert.deepEqual(interactions, []);
});

// ---------------------------------------------------------------------------
// Telegram

test('[TG Interactions]: telegram messages get correct fields', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'telegram/chats.json'), JSON.stringify([
        {
            id: 'tg_chat_1',
            name: 'TG Chat',
            messages: [
                { id: 'tg1', from: 'Bob', timestamp: '2024-02-01T12:00:00Z', body: 'Telegram message' },
            ],
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].source, 'telegram');
    assert.equal(interactions[0].from, 'Bob');
    assert.equal(interactions[0].chatName, 'TG Chat');
    assert.equal(interactions[0].chatId, 'tg_chat_1');
});

// ---------------------------------------------------------------------------
// LinkedIn

test('[LI Interactions]: linkedin messages get correct fields', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'linkedin/messages.json'), JSON.stringify([
        {
            id: 'li_conv_1',
            participants: ['Sree K', 'Jane Doe'],
            messages: [
                { id: 'li1', timestamp: '2024-03-01T09:00:00Z', body: 'Loved your post!' },
            ],
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].source, 'linkedin');
    assert.equal(interactions[0].chatId, 'li_conv_1');
    assert.equal(interactions[0].chatName, 'Sree K, Jane Doe');
});

// ---------------------------------------------------------------------------
// Email

test('[Email Interactions]: email messages get correct fields', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'email/messages.json'), JSON.stringify([
        {
            id: 'email1',
            timestamp: '2024-04-01T08:00:00Z',
            from: 'alice@example.com',
            to: 'sree@example.com',
            subject: 'Hello',
            body: 'Email body',
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].source, 'email');
    assert.equal(interactions[0].from, 'alice@example.com');
    assert.equal(interactions[0].subject, 'Hello');
    assert.equal(interactions[0].body, 'Email body');
});

// ---------------------------------------------------------------------------
// SMS

test('[SMS Interactions]: sms messages get correct direction and fields', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'sms/messages.json'), JSON.stringify([
        {
            phone: '+447111111111',
            contactName: 'Bob',
            messages: [
                { direction: 'received',  timestamp: '2024-05-01T14:00:00Z', body: 'SMS received' },
                { direction: 'sent',      timestamp: '2024-05-01T14:05:00Z', body: 'SMS sent' },
            ],
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 2);
    // received -> from is the phone number
    assert.equal(interactions[0].from, '+447111111111');
    assert.equal(interactions[0].to, 'me');
    // sent -> from is 'me'
    assert.equal(interactions[1].from, 'me');
    assert.equal(interactions[1].to, '+447111111111');
    assert.equal(interactions[0].chatName, 'Bob');
    assert.equal(interactions[0].source, 'sms');
});

// ---------------------------------------------------------------------------
// Slack

test('[Slack Interactions]: slack channel messages retain author id but expose only safe source fields', () => {
    const { dataDir } = setupFixture();
    fs.mkdirSync(path.join(dataDir, 'slack/messages'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'slack/messages/messages.json'), JSON.stringify([
        {
            id: 'slack1',
            ts: '1714564800.000000',
            timestamp: '2024-05-01T12:00:00Z',
            user: 'U123',
            text: 'Building AI startup infrastructure.',
            channelId: 'C123',
            channelName: 'private-channel-name',
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].source, 'slack');
    assert.equal(interactions[0].from, 'U123');
    assert.equal(interactions[0].chatId, 'C123');
    assert.equal(interactions[0].type, 'channel');
    assert.equal(interactions[0].body, 'Building AI startup infrastructure.');
});

// ---------------------------------------------------------------------------
// Cross-source chronological sorting

test('[Sorting]: interactions sorted chronologically across all sources', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'whatsapp/chats.json'), JSON.stringify({
        'WA Chat': {
            meta: { id: 'wa1@c.us', isGroup: false },
            messages: [
                { id: 'wa1', from: '447111111111@c.us', timestamp: '2024-06-01T10:00:00Z', body: 'WA msg' },
            ],
        },
    }));
    fs.writeFileSync(path.join(dataDir, 'email/messages.json'), JSON.stringify([
        { id: 'email1', timestamp: '2024-06-01T08:00:00Z', from: 'a@b.com', body: 'Earlier email' },
    ]));
    fs.writeFileSync(path.join(dataDir, 'telegram/chats.json'), JSON.stringify([
        {
            id: 'tg1', name: 'TG',
            messages: [
                { id: 'tg1', from: 'tg_user', timestamp: '2024-06-01T12:00:00Z', body: 'Later TG' },
            ],
        },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 3);
    // Must be sorted oldest → newest
    assert.equal(interactions[0].source, 'email');
    assert.equal(interactions[0].body, 'Earlier email');
    assert.equal(interactions[1].source, 'whatsapp');
    assert.equal(interactions[1].body, 'WA msg');
    assert.equal(interactions[2].source, 'telegram');
    assert.equal(interactions[2].body, 'Later TG');
});

test('[Sorting]: missing timestamps sink to the end', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'email/messages.json'), JSON.stringify([
        { id: 'with_ts', timestamp: '2024-07-01T10:00:00Z', from: 'a@b.com', body: 'With timestamp' },
        { id: 'no_ts',   from: 'a@b.com', body: 'No timestamp' },
    ]));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 2);
    assert.equal(interactions[0].body, 'With timestamp');
    assert.equal(interactions[1].body, 'No timestamp');
});

// ---------------------------------------------------------------------------
// Schema contract

test('[Schema]: every interaction has required fields', () => {
    const { dataDir } = setupFixture();
    fs.writeFileSync(path.join(dataDir, 'whatsapp/chats.json'), JSON.stringify({
        'Test': {
            meta: { id: 'test@c.us', isGroup: false },
            messages: [
                { id: 'm1', timestamp: '2024-08-01T10:00:00Z', body: 'Test' },
            ],
        },
    }));

    const interactions = buildInteractionsWithEnv(dataDir);

    assert.equal(interactions.length, 1);
    const i = interactions[0];
    assert.equal(typeof i.source, 'string');
    assert.ok(['whatsapp', 'telegram', 'linkedin', 'email', 'sms', 'slack'].includes(i.source));
    assert.ok(i.timestamp !== undefined);
    assert.ok(i.raw !== undefined);
});
