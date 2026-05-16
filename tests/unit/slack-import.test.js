'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeSlackExport,
    safeSlackUserRef,
    runSlackImport,
} = require('../../sources/slack/import');
const { loadSlack } = require('../../crm/merge');
const { ContactIndex } = require('../../crm/utils');

const fixture = {
    users: [
        {
            id: 'U_SELF_RAW',
            name: 'self_fixture',
            real_name: 'Fixture Self',
            profile: { real_name: 'Fixture Self', email: 'self@example.test' },
        },
        {
            id: 'U_ADA_RAW',
            name: 'ada_fixture',
            real_name: 'Ada Example',
            profile: {
                real_name: 'Ada Example',
                display_name: 'Ada',
                email: 'ada@example.test',
                title: 'Founder',
            },
        },
        {
            id: 'U_GRACE_RAW',
            name: 'grace_fixture',
            real_name: 'Grace Example',
            profile: { real_name: 'Grace Example', title: 'Engineer xapp-raw-app-secret /root/grace ada@example.test' },
        },
        { id: 'USLACKBOT', name: 'slackbot', real_name: 'Slackbot' },
    ],
    dms: [
        { id: 'D_RAW_ADA', members: ['U_SELF_RAW', 'U_ADA_RAW'] },
    ],
    mpims: [
        { id: 'G_RAW_GROUP', name: 'secret-founders', members: ['U_SELF_RAW', 'U_ADA_RAW', 'U_GRACE_RAW'] },
    ],
    messagesByConversation: {
        D_RAW_ADA: [
            { type: 'message', user: 'U_SELF_RAW', ts: '1778848860.000000', text: 'Thanks — no tokens needed.' },
            { type: 'message', user: 'U_ADA_RAW', ts: '1778848800.000000', text: 'Discussed local relationship memory with <@U_GRACE_RAW> via ada@example.test at https://private.example/path and /root/private export. Token xoxb-raw-secret-123 and api_key="raw-api-secret".' },
            { type: 'message', user: 'USLACKBOT', ts: '1778848870.000000', text: 'bot noise should skip' },
            { type: 'message', user: 'U_ADA_RAW', ts: 'bad-ts', text: 'bad timestamp should skip' },
        ],
        G_RAW_GROUP: [
            { type: 'message', user: 'U_GRACE_RAW', ts: '1778935200.000000', text: 'Warm intro path came from Slack MPIM. Bearer rawbearersecret123 and xapp-raw-app-secret.' },
            { type: 'message', subtype: 'bot_message', user: 'U_ADA_RAW', ts: '1778935300.000000', text: 'bot subtype should skip' },
        ],
    },
};

test('[SlackImport] normalizes DMs and MPIMs with diagnostics', () => {
    const result = normalizeSlackExport(fixture, { selfUserIds: ['U_SELF_RAW'] });

    assert.equal(result.contacts.length, 2);
    assert.deepEqual(result.contacts.map(c => c.name).sort(), ['Ada Example', 'Grace Example']);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.diagnostics, {
        skippedConversations: 0,
        skippedMessages: 3,
        skippedParticipants: 0,
    });

    const dm = result.conversations.find(t => t.type === 'direct');
    assert.equal(dm.messages.length, 2);
    assert.equal(dm.messages[0].from, 'me');
    assert.equal(dm.messages[0].to, safeSlackUserRef('U_ADA_RAW'));
    assert.equal(dm.messages[0].timestamp, '2026-05-15T12:41:00.000Z');
    assert.equal(dm.messages[1].from, safeSlackUserRef('U_ADA_RAW'));
    assert.equal(dm.messages[1].to, 'me');
    assert.equal(dm.messages[1].timestamp, '2026-05-15T12:40:00.000Z');
    assert.equal(dm.messages[1].body, 'Discussed local relationship memory with [slack-ref] via [email] at [url] and [path] export. Token [redacted-secret] and [redacted-secret].');
    assert.equal(result.contacts.find(c => c.name === 'Ada Example').lastMessageAt, '2026-05-15T12:40:00.000Z');
    assert.equal(dm.chatName, 'Slack DM');

    const group = result.conversations.find(t => t.type === 'mpim');
    assert.equal(group.participantCount, 3);
    assert.equal(group.chatName, 'Slack direct group');
});

test('[SlackImport] serialized normalized output omits raw ids, emails, names, URLs, and token words', () => {
    const result = normalizeSlackExport(fixture, { selfUserIds: ['U_SELF_RAW'] });
    const serialized = JSON.stringify(result);

    for (const forbidden of [
        'U_ADA_RAW',
        'D_RAW_ADA',
        'G_RAW_GROUP',
        'ada@example.test',
        'self@example.test',
        'secret-founders',
        'https://',
        'private.example',
        '/root/private',
        '<@U_GRACE_RAW>',
        'SLACK_BOT_TOKEN',
        'xoxb-raw-secret-123',
        'raw-api-secret',
        'xapp-raw-app-secret',
        'rawbearersecret123',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});

test('[SlackImport] handle-only profiles and channel mentions are redacted from artifacts', () => {
    const result = normalizeSlackExport({
        users: [
            { id: 'U_SELF_RAW', name: 'self_fixture' },
            { id: 'U_HANDLE_RAW', name: 'ada-lovelace', profile: { display_name: 'ada-lovelace' } },
        ],
        dms: [{ id: 'D_HANDLE_RAW', members: ['U_SELF_RAW', 'U_HANDLE_RAW'], name: 'secret-founders' }],
        messagesByConversation: {
            D_HANDLE_RAW: [
                { type: 'message', user: 'U_HANDLE_RAW', ts: '1778848800.000000', text: 'Ping @ada-lovelace in #secret-founders and secret-founders.' },
            ],
        },
    }, { selfUserIds: ['U_SELF_RAW'] });

    assert.equal(result.contacts.length, 1);
    assert.equal(result.contacts[0].name, 'Slack contact');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['ada-lovelace', '@ada-lovelace', '#secret-founders', 'secret-founders', 'D_HANDLE_RAW', 'U_HANDLE_RAW']) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
    assert.equal(result.messages[0].body, 'Ping [slack-ref] in [slack-ref] and [slack-ref].');
});

test('[SlackImport] runSlackImport reads export dir and writes safe local artifacts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-import-'));
    const exportDir = path.join(dir, 'export');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(path.join(exportDir, 'D_RAW_ADA'), { recursive: true });
    fs.mkdirSync(path.join(exportDir, 'G_RAW_GROUP'), { recursive: true });

    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify(fixture.users, null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify(fixture.dms, null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify(fixture.mpims, null, 2));
    fs.writeFileSync(path.join(exportDir, 'D_RAW_ADA', '2026-05-15.json'), JSON.stringify(fixture.messagesByConversation.D_RAW_ADA, null, 2));
    fs.writeFileSync(path.join(exportDir, 'G_RAW_GROUP', '2026-05-16.json'), JSON.stringify(fixture.messagesByConversation.G_RAW_GROUP, null, 2));

    const result = runSlackImport({
        exportDir,
        outDir,
        dataDir: dir,
        selfUserIds: ['U_SELF_RAW'],
        progress: null,
        logger: { log() {} },
    });

    assert.equal(result.contacts.length, 2);
    assert.equal(result.messages.length, 3);
    assert.ok(fs.existsSync(path.join(outDir, 'contacts.json')));
    assert.ok(fs.existsSync(path.join(outDir, 'messages', 'messages.json')));

    const contacts = fs.readFileSync(path.join(outDir, 'contacts.json'), 'utf8');
    const messages = fs.readFileSync(path.join(outDir, 'messages', 'messages.json'), 'utf8');
    const serialized = contacts + messages;
    assert.equal(serialized.includes('U_ADA_RAW'), false);
    assert.equal(serialized.includes('D_RAW_ADA'), false);
    assert.equal(serialized.includes('private.example'), false);
    assert.equal(serialized.includes('/root/private'), false);
    assert.equal(serialized.includes('xoxb-raw-secret-123'), false);
    assert.equal(serialized.includes('raw-api-secret'), false);
    assert.equal(serialized.includes('xapp-raw-app-secret'), false);
    assert.equal(serialized.includes('rawbearersecret123'), false);
    assert.equal(serialized.includes(exportDir), false);
});

test('[SlackImport] conversation ids cannot traverse outside the export directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-traversal-'));
    const exportDir = path.join(dir, 'export');
    const outDir = path.join(dir, 'out');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify(fixture.users, null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify([{ id: '../outside', members: ['U_SELF_RAW', 'U_ADA_RAW'] }], null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(outside, '2026-05-15.json'), JSON.stringify([
        { type: 'message', user: 'U_ADA_RAW', ts: '1778848800.000000', text: 'outside leak sentinel' },
    ], null, 2));

    const result = runSlackImport({ exportDir, outDir, dataDir: dir, selfUserIds: ['U_SELF_RAW'], progress: null, logger: { log() {} } });
    const messages = fs.readFileSync(path.join(outDir, 'messages', 'messages.json'), 'utf8');
    assert.equal(result.messages.length, 0);
    assert.equal(messages.includes('outside leak sentinel'), false);
});

test('[SlackImport] symlinked conversation files cannot escape the export directory', { skip: process.platform === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-symlink-'));
    const exportDir = path.join(dir, 'export');
    const outDir = path.join(dir, 'out');
    const convDir = path.join(exportDir, 'D_RAW_ADA');
    const outside = path.join(dir, 'outside.json');
    fs.mkdirSync(convDir, { recursive: true });

    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify(fixture.users, null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify(fixture.dms, null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(outside, JSON.stringify([
        { type: 'message', user: 'U_ADA_RAW', ts: '1778848800.000000', text: 'symlink leak sentinel' },
    ], null, 2));
    fs.symlinkSync(outside, path.join(convDir, '2026-05-15.json'));

    const result = runSlackImport({ exportDir, outDir, dataDir: dir, selfUserIds: ['U_SELF_RAW'], progress: null, logger: { log() {} } });
    const messages = fs.readFileSync(path.join(outDir, 'messages', 'messages.json'), 'utf8');
    assert.equal(result.messages.length, 0);
    assert.equal(messages.includes('symlink leak sentinel'), false);
});

test('[SlackImport] normalized artifacts are compatible with merge/source health surfaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-merge-'));
    const exportDir = path.join(dir, 'export');
    const outDir = path.join(dir, 'slack');
    fs.mkdirSync(path.join(exportDir, 'D_RAW_ADA'), { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify(fixture.users, null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify(fixture.dms.slice(0, 1), null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(exportDir, 'D_RAW_ADA', '2026-05-15.json'), JSON.stringify(fixture.messagesByConversation.D_RAW_ADA, null, 2));

    const result = runSlackImport({ exportDir, outDir, dataDir: dir, selfUserIds: ['U_SELF_RAW'], progress: null, logger: { log() {} } });
    assert.equal(result.contacts[0].source, 'slack');
    assert.equal(result.contacts[0].slackId, result.contacts[0].userId);
    assert.equal(result.messages[0].source, 'slack');
    assert.equal(result.messages[0].chatName, 'Slack DM');

    const index = new ContactIndex();
    const originalLog = console.log;
    try {
        console.log = () => {};
        loadSlack(index, result.contacts);
    } finally {
        console.log = originalLog;
    }
    assert.equal(index.contacts.length, 1);
    assert.equal(index.contacts[0].name, 'Ada Example');
    assert.equal(index.contacts[0].sources.slack.id, result.contacts[0].slackId);
    assert.equal(index.contacts[0].sources.slack.userId, result.contacts[0].userId);
});

test('[SlackImport] importer module has no live Slack provider hooks', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../sources/slack/import.js'), 'utf8');
    for (const forbidden of [
        'https://slack.com/api',
        'SLACK_BOT_TOKEN',
        'SLACK_USER_TOKEN',
        'chat.postMessage',
        'conversations.history',
        '@slack/web-api',
        'node-fetch',
        'axios',
    ]) {
        assert.equal(source.includes(forbidden), false, `live provider hook present: ${forbidden}`);
    }
});

test('[SlackImport] missing export progress error omits local path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-missing-'));
    const missing = path.join(dir, 'private-export');
    const failures = [];

    let thrown;
    assert.throws(() => runSlackImport({
        exportDir: missing,
        outDir: path.join(dir, 'out'),
        dataDir: dir,
        progress: {
            startProgress() {},
            failProgress(_dataDir, _source, err) { failures.push(err && err.message); },
        },
        logger: { log() {} },
    }), err => {
        thrown = err;
        return /Slack export directory was not found/.test(err.message);
    });

    assert.ok(thrown);
    assert.equal(failures.length, 1);
    assert.equal(failures[0], 'Slack export directory was not found');
    for (const message of [failures[0], thrown.message]) {
        assert.equal(message.includes(dir), false);
        assert.equal(message.includes('private-export'), false);
    }
});

test('[SlackImport] output does not expose raw local paths after parse failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-bad-json-'));
    const exportDir = path.join(dir, 'export');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'users.json'), '{bad json');

    let thrown;
    assert.throws(
        () => runSlackImport({ exportDir, outDir: path.join(dir, 'out'), dataDir: dir, progress: null, logger: { log() {} } }),
        err => {
            thrown = err;
            return /Slack export JSON could not be parsed/.test(err.message);
        }
    );
    assert.equal(thrown.message.includes(dir), false);
    assert.equal(thrown.message.includes('users.json'), false);
});
