'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeIMessageExport,
    safeIMessageContactRef,
    runIMessageImport,
} = require('../../sources/imessage/import');
const { buildInteractions, loadIMessage } = require('../../crm/merge');
const { ContactIndex } = require('../../crm/utils');

const fixture = {
    selfHandles: ['RAW_SELF_HANDLE'],
    handles: [
        { id: 'RAW_SELF_HANDLE', value: '+15550101010', displayName: 'Fixture Self' },
        { id: 'RAW_ADA_HANDLE', value: '+15550101111', displayName: 'Ada Example' },
        { id: 'RAW_GRACE_HANDLE', value: 'grace@example.test', displayName: 'Grace Example /root/grace token abc123' },
    ],
    chats: [
        {
            id: 'RAW_CHAT_DIRECT',
            type: 'direct',
            participants: ['RAW_SELF_HANDLE', 'RAW_ADA_HANDLE'],
            messages: [
                { id: 'RAW_MSG_1', handleId: 'RAW_SELF_HANDLE', timestamp: '2026-05-15T12:41:00Z', text: 'Thanks — no token needed.' },
                { id: 'RAW_MSG_2', handleId: 'RAW_ADA_HANDLE', timestamp: '2026-05-15T12:40:00Z', text: 'Discussed local relationship memory via ada@example.test at https://private.example/path and /Users/sree/Library/Messages. token abc123' },
                { id: 'RAW_MSG_BAD', handleId: 'RAW_ADA_HANDLE', timestamp: '2026-02-30T12:40:00Z', text: 'bad timestamp should skip' },
            ],
        },
        {
            id: 'RAW_CHAT_GROUP',
            type: 'group',
            participants: ['RAW_SELF_HANDLE', 'RAW_ADA_HANDLE', 'RAW_GRACE_HANDLE'],
            messages: [
                { id: 'RAW_MSG_3', from: 'RAW_GRACE_HANDLE', timestamp: '2026-05-16T09:00:00Z', body: 'Warm intro path came from iMessage group. api_key="raw-api-secret"' },
            ],
        },
    ],
};

test('[IMessageImport] normalizes local direct and small-group exports with diagnostics', () => {
    const result = normalizeIMessageExport(fixture);

    assert.equal(result.contacts.length, 2);
    assert.deepEqual(result.contacts.map(c => c.name).sort(), ['Ada Example', 'Grace Example [path] [redacted-secret]']);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.diagnostics, {
        skippedChats: 0,
        skippedMessages: 1,
        skippedParticipants: 0,
    });

    const dm = result.conversations.find(chat => chat.type === 'direct');
    assert.equal(dm.chatName, 'iMessage conversation');
    assert.equal(dm.messages[0].from, 'me');
    assert.equal(dm.messages[0].to, safeIMessageContactRef('RAW_ADA_HANDLE'));
    assert.equal(dm.messages[1].from, safeIMessageContactRef('RAW_ADA_HANDLE'));
    assert.equal(dm.messages[1].to, 'me');
    assert.equal(dm.messages[1].timestamp, '2026-05-15T12:40:00.000Z');
    assert.equal(dm.messages[1].body, 'Discussed local relationship memory via [email] at [url] and [path] [redacted-secret]');

    const group = result.conversations.find(chat => chat.type === 'group');
    assert.equal(group.chatName, 'iMessage direct group');
    assert.equal(group.participantRefs.length, 2);
});

test('[IMessageImport] serialized normalized output omits raw identifiers, contact details, paths, URLs, and secrets', () => {
    const result = normalizeIMessageExport(fixture);
    const serialized = JSON.stringify(result);

    for (const forbidden of [
        'RAW_ADA_HANDLE',
        'RAW_GRACE_HANDLE',
        'RAW_SELF_HANDLE',
        'RAW_CHAT_DIRECT',
        'RAW_CHAT_GROUP',
        'RAW_MSG_1',
        'RAW_MSG_2',
        'RAW_MSG_3',
        '+155****1111',
        'grace@example.test',
        'ada@example.test',
        'https://',
        'private.example',
        '/Users/sree/Library/Messages',
        '/root/grace',
        'raw-api-secret',
        'token abc123',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});

test('[IMessageImport] runIMessageImport reads synthetic export and writes safe local artifacts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-imessage-import-'));
    const exportFile = path.join(dir, 'export.json');
    const outDir = path.join(dir, 'imessage');
    fs.writeFileSync(exportFile, JSON.stringify(fixture, null, 2));

    const result = runIMessageImport({ exportFile, outDir, dataDir: dir, progress: null, logger: { log() {} } });

    assert.equal(result.contacts.length, 2);
    assert.equal(result.messages.length, 3);
    assert.ok(fs.existsSync(path.join(outDir, 'contacts.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'messages', 'messages.json')));

    const serialized = fs.readFileSync(path.join(outDir, 'contacts.json'), 'utf8')
        + fs.readFileSync(path.join(outDir, 'messages', 'messages.json'), 'utf8');
    assert.equal(serialized.includes('RAW_ADA_HANDLE'), false);
    assert.equal(serialized.includes('+15550101111'), false);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes(exportFile), false);
});

test('[IMessageImport] normalized contacts are compatible with merge source records', () => {
    const result = normalizeIMessageExport(fixture);
    assert.equal(result.contacts[0].source, 'imessage');
    assert.equal(result.messages[0].source, 'imessage');

    const index = new ContactIndex();
    const originalLog = console.log;
    try {
        console.log = () => {};
        loadIMessage(index, result.contacts);
    } finally {
        console.log = originalLog;
    }

    assert.equal(index.contacts.length, 2);
    assert.equal(index.contacts[0].sources.imessage.id, result.contacts[0].imessageRef);
});

test('[IMessageImport] normalized messages are compatible with Minty interaction timelines', () => {
    const result = normalizeIMessageExport(fixture);
    const interactions = buildInteractions({ imessageMessages: result.messages });
    const imessage = interactions.filter(i => i.source === 'imessage');

    assert.equal(imessage.length, 3);
    assert.equal(imessage[0].timestamp, '2026-05-15T12:40:00.000Z');
    assert.equal(imessage[0].from, safeIMessageContactRef('RAW_ADA_HANDLE'));
    assert.equal(imessage[0].to, 'me');
    assert.equal(imessage[0].chatName, 'iMessage conversation');
    assert.equal(imessage[0].body, 'Discussed local relationship memory via [email] at [url] and [path] [redacted-secret]');
    assert.equal(imessage[2].chatName, 'iMessage direct group');
});

test('[IMessageImport] missing export progress error omits local path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-imessage-missing-'));
    const missing = path.join(dir, 'private-export.json');
    const failures = [];

    let thrown;
    assert.throws(() => runIMessageImport({
        exportFile: missing,
        outDir: path.join(dir, 'out'),
        dataDir: dir,
        progress: {
            startProgress() {},
            failProgress(_dataDir, _source, err) { failures.push(err && err.message); },
        },
        logger: { log() {} },
    }), err => {
        thrown = err;
        return /iMessage export JSON was not found/.test(err.message);
    });

    assert.ok(thrown);
    assert.equal(failures.length, 1);
    assert.equal(failures[0], 'iMessage export JSON was not found');
    for (const message of [failures[0], thrown.message]) {
        assert.equal(message.includes(dir), false);
        assert.equal(message.includes('private-export'), false);
    }
});

test('[IMessageImport] importer module has no live Apple provider hooks', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../sources/imessage/import.js'), 'utf8');
    for (const forbidden of [
        'chat.db',
        'iCloud',
        'osascript',
        'Messages.app',
        'AppleScript',
        'sendMessage',
        'sqlite3',
        'node-fetch',
        'axios',
    ]) {
        assert.equal(source.includes(forbidden), false, `live provider hook present: ${forbidden}`);
    }
});
