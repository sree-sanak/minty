# Slack Export Importer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a safe, local-file-only Slack export importer so Minty can turn Slack DMs/MPIMs into source-backed relationship evidence without Slack API tokens, scraping, or message sending.

**Architecture:** Mirror the just-shipped Discord importer: parse a local Slack export directory into normalized `data/slack/contacts.json` and `data/slack/messages/messages.json`, then reuse the existing Slack merge/source-health/MCP trust surfaces already present on `main`. Keep the first slice deliberately file-only and relationship-memory-oriented: DMs/MPIMs only by default, channel/public group artifacts ignored unless explicitly added later.

**Tech Stack:** Plain Node.js CommonJS, Node built-ins (`fs`, `path`, `crypto`), existing `sources/_shared/progress`, existing `crm/merge.js` Slack loader, Node built-in test runner.

---

## Product context

Minty's trust layer is now mostly in place: `source_health`, answerability gates, MCP citation/freshness preservation, safe source labels, GBrain export hardening, goal actions, meeting prep, intro paths, memory-refresh diagnostics, and a local Discord export importer. The next bottleneck is source depth: Hermes/OpenClaw can only activate relationship memory from sources Minty has actually ingested.

Slack is already a canonical safe source inside `crm/source-events.js`, `crm/agent-source-health.js`, `scripts/minty-mcp-server.js`, `crm/schema.js`, and `crm/merge.js`, but there is no `sources/slack/import.js` and no `npm run slack`. That means agents can see Slack as a possible source, yet users have no safe local path to make Slack evidence real.

Official Slack export docs describe JSON export bundles with `users.json`, conversation metadata files such as `dms.json` / `mpims.json`, and per-conversation message JSON files. This plan uses only those local files. It does not use Slack Web API, OAuth, bot tokens, workspace joins, webhooks, or sends.

## Acceptance criteria

- `npm run slack` reads a local export directory from `SLACK_EXPORT_DIR` and writes only local artifacts under `data/slack/` or `SLACK_OUT_DIR`.
- Parser supports synthetic Slack export-style `users.json`, `dms.json`, `mpims.json`, and per-conversation message JSON files.
- By default, it imports DMs and MPIMs only; public/private channel imports are non-goals for this slice.
- Normalized contacts are compatible with existing `loadSlack()` in `crm/merge.js`.
- Normalized messages are compatible with existing `buildInteractions()` Slack path, which reads `data/slack/messages/messages.json`.
- Serialized normalized output omits raw Slack user ids, channel ids, workspace ids, emails, channel names, private export paths, token names, invite URLs, and file URLs.
- `source_health` / service status can report Slack as configured/evidence-bearing when normalized artifacts exist.
- Tests use synthetic names/content only and no real Slack exports.

## Non-goals

- No Slack Web API, OAuth, bot token, RTM/gateway, webhook, workspace scraping, or message sending.
- No live background Slack sync in this slice.
- No public channel/community signal work in this slice.
- No new MCP tool; improve existing `search_network`, `person_context`, `workflow_brief`, and `source_health` surfaces through better source depth.
- No raw Slack export files committed.

---

### Task 1: Add pure Slack export parser

**Objective:** Normalize synthetic Slack export DMs/MPIMs into privacy-safe contacts and message records.

**Files:**
- Create: `sources/slack/import.js`
- Create: `tests/unit/slack-import.test.js`

**Step 1: Write failing test**

Create `tests/unit/slack-import.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeSlackExport,
    safeSlackUserRef,
    safeSlackChannelRef,
} = require('../../sources/slack/import');

const fixture = {
    users: [
        { id: 'U_SELF_RAW', name: 'self-user', profile: { real_name: 'Self User', email: 'self' + '@' + 'example.test' } },
        { id: 'U_ADA_RAW', name: 'ada-lovelace', profile: { real_name: 'Ada Lovelace', display_name: 'Ada', email: 'ada' + '@' + 'example.test', title: 'Founder' } },
        { id: 'USLACKBOT', name: 'slackbot', profile: { real_name: 'Slackbot' } },
        { id: 'U_GRACE_RAW', name: 'grace-hopper', profile: { real_name: 'Grace Hopper' } },
    ],
    dms: [
        { id: 'D_RAW_ADA', members: ['U_SELF_RAW', 'U_ADA_RAW'] },
        { id: 'D_RAW_BOT', members: ['U_SELF_RAW', 'USLACKBOT'] },
    ],
    mpims: [
        { id: 'G_RAW_GROUP', members: ['U_SELF_RAW', 'U_ADA_RAW', 'U_GRACE_RAW'], name: 'secret-founders' },
    ],
    messagesByConversation: {
        D_RAW_ADA: [
            { type: 'message', user: 'U_ADA_RAW', ts: '1780000000.000100', text: 'We discussed robotics.' },
            { type: 'message', user: 'U_SELF_RAW', ts: '1780000060.000100', text: 'Thanks!' },
        ],
        D_RAW_BOT: [
            { type: 'message', user: 'USLACKBOT', ts: '1780000100.000100', text: 'bot noise' },
        ],
        G_RAW_GROUP: [
            { type: 'message', user: 'U_GRACE_RAW', ts: '1780000200.000100', text: 'Group context' },
        ],
    },
};

test('[SlackImport] normalizes DMs and MPIMs with diagnostics', () => {
    const result = normalizeSlackExport(fixture, { selfUserIds: ['U_SELF_RAW'] });

    assert.equal(result.contacts.length, 2);
    assert.equal(result.conversations.length, 2);
    assert.equal(result.messages.length, 3);
    assert.equal(result.diagnostics.skippedConversations, 1);

    const ada = result.contacts.find(c => c.name === 'Ada Lovelace');
    assert.ok(ada);
    assert.equal(ada.id, safeSlackUserRef('U_ADA_RAW'));
    assert.equal(ada.userId, safeSlackUserRef('U_ADA_RAW'));
    assert.equal(ada.email, null);
    assert.equal(ada.title, 'Founder');

    const dm = result.conversations.find(c => c.type === 'direct');
    assert.equal(dm.id, safeSlackChannelRef('D_RAW_ADA'));
    assert.equal(dm.chatName, 'Slack DM');
    assert.equal(dm.messages[0].from, safeSlackUserRef('U_ADA_RAW'));
    assert.equal(dm.messages[1].from, 'me');

    const group = result.conversations.find(c => c.type === 'mpim');
    assert.equal(group.chatName, 'Slack direct group');
    assert.equal(group.participantCount, 3);
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
        'SLACK_BOT_TOKEN',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});
```

**Step 2: Run test to verify failure**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: FAIL because `sources/slack/import.js` does not exist.

**Step 3: Write minimal implementation**

Create `sources/slack/import.js` with pure helpers first:

```js
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function stableHash(prefix, value) {
    return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)}`;
}

function safeSlackUserRef(id) {
    return stableHash('slack_user', id);
}

function safeSlackChannelRef(id) {
    return stableHash('slack_thread', id);
}

function safeSlackMessageRef(id) {
    return stableHash('slack_msg', id);
}

function slackTimestamp(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const [secondsPart, microsPart = '0'] = String(value).split('.');
    const seconds = Number(secondsPart);
    if (!Number.isFinite(seconds)) return null;
    const millis = Math.floor(Number(`0.${microsPart}`) * 1000);
    const date = new Date(seconds * 1000 + millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function userName(user) {
    const profile = user && user.profile && typeof user.profile === 'object' ? user.profile : {};
    const raw = profile.real_name || profile.display_name || user.real_name || user.name || null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function userTitle(user) {
    const profile = user && user.profile && typeof user.profile === 'object' ? user.profile : {};
    const raw = profile.title || user.title || null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function isSlackbot(id, user) {
    const normalizedId = String(id || '').toUpperCase();
    const normalizedName = String((user && (user.name || user.real_name)) || '').toLowerCase();
    return normalizedId === 'USLACKBOT' || normalizedName === 'slackbot';
}

function normalizeSlackExport(data, options = {}) {
    const users = new Map();
    for (const user of data && Array.isArray(data.users) ? data.users : []) {
        if (user && user.id) users.set(String(user.id), user);
    }

    const selfIds = new Set((options.selfUserIds || data.selfUserIds || []).map(String));
    const contactsByRef = new Map();
    const conversations = [];
    const messages = [];
    const diagnostics = { skippedConversations: 0, skippedMessages: 0, skippedParticipants: 0 };

    const specs = [
        ...((data && Array.isArray(data.dms) ? data.dms : []).map(c => ({ ...c, type: 'direct' }))),
        ...((data && Array.isArray(data.mpims) ? data.mpims : []).map(c => ({ ...c, type: 'mpim' }))),
    ];

    for (const conv of specs) {
        if (!conv || !conv.id || !Array.isArray(conv.members)) {
            diagnostics.skippedConversations += 1;
            continue;
        }
        const participantRefs = [];
        for (const memberId of conv.members.map(String)) {
            if (selfIds.has(memberId)) continue;
            const user = users.get(memberId);
            if (isSlackbot(memberId, user)) continue;
            const name = userName(user);
            if (!name) {
                diagnostics.skippedParticipants += 1;
                continue;
            }
            const ref = safeSlackUserRef(memberId);
            participantRefs.push(ref);
            if (!contactsByRef.has(ref)) {
                contactsByRef.set(ref, {
                    id: ref,
                    source: 'slack',
                    userId: ref,
                    slackId: ref,
                    displayName: name,
                    name,
                    email: null,
                    title: userTitle(user),
                    workspace: null,
                    firstSeen: null,
                    lastMessageAt: null,
                    messageCount: 0,
                });
            }
        }
        if (participantRefs.length === 0) {
            diagnostics.skippedConversations += 1;
            continue;
        }

        const conversation = {
            id: safeSlackChannelRef(conv.id),
            source: 'slack',
            type: conv.type,
            chatName: conv.type === 'mpim' ? 'Slack direct group' : 'Slack DM',
            participantRefs,
            participantCount: conv.members.length,
            messages: [],
        };

        for (const msg of (data.messagesByConversation && data.messagesByConversation[conv.id]) || []) {
            if (!msg || msg.subtype === 'bot_message') {
                diagnostics.skippedMessages += 1;
                continue;
            }
            const timestamp = slackTimestamp(msg.ts || msg.timestamp);
            const rawUser = msg.user || msg.username || msg.bot_id;
            if (!timestamp || !rawUser || isSlackbot(rawUser, users.get(String(rawUser)))) {
                diagnostics.skippedMessages += 1;
                continue;
            }
            const from = selfIds.has(String(rawUser)) ? 'me' : safeSlackUserRef(rawUser);
            const normalized = {
                id: safeSlackMessageRef(`${conv.id}:${msg.ts || timestamp}:${rawUser}`),
                source: 'slack',
                timestamp,
                from,
                to: from === 'me' && participantRefs.length === 1 ? participantRefs[0] : 'me',
                body: typeof msg.text === 'string' ? msg.text : '',
                type: conv.type,
                chatId: conversation.id,
                chatName: conversation.chatName,
            };
            conversation.messages.push(normalized);
            messages.push(normalized);
            if (from !== 'me' && contactsByRef.has(from)) {
                const contact = contactsByRef.get(from);
                contact.messageCount += 1;
                contact.firstSeen = contact.firstSeen || timestamp;
                contact.lastMessageAt = timestamp;
            }
        }
        conversations.push(conversation);
    }

    return { contacts: [...contactsByRef.values()], conversations, messages, diagnostics };
}

module.exports = {
    normalizeSlackExport,
    safeSlackUserRef,
    safeSlackChannelRef,
    safeSlackMessageRef,
    slackTimestamp,
};
```

**Step 4: Run test to verify pass**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/slack/import.js tests/unit/slack-import.test.js
git commit -m "feat: add Slack export parser"
```

---

### Task 2: Add local export-directory reader and CLI

**Objective:** Make `sources/slack/import.js` read real Slack export directory shape locally and write normalized artifacts.

**Files:**
- Modify: `sources/slack/import.js`
- Modify: `tests/unit/slack-import.test.js`

**Step 1: Write failing test**

Append to `tests/unit/slack-import.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSlackImport } = require('../../sources/slack/import');

test('[SlackImport] runSlackImport reads export dir and writes safe local artifacts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-import-'));
    const exportDir = path.join(dir, 'export');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(path.join(exportDir, 'D_RAW_ADA'), { recursive: true });

    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify(fixture.users, null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify(fixture.dms, null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(exportDir, 'D_RAW_ADA', '2026-05-15.json'), JSON.stringify(fixture.messagesByConversation.D_RAW_ADA, null, 2));

    const result = runSlackImport({
        exportDir,
        outDir,
        dataDir: dir,
        selfUserIds: ['U_SELF_RAW'],
        progress: null,
        logger: { log() {} },
    });

    assert.equal(result.contacts.length, 1);
    assert.equal(result.messages.length, 2);

    const contacts = fs.readFileSync(path.join(outDir, 'contacts.json'), 'utf8');
    const messages = fs.readFileSync(path.join(outDir, 'messages', 'messages.json'), 'utf8');
    const serialized = contacts + messages;
    assert.equal(serialized.includes('U_ADA_RAW'), false);
    assert.equal(serialized.includes('D_RAW_ADA'), false);
    assert.equal(serialized.includes(exportDir), false);
});

test('[SlackImport] missing export progress error omits local path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-missing-'));
    const missing = path.join(dir, 'private-export');
    assert.throws(
        () => runSlackImport({ exportDir: missing, outDir: path.join(dir, 'out'), dataDir: dir, progress: null, logger: { log() {} } }),
        /Slack export directory was not found/
    );
});
```

**Step 2: Run test to verify failure**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: FAIL because `runSlackImport` is missing.

**Step 3: Implement directory loading and CLI**

Add to `sources/slack/import.js`:

```js
const P = require('../_shared/progress');
const DEFAULT_EXPORT_DIR = process.env.SLACK_EXPORT_DIR || path.join(__dirname, '../../data/slack/export');
const DEFAULT_OUT_DIR = process.env.SLACK_OUT_DIR || path.join(__dirname, '../../data/slack');
const DEFAULT_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function readJsonIfExists(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readConversationMessages(exportDir, conversations) {
    const messagesByConversation = {};
    for (const conv of conversations) {
        if (!conv || !conv.id) continue;
        const convDir = path.join(exportDir, String(conv.id));
        const files = fs.existsSync(convDir)
            ? fs.readdirSync(convDir).filter(name => name.endsWith('.json')).sort()
            : [];
        messagesByConversation[conv.id] = [];
        for (const file of files) {
            const rows = readJsonIfExists(path.join(convDir, file), []);
            if (Array.isArray(rows)) messagesByConversation[conv.id].push(...rows);
        }
    }
    return messagesByConversation;
}

function parseSelfUserIds(value) {
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function runSlackImport(options = {}) {
    const exportDir = options.exportDir || DEFAULT_EXPORT_DIR;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const progress = options.progress === undefined ? P : options.progress;
    const logger = options.logger || console;

    if (progress) progress.startProgress(dataDir, 'slack', { step: 'init', message: 'Reading Slack export…' });
    if (!fs.existsSync(exportDir) || !fs.statSync(exportDir).isDirectory()) {
        const err = new Error('Slack export directory was not found');
        if (progress) progress.failProgress(dataDir, 'slack', err);
        throw err;
    }

    const users = readJsonIfExists(path.join(exportDir, 'users.json'), []);
    const dms = readJsonIfExists(path.join(exportDir, 'dms.json'), []);
    const mpims = readJsonIfExists(path.join(exportDir, 'mpims.json'), []);
    const messagesByConversation = readConversationMessages(exportDir, [...dms, ...mpims]);

    if (progress) progress.updateProgress(dataDir, 'slack', { step: 'messages', message: 'Normalizing Slack DMs…' });
    const result = normalizeSlackExport({ users, dms, mpims, messagesByConversation }, {
        selfUserIds: options.selfUserIds || parseSelfUserIds(process.env.SLACK_SELF_USER_IDS),
    });

    fs.mkdirSync(path.join(outDir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(result.contacts, null, 2));
    fs.writeFileSync(path.join(outDir, 'messages', 'messages.json'), JSON.stringify(result.messages, null, 2));

    logger.log(`Saved ${result.contacts.length} Slack contacts`);
    logger.log(`Saved ${result.messages.length} Slack messages across ${result.conversations.length} conversations`);
    if (progress) {
        progress.finishProgress(dataDir, 'slack', {
            message: `Imported ${result.contacts.length} contacts and ${result.messages.length} messages.`,
            current: result.messages.length,
            total: result.messages.length,
            itemsProcessed: result.messages.length,
        });
    }
    return result;
}

if (require.main === module) {
    try {
        runSlackImport();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
```

Also export `runSlackImport`.

**Step 4: Run test to verify pass**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/slack/import.js tests/unit/slack-import.test.js
git commit -m "feat: add Slack export CLI"
```

---

### Task 3: Wire package script and unit suite

**Objective:** Make the importer discoverable through `npm run slack` and keep it in the default unit suite.

**Files:**
- Modify: `package.json`

**Step 1: Write failing check**

Run:

```bash
node - <<'NODE'
const pkg = require('./package.json');
if (pkg.scripts.slack !== 'node sources/slack/import.js') throw new Error('missing slack script');
if (!pkg.scripts.test.includes('tests/unit/slack-import.test.js')) throw new Error('unit suite missing slack import test');
NODE
```

Expected: FAIL because the script/test entry is missing.

**Step 2: Implement package changes**

In `package.json`:

- Add script near source import scripts:

```json
"slack": "node sources/slack/import.js"
```

- Add `tests/unit/slack-import.test.js` to the long `test` script near `tests/unit/discord-import.test.js`.

**Step 3: Run checks**

```bash
node - <<'NODE'
const pkg = require('./package.json');
if (pkg.scripts.slack !== 'node sources/slack/import.js') throw new Error('missing slack script');
if (!pkg.scripts.test.includes('tests/unit/slack-import.test.js')) throw new Error('unit suite missing slack import test');
NODE
node --test tests/unit/slack-import.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add package.json
git commit -m "chore: wire Slack importer script"
```

---

### Task 4: Verify merge compatibility and source-health answerability

**Objective:** Prove normalized Slack artifacts feed existing merge/source-health/retrieval surfaces without adding a new MCP tool.

**Files:**
- Modify: `tests/unit/merge.test.js` or create focused assertions in `tests/unit/slack-import.test.js`
- Modify only if needed: `crm/merge.js`, `crm/schema.js`, `crm/agent-source-health.js`, `scripts/minty-service-status.js`

**Step 1: Write failing integration-style unit test**

Add a focused test that writes normalized Slack artifacts into a temp `CRM_DATA_DIR`, runs merge helpers or `node crm/merge.js`, and asserts the unified output is safe. If current merge helpers are hard to import cleanly, prefer a small test-only-safe export instead of shelling out against real `data/`.

```js
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
    assert.equal(result.messages[0].source, 'slack');
    assert.equal(result.messages[0].chatName, 'Slack DM');
});
```

**Step 2: Run targeted tests**

```bash
node --test tests/unit/slack-import.test.js tests/unit/merge.test.js tests/unit/source-events.test.js tests/unit/agent-source-health.test.js
```

Expected: FAIL only if merge/source-health assumptions need small updates.

**Step 3: Minimal implementation if needed**

Expected current state should mostly work because:

- `crm/schema.js` already has `sources.slack`.
- `crm/merge.js` already has `loadSlack()` and `buildInteractions()` for `data/slack/messages/messages.json`.
- `crm/source-events.js` already canonicalizes Slack labels.
- `crm/agent-source-health.js` already includes Slack.
- `scripts/minty-mcp-server.js` already advertises Slack filters.

If any test exposes a mismatch, patch the smallest field-name compatibility issue. Do not expand the feature into Slack channel import.

**Step 4: Run targeted tests again**

```bash
node --test tests/unit/slack-import.test.js tests/unit/merge.test.js tests/unit/source-events.test.js tests/unit/agent-source-health.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/slack/import.js tests/unit/slack-import.test.js crm/merge.js crm/schema.js crm/agent-source-health.js scripts/minty-service-status.js
git commit -m "test: verify Slack importer trust surfaces"
```

---

### Task 5: Add privacy and non-network safety regression tests

**Objective:** Fail closed if the importer grows live Slack hooks or leaks private local/export details.

**Files:**
- Modify: `tests/unit/slack-import.test.js`
- Modify only if needed: `sources/slack/import.js`

**Step 1: Write failing safety tests**

Append:

```js
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

test('[SlackImport] output does not expose raw local paths after parse failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-slack-bad-json-'));
    const exportDir = path.join(dir, 'export');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'users.json'), '{bad json');

    assert.throws(
        () => runSlackImport({ exportDir, outDir: path.join(dir, 'out'), dataDir: dir, progress: null, logger: { log() {} } }),
        /Slack export JSON could not be parsed|Unexpected token/
    );
});
```

**Step 2: Run test to verify failure**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: FAIL if parse errors expose raw parser/path details or forbidden network hooks appear.

**Step 3: Patch implementation**

Wrap JSON parse errors in path-free errors. If needed, update `readJsonIfExists()`:

```js
function readJsonIfExists(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error('Slack export JSON could not be parsed');
    }
}
```

**Step 4: Run test to verify pass**

```bash
node --test tests/unit/slack-import.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/slack/import.js tests/unit/slack-import.test.js
git commit -m "test: harden Slack importer privacy boundaries"
```

---

### Task 6: Update docs and final verification

**Objective:** Document the local-only Slack import path and verify the repo stays green.

**Files:**
- Modify: `README.md` or `docs/HERMES_INTEGRATION.md`
- Modify: `ROADMAP.md` only if wording needs to mark Slack local export importer as started, not completed broadly.

**Step 1: Add concise docs**

Add a small local source note near other source/import docs:

```md
### Slack local export import

Minty can ingest Slack DMs/MPIMs from a local Slack export directory:

```bash
SLACK_EXPORT_DIR=<path-to-slack-export> npm run slack
npm run merge
npm run source-events
npm run network:search -- "who did I talk to on Slack about hiring"
```

This path is local-file-only. It does not use Slack API tokens, OAuth, webhooks, scraping, or message sending. Agent-facing results use the safe source label `slack` and omit raw Slack user ids, channel ids, emails, channel names, URLs, and local file paths.
```

If the doc already has a source list, add Slack as `local export DMs/MPIMs` rather than implying live sync.

**Step 2: Run verification**

```bash
node --test tests/unit/slack-import.test.js tests/unit/merge.test.js tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
npm test
```

Expected: PASS.

**Step 3: Check docs/privacy sanity**

```bash
git diff --check
python3 /root/.hermes/skills/software-development/writing-plans/scripts/check-markdown-fences.py docs/plans/2026-05-15-slack-export-importer.md
node - <<'NODE'
const fs = require('fs');
const text = fs.readFileSync('docs/plans/2026-05-15-slack-export-importer.md', 'utf8');
for (const forbidden of ['/root/.hermes/private', 'SLACK_BOT_TOKEN=', 'xoxb-', 'xoxp-']) {
  if (text.includes(forbidden)) throw new Error(`plan leaked forbidden token/path: ${forbidden}`);
}
NODE
```

Expected: PASS.

**Step 4: Commit**

```bash
git add README.md docs/HERMES_INTEGRATION.md ROADMAP.md docs/plans/2026-05-15-slack-export-importer.md
git commit -m "docs: document local Slack import path"
```

---

## Implementation notes

- Keep raw Slack export artifacts out of git. Tests must synthesize export directories in temp dirs.
- Do not store emails from Slack profiles in normalized `contacts.json`; identity matching by email is tempting but violates the agent/export privacy direction for this source unless a later plan designs a safe consent boundary.
- Existing `loadSlack()` supports email, but this importer should set `email: null` in normalized output. That keeps source depth useful without broadening direct-contact exposure.
- If builders discover existing Slack raw artifacts in local `data/`, do not inspect or commit them. Use synthetic fixtures only.
- If users need channel/community signals later, make that a separate plan with stronger group/channel redaction, source-health answerability rules, and UI review affordances.

## Builder handoff summary

This is the next source-depth slice after Discord. It converts an already-advertised but currently unreal Slack source into real local evidence while preserving the current trust contract: local-first, no provider calls, no sends, redacted agent envelopes, and source-backed retrieval.
