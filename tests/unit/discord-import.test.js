'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeDiscordExport,
    safeDiscordUserRef,
    runDiscordImport,
} = require('../../sources/discord/import');

const fixture = {
    users: [
        { id: 'user-self-raw', username: 'sree_local_fixture', global_name: 'Fixture Self' },
        { id: 'user-ada-raw', username: 'ada_fixture', global_name: 'Ada Example' },
        { id: 'user-grace-raw', username: 'grace_fixture', global_name: 'Grace Example' },
    ],
    conversations: [
        {
            id: 'dm-channel-raw-1',
            type: 'dm',
            name: null,
            participants: ['user-self-raw', 'user-ada-raw'],
            messages: [
                {
                    id: 'msg-raw-1',
                    authorId: 'user-ada-raw',
                    timestamp: '2026-05-01T10:00:00.000Z',
                    content: 'Discussed privacy-safe local memory.',
                },
                {
                    id: 'msg-raw-2',
                    authorId: 'user-self-raw',
                    timestamp: 'bad date',
                    content: 'bad timestamp should be skipped',
                },
            ],
        },
        {
            id: 'group-channel-raw-2',
            type: 'group_dm',
            name: 'raw private group name should stay local',
            participants: ['user-self-raw', 'user-ada-raw', 'user-grace-raw'],
            messages: [
                {
                    id: 'msg-raw-3',
                    authorId: 'user-grace-raw',
                    timestamp: '2026-05-02T11:00:00.000Z',
                    content: 'Warm intro path came from a small DM group.',
                },
            ],
        },
    ],
};

test('[DiscordImport] normalizes DMs and direct groups with diagnostics', () => {
    const result = normalizeDiscordExport(fixture, { selfUserIds: ['user-self-raw'] });

    assert.equal(result.contacts.length, 2);
    assert.deepEqual(result.contacts.map(c => c.name).sort(), ['Ada Example', 'Grace Example']);
    assert.equal(result.threads.length, 2);
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.diagnostics, {
        skippedConversations: 0,
        skippedMessages: 1,
        skippedParticipants: 0,
    });

    const dm = result.threads.find(t => t.type === 'dm');
    assert.equal(dm.messages.length, 1);
    assert.equal(dm.messages[0].from, safeDiscordUserRef('user-ada-raw'));
    assert.equal(dm.messages[0].to, 'me');
    assert.equal(dm.messages[0].timestamp, '2026-05-01T10:00:00.000Z');

    const group = result.threads.find(t => t.type === 'group_dm');
    assert.equal(group.participantCount, 3);
    assert.equal(group.chatName, 'Discord direct group');
});

test('[DiscordImport] serialized normalized output omits raw ids and group names', () => {
    const result = normalizeDiscordExport(fixture, { selfUserIds: ['user-self-raw'] });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.includes('user-ada-raw'), false);
    assert.equal(serialized.includes('user-grace-raw'), false);
    assert.equal(serialized.includes('dm-channel-raw-1'), false);
    assert.equal(serialized.includes('group-channel-raw-2'), false);
    assert.equal(serialized.includes('msg-raw-1'), false);
    assert.equal(serialized.includes('raw private group name'), false);
    assert.equal(serialized.includes('ada_fixture'), false);
});

test('[DiscordImport] runDiscordImport writes local artifacts and no raw ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-discord-import-'));
    const exportPath = path.join(dir, 'export.json');
    const outDir = path.join(dir, 'out');
    fs.writeFileSync(exportPath, JSON.stringify(fixture));

    const result = runDiscordImport({
        exportFile: exportPath,
        outDir,
        dataDir: dir,
        selfUserIds: ['user-self-raw'],
        progress: null,
        logger: { log() {}, error() {} },
    });

    assert.equal(result.contacts.length, 2);
    assert.ok(fs.existsSync(path.join(outDir, 'contacts.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'messages.json')));

    const contactsText = fs.readFileSync(path.join(outDir, 'contacts.json'), 'utf8');
    const messagesText = fs.readFileSync(path.join(outDir, 'messages.json'), 'utf8');
    assert.equal((contactsText + messagesText).includes('user-ada-raw'), false);
    assert.equal((contactsText + messagesText).includes('dm-channel-raw-1'), false);
});

test('[DiscordImport] missing export progress error omits local path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-discord-missing-'));
    const missingPath = path.join(dir, 'private-export.json');
    const failures = [];

    assert.throws(() => runDiscordImport({
        exportFile: missingPath,
        outDir: path.join(dir, 'out'),
        dataDir: dir,
        progress: {
            startProgress() {},
            failProgress(_dataDir, _source, err) { failures.push(err && err.message); },
        },
        logger: { log() {}, error() {} },
    }), /Discord export not found/);

    assert.equal(failures.length, 1);
    assert.equal(failures[0], 'Discord export file was not found');
    assert.equal(failures[0].includes(dir), false);
    assert.equal(failures[0].includes('private-export.json'), false);
});
