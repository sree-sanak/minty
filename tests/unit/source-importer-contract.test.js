'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ContactIndex } = require('../../crm/utils');
const { buildAgentSourceHealth } = require('../../crm/agent-source-health');

const REPO_ROOT = path.join(__dirname, '../..');

function moduleExists(relativePath) {
    return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

function tmpDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `minty-importer-contract-${label}-`));
}

function logger() {
    return { log() {}, error() {} };
}

function requireMergeForDataDir(dataDir) {
    const mergePath = require.resolve('../../crm/merge');
    const prior = process.env.CRM_DATA_DIR;
    process.env.CRM_DATA_DIR = dataDir;
    delete require.cache[mergePath];
    const merge = require('../../crm/merge');
    return {
        merge,
        restore() {
            delete require.cache[mergePath];
            if (prior === undefined) delete process.env.CRM_DATA_DIR;
            else process.env.CRM_DATA_DIR = prior;
            require('../../crm/merge');
        },
    };
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeDiscordFixture(root) {
    const exportFile = path.join(root, 'discord-export.json');
    const outDir = path.join(root, 'discord');
    const fixture = {
        users: [
            { id: 'RAW_SELF_DISCORD', username: 'self_fixture', global_name: 'Fixture Self' },
            { id: 'RAW_ADA_DISCORD', username: 'ada_fixture', global_name: 'Ada Example' },
        ],
        conversations: [{
            id: 'RAW_DISCORD_CHANNEL',
            type: 'dm',
            participants: ['RAW_SELF_DISCORD', 'RAW_ADA_DISCORD'],
            messages: [{
                id: 'RAW_DISCORD_MESSAGE',
                authorId: 'RAW_ADA_DISCORD',
                timestamp: '2026-05-15T10:00:00.000Z',
                content: 'Discord memory via ada' + '@' + 'example.test at https://private.example and /Users/fixture/Library/Messages api_key=abc123',
            }],
        }],
    };
    writeJson(exportFile, fixture);
    return { exportFile, outDir };
}

function writeSlackFixture(root) {
    const exportDir = path.join(root, 'slack-export');
    const outDir = path.join(root, 'slack');
    fs.mkdirSync(path.join(exportDir, 'D_RAW_SLACK_ADA'), { recursive: true });
    writeJson(path.join(exportDir, 'users.json'), [
        { id: 'U_RAW_SELF_SLACK', name: 'self', real_name: 'Fixture Self' },
        { id: 'U_RAW_ADA_SLACK', name: 'ada_fixture', real_name: 'Ada Example', profile: { title: 'Founder', email: 'ada' + '@' + 'example.test' } },
    ]);
    writeJson(path.join(exportDir, 'dms.json'), [
        { id: 'D_RAW_SLACK_ADA', members: ['U_RAW_SELF_SLACK', 'U_RAW_ADA_SLACK'] },
    ]);
    writeJson(path.join(exportDir, 'mpims.json'), []);
    writeJson(path.join(exportDir, 'D_RAW_SLACK_ADA', '2026-05-15.json'), [
        { type: 'message', user: 'U_RAW_ADA_SLACK', ts: '1780000000.000100', text: 'Slack memory via ada' + '@' + 'example.test at https://private.example api_key=abc123' },
    ]);
    return { exportDir, outDir };
}

function writeIMessageFixture(root) {
    const exportFile = path.join(root, 'imessage-export.json');
    const outDir = path.join(root, 'imessage');
    const fixture = {
        selfHandles: ['RAW_SELF_IMESSAGE'],
        handles: [
            { id: 'RAW_SELF_IMESSAGE', value: '+155****1010', displayName: 'Fixture Self' },
            { id: 'RAW_ADA_IMESSAGE', value: '+155****1111', displayName: 'Ada Example' },
        ],
        chats: [{
            id: 'RAW_IMESSAGE_CHAT',
            type: 'direct',
            participants: ['RAW_SELF_IMESSAGE', 'RAW_ADA_IMESSAGE'],
            messages: [{
                id: 'RAW_IMESSAGE_MESSAGE',
                handleId: 'RAW_ADA_IMESSAGE',
                timestamp: '2026-05-15T12:40:00Z',
                text: 'iMessage memory via ada' + '@' + 'example.test at https://private.example and /Users/fixture/Library/Messages token abc123',
            }],
        }],
    };
    writeJson(exportFile, fixture);
    return { exportFile, outDir };
}

const REGISTRY = [
    {
        source: 'discord',
        modulePath: 'sources/discord/import.js',
        testName: 'Discord',
        forbidden: ['RAW_ADA_DISCORD', 'RAW_DISCORD_CHANNEL', 'RAW_DISCORD_MESSAGE', 'ada_fixture'],
        forbiddenHooks: ['DISCORD_BOT_TOKEN', 'discord.com/api', 'GatewayIntentBits', 'sendMessage', 'node-fetch', 'axios'],
        run(root) {
            const { runDiscordImport } = require('../../sources/discord/import');
            const { exportFile, outDir } = writeDiscordFixture(root);
            return runDiscordImport({ exportFile, outDir, dataDir: root, selfUserIds: ['RAW_SELF_DISCORD'], progress: null, logger: logger() });
        },
        load(merge, index, contacts) {
            merge.loadDiscord(index, contacts);
        },
    },
    {
        source: 'slack',
        modulePath: 'sources/slack/import.js',
        testName: 'Slack',
        forbidden: ['U_RAW_ADA_SLACK', 'D_RAW_SLACK_ADA', 'ada@example.test', 'private.example', 'api_key=abc123'],
        forbiddenHooks: ['SLACK_BOT_TOKEN', 'SLACK_USER_TOKEN', 'https://slack.com/api', 'chat.postMessage', 'conversations.history', '@slack/web-api', 'node-fetch', 'axios'],
        run(root) {
            const { runSlackImport } = require('../../sources/slack/import');
            const { exportDir, outDir } = writeSlackFixture(root);
            return runSlackImport({ exportDir, outDir, dataDir: root, selfUserIds: ['U_RAW_SELF_SLACK'], progress: null, logger: logger() });
        },
        load(merge, index, contacts) {
            merge.loadSlack(index, contacts);
        },
    },
    {
        source: 'imessage',
        modulePath: 'sources/imessage/import.js',
        testName: 'iMessage',
        forbidden: ['RAW_ADA_IMESSAGE', 'RAW_IMESSAGE_CHAT', 'RAW_IMESSAGE_MESSAGE', '+155****1111', 'ada@example.test', 'private.example', '/Users/fixture/Library/Messages', 'token abc123'],
        forbiddenHooks: ['chat.db', 'iCloud', 'osascript', 'Messages.app', 'AppleScript', 'sendMessage', 'sqlite3', 'node-fetch', 'axios'],
        run(root) {
            const { runIMessageImport } = require('../../sources/imessage/import');
            const { exportFile, outDir } = writeIMessageFixture(root);
            return runIMessageImport({ exportFile, outDir, dataDir: root, progress: null, logger: logger() });
        },
        load(merge, index, contacts) {
            merge.loadIMessage(index, contacts);
        },
    },
];

function assertSerializedSafe(source, value, forbidden) {
    const serialized = JSON.stringify(value);
    for (const sentinel of forbidden) {
        assert.equal(serialized.includes(sentinel), false, `${source} leaked ${sentinel}`);
    }
    assert.equal(/https?:\/\//.test(serialized), false, `${source} leaked URL`);
    assert.equal(/(?:ftp|file):\/\//.test(serialized), false, `${source} leaked file URL`);
    assert.equal(/Bearer\s+/i.test(serialized), false, `${source} leaked bearer token`);
    assert.equal(/api[_-]?key/i.test(serialized), false, `${source} leaked api key marker`);
}

function assertNoLiveProviderHooks(source, modulePath, forbiddenHooks) {
    const text = fs.readFileSync(path.join(REPO_ROOT, modulePath), 'utf8');
    for (const hook of forbiddenHooks) {
        assert.equal(text.includes(hook), false, `${source} importer contains live hook ${hook}`);
    }
}

function normalizedArtifactPaths(source, root) {
    const expected = source === 'discord'
        ? ['contacts.json', 'messages.json']
        : ['contacts.json', 'messages/messages.json'];
    return expected.map(relative => path.join(root, source, relative));
}

function assertArtifactsStayUnderSourceDir(source, root) {
    const sourceDir = path.join(root, source);
    for (const artifact of normalizedArtifactPaths(source, root)) {
        assert.ok(fs.existsSync(artifact), `${source} should write ${path.relative(sourceDir, artifact)}`);
        assert.ok(path.resolve(artifact).startsWith(path.resolve(sourceDir) + path.sep));
    }
}

function assertPersistedArtifactsSafe(source, root, forbidden) {
    for (const artifact of normalizedArtifactPaths(source, root)) {
        const parsed = JSON.parse(fs.readFileSync(artifact, 'utf8'));
        assertSerializedSafe(`${source} ${path.basename(artifact)}`, parsed, forbidden);
    }
}

test('[SourceImporterContract] registry points at existing modules', () => {
    const missing = REGISTRY.filter(row => !moduleExists(row.modulePath)).map(row => row.modulePath);
    assert.deepEqual(missing, []);
});

test('[SourceImporterContract] helper catches forbidden serialized sentinels', () => {
    assert.throws(() => assertSerializedSafe('fixture', { value: 'RAW_SECRET' }, ['RAW_SECRET']));
    assert.doesNotThrow(() => assertSerializedSafe('fixture', { value: '[redacted]' }, ['RAW_SECRET']));
});

for (const row of REGISTRY) {
    test(`[SourceImporterContract] ${row.testName} satisfies local importer trust contract`, () => {
        const root = tmpDir(row.source);
        const result = row.run(root);

        assert.ok(Array.isArray(result.contacts));
        assert.ok(result.contacts.length > 0);
        assert.ok(Array.isArray(result.messages));
        assert.ok(result.messages.length > 0);
        assert.ok(result.contacts.every(c => c.source === row.source), `${row.source} contacts should use canonical source key`);
        assert.ok(result.messages.every(m => m.source === row.source), `${row.source} messages should use canonical source key`);
        assertArtifactsStayUnderSourceDir(row.source, root);
        assertSerializedSafe(row.source, result, row.forbidden);
        assertPersistedArtifactsSafe(row.source, root, row.forbidden);
        assertNoLiveProviderHooks(row.source, row.modulePath, row.forbiddenHooks);

        const { merge, restore } = requireMergeForDataDir(root);
        try {
            const index = new ContactIndex();
            const originalLog = console.log;
            try {
                console.log = () => {};
                row.load(merge, index, result.contacts);
            } finally {
                console.log = originalLog;
            }
            assert.ok(index.contacts.length > 0, `${row.source} should load contacts into ContactIndex`);

            const interactions = merge.buildInteractions();
            assert.ok(interactions.some(i => i.source === row.source), `${row.source} should produce source-keyed interactions`);

            const health = buildAgentSourceHealth({
                contacts: index.contacts,
                interactions,
                contactEvidence: {},
                sourceEvents: [],
                syncState: { [row.source]: { lastSyncAt: '2026-05-16T00:00:00.000Z' } },
            }, { source: row.source, now: '2026-05-16T01:00:00.000Z' });

            assert.equal(health.status, 'ok');
            assert.deepEqual(Object.keys(health.sources), [row.source]);
            assert.equal(health.sources[row.source].status, 'ready');
            assert.equal(health.sources[row.source].freshness, 'fresh');
            assert.equal(health.sources[row.source].contactCount > 0, true);
            assert.equal(health.sources[row.source].interactionCount > 0, true);
            assert.deepEqual(health.sources[row.source].warnings, []);
        } finally {
            restore();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
