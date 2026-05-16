# Discord Export Importer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a safe, local-file-only Discord export importer so Minty can ingest high-signal DM/direct-group relationship evidence without live Discord API access or raw dump exposure.

**Architecture:** Start with pure parsing helpers in `sources/discord/import.js`, then wire the importer into existing local source conventions: `data/discord/contacts.json`, `data/discord/messages.json`, `crm/merge.js`, `crm/schema.js`, source health/status surfaces, and agent-safe source labels. Keep this intentionally export-file-only: no bot token, OAuth, gateway, scraping, sends, or background live sync.

**Tech Stack:** Plain Node.js CommonJS, Node built-in `fs/path/crypto`, existing `sources/_shared/progress`, existing `crm/merge.js`, Node built-in test runner.

---

## Product context

Minty has recently landed the trust layer agents need: `source_health`, answerability gates, MCP citation preservation, intro paths, meeting prep, goal next actions, GBrain export hardening, and memory-refresh diagnostics. The next strategic gap is source depth: Hermes can only activate relationship memory that Minty has actually ingested. Discord DMs/direct groups are explicitly on the v0.4 roadmap, but live Discord integration would cross token/API/privacy boundaries. A local export importer is the smallest safe wedge.

This plan implements GitHub issue #232. It should not create another recommendation surface. It should make existing surfaces (`search_network`, `person_context`, `workflow_brief`, `source_health`) better by adding a new evidence-bearing source.

## Acceptance criteria

- `npm run discord` reads a local JSON export path from `DISCORD_EXPORT_FILE` and writes only local artifacts under `data/discord/` or `DISCORD_OUT_DIR`.
- Supported input is synthetic/export-style JSON, not live Discord API responses that require credentials.
- DM and small direct-group conversations produce contacts and message threads with safe source labels.
- Malformed rows are skipped with diagnostics; one bad message does not fail the whole import.
- `crm/merge.js` includes Discord contacts and interactions in unified data.
- `source_health` / service status can report Discord as a configured/file source when artifacts exist.
- Agent/MCP/GBrain-safe surfaces use `discord` as a canonical source label but never expose raw Discord user ids, channel ids, guild ids, usernames/discriminators, invite URLs, message ids, or raw private dump paths.
- Tests use synthetic names/content only and no real Discord export files.

## Non-goals

- No Discord API, bot token, OAuth, gateway, webhooks, server join, scrape, or message send.
- No background daemon/live sync for Discord in this slice.
- No committing real Discord exports or generated private data.
- No new MCP tool.
- No raw Discord ids/handles in agent envelopes; local raw artifacts may keep source ids only for local merge/debugging.

---

### Task 1: Add pure Discord export parser tests

**Objective:** Lock down a small, source-local parser before writing filesystem or merge code.

**Files:**
- Create: `tests/unit/discord-import.test.js`
- Create: `sources/discord/import.js`

**Step 1: Write failing tests**

Create `tests/unit/discord-import.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeDiscordExport,
    safeDiscordUserRef,
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
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/discord-import.test.js
```

Expected: FAIL because `sources/discord/import.js` does not exist or does not export the parser helpers.

**Step 3: Write minimal parser implementation**

Create `sources/discord/import.js` with pure helpers only:

```js
'use strict';

const crypto = require('node:crypto');

function safeDiscordUserRef(id) {
    return 'discord_user_' + crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 12);
}

function safeDiscordThreadRef(id) {
    return 'discord_thread_' + crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 12);
}

function parseIso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function displayName(user) {
    if (!user || typeof user !== 'object') return null;
    const raw = user.global_name || user.displayName || user.name || user.username || null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function normalizeDiscordExport(data, options = {}) {
    const users = new Map();
    for (const user of data?.users || []) {
        if (user && user.id) users.set(String(user.id), user);
    }

    const selfIds = new Set((options.selfUserIds || data?.selfUserIds || []).map(String));
    const contactsByRef = new Map();
    const threads = [];
    const messages = [];
    const diagnostics = { skippedConversations: 0, skippedMessages: 0, skippedParticipants: 0 };

    for (const conv of data?.conversations || data?.channels || []) {
        const type = conv.type === 'group_dm' || conv.type === 'direct_group' ? 'group_dm' : conv.type === 'dm' ? 'dm' : null;
        if (!type || !conv.id) {
            diagnostics.skippedConversations++;
            continue;
        }

        const participantIds = (conv.participants || conv.recipients || []).map(p => String(p.id || p)).filter(Boolean);
        const participantRefs = [];
        for (const participantId of participantIds) {
            if (selfIds.has(participantId)) continue;
            const name = displayName(users.get(participantId));
            if (!name) {
                diagnostics.skippedParticipants++;
                continue;
            }
            const ref = safeDiscordUserRef(participantId);
            participantRefs.push(ref);
            if (!contactsByRef.has(ref)) {
                contactsByRef.set(ref, {
                    id: ref,
                    source: 'discord',
                    name,
                    discordRef: ref,
                    firstSeen: null,
                    lastMessageAt: null,
                    messageCount: 0,
                });
            }
        }

        const thread = {
            id: safeDiscordThreadRef(conv.id),
            source: 'discord',
            type,
            chatName: type === 'group_dm' ? 'Discord direct group' : 'Discord DM',
            participantRefs,
            participantCount: participantIds.length,
            messages: [],
        };

        for (const msg of conv.messages || []) {
            const timestamp = parseIso(msg.timestamp || msg.date || msg.createdAt);
            const authorId = msg.authorId || msg.author_id || msg.author?.id;
            if (!timestamp || !authorId) {
                diagnostics.skippedMessages++;
                continue;
            }
            const from = selfIds.has(String(authorId)) ? 'me' : safeDiscordUserRef(authorId);
            const body = typeof msg.content === 'string' ? msg.content : '';
            const normalized = {
                id: safeDiscordThreadRef(`${conv.id}:${msg.id || timestamp}:${authorId}`),
                source: 'discord',
                timestamp,
                from,
                to: from === 'me' && participantRefs.length === 1 ? participantRefs[0] : 'me',
                body,
                type: thread.type,
                chatId: thread.id,
                chatName: thread.chatName,
            };
            thread.messages.push(normalized);
            messages.push(normalized);
            if (from !== 'me' && contactsByRef.has(from)) {
                const contact = contactsByRef.get(from);
                contact.messageCount += 1;
                contact.firstSeen = contact.firstSeen || timestamp;
                contact.lastMessageAt = timestamp;
            }
        }

        threads.push(thread);
    }

    return { contacts: Array.from(contactsByRef.values()), threads, messages, diagnostics };
}

module.exports = {
    normalizeDiscordExport,
    safeDiscordUserRef,
    safeDiscordThreadRef,
};
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/discord-import.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/discord/import.js tests/unit/discord-import.test.js
git commit -m "feat: add Discord export parser"
```

---

### Task 2: Add local-file CLI and package script

**Objective:** Make the importer usable as `npm run discord` without touching network or real data in tests.

**Files:**
- Modify: `sources/discord/import.js`
- Modify: `package.json`
- Test: `tests/unit/discord-import.test.js`

**Step 1: Add failing filesystem test**

Append to `tests/unit/discord-import.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDiscordImport } = require('../../sources/discord/import');

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
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/discord-import.test.js
```

Expected: FAIL because `runDiscordImport` is not exported.

**Step 3: Implement CLI wrapper**

In `sources/discord/import.js`, add `fs`, `path`, progress wiring, `runDiscordImport`, and `require.main` guard. Keep the pure helpers from Task 1.

```js
const fs = require('node:fs');
const path = require('node:path');
const P = require('../_shared/progress');

const DEFAULT_EXPORT_FILE = process.env.DISCORD_EXPORT_FILE || path.join(__dirname, '../../data/discord/export/export.json');
const DEFAULT_OUT_DIR = process.env.DISCORD_OUT_DIR || path.join(__dirname, '../../data/discord');
const DEFAULT_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function parseSelfUserIds(value) {
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function runDiscordImport(options = {}) {
    const exportFile = options.exportFile || DEFAULT_EXPORT_FILE;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const progress = options.progress === undefined ? P : options.progress;
    const logger = options.logger || console;

    if (progress) progress.startProgress(dataDir, 'discord', { step: 'init', message: 'Reading Discord export…' });
    if (!fs.existsSync(exportFile)) {
        const err = new Error(`Discord export not found: ${exportFile}`);
        if (progress) progress.failProgress(dataDir, 'discord', err);
        throw err;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    } catch (err) {
        if (progress) progress.failProgress(dataDir, 'discord', new Error('Discord export JSON could not be parsed'));
        throw err;
    }

    if (progress) progress.updateProgress(dataDir, 'discord', { step: 'messages', message: 'Normalizing Discord DMs…' });
    const result = normalizeDiscordExport(parsed, {
        selfUserIds: options.selfUserIds || parseSelfUserIds(process.env.DISCORD_SELF_USER_IDS),
    });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(result.contacts, null, 2));
    fs.writeFileSync(path.join(outDir, 'messages.json'), JSON.stringify(result.threads, null, 2));

    logger.log(`Saved ${result.contacts.length} Discord contacts`);
    logger.log(`Saved ${result.messages.length} Discord messages across ${result.threads.length} threads`);
    if (progress) {
        progress.finishProgress(dataDir, 'discord', {
            message: `Imported ${result.contacts.length} contacts and ${result.messages.length} messages.`,
            current: result.messages.length,
            total: result.messages.length,
            itemsProcessed: result.messages.length,
        });
    }
    return result;
}

if (require.main === module) {
    try { runDiscordImport(); }
    catch (err) { console.error(err.message); process.exit(1); }
}
```

Export the new helpers:

```js
module.exports = {
    normalizeDiscordExport,
    safeDiscordUserRef,
    safeDiscordThreadRef,
    runDiscordImport,
};
```

In `package.json`, add a script near other source scripts:

```json
"discord": "node sources/discord/import.js",
```

**Step 4: Run tests and a synthetic smoke**

Run:

```bash
node --test tests/unit/discord-import.test.js
node -e "const pkg=require('./package.json'); if(pkg.scripts.discord!=='node sources/discord/import.js') process.exit(1)"
```

Expected: PASS.

**Step 5: Commit**

```bash
git add sources/discord/import.js tests/unit/discord-import.test.js package.json
git commit -m "feat: add Discord import CLI"
```

---

### Task 3: Merge Discord contacts and interactions into unified data

**Objective:** Make imported Discord evidence available to existing retrieval/indexing without a new MCP tool.

**Files:**
- Modify: `crm/schema.js`
- Modify: `crm/merge.js`
- Test: `tests/unit/merge.test.js` or create focused `tests/unit/discord-merge.test.js` if `merge.test.js` is already too broad.

**Step 1: Add failing merge test**

Add a focused test that uses exported merge helpers if available in `tests/unit/merge.test.js`; if not, first export `loadDiscord` and `buildInteractions` for tests following existing merge test patterns.

```js
test('[Merge] Discord contacts and messages become unified relationship evidence', () => {
    const { ContactIndex } = require('../../crm/utils');
    const { loadDiscord, buildInteractions } = require('../../crm/merge');

    const index = new ContactIndex();
    loadDiscord(index, [
        {
            id: 'discord_user_safe_ada',
            source: 'discord',
            name: 'Ada Example',
            discordRef: 'discord_user_safe_ada',
            messageCount: 2,
            lastMessageAt: '2026-05-02T11:00:00.000Z',
        },
    ]);

    const contacts = Object.values(index.byId);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, 'Ada Example');
    assert.equal(contacts[0].sources.discord.id, 'discord_user_safe_ada');

    const interactions = buildInteractions({
        discordThreads: [
            {
                id: 'discord_thread_safe_1',
                chatName: 'Discord DM',
                type: 'dm',
                messages: [
                    {
                        id: 'discord_msg_safe_1',
                        timestamp: '2026-05-02T11:00:00.000Z',
                        from: 'discord_user_safe_ada',
                        to: 'me',
                        body: 'local memory topic',
                    },
                ],
            },
        ],
    });

    assert.equal(interactions.some(i => i.source === 'discord' && i.body === 'local memory topic'), true);
});
```

If current `buildInteractions()` does not accept injected fixtures, add an options argument in the minimal way:

```js
function buildInteractions(options = {}) {
    // ...
    const discordThreads = options.discordThreads || load(path.join(DATA, 'discord/messages.json'));
}
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/merge.test.js --test-name-pattern='Discord'
```

Expected: FAIL because schema/merge do not include Discord.

**Step 3: Implement merge support**

In `crm/schema.js`, add:

```js
discord: null,          // { id, name, discordRef, messageCount, lastMessageAt }
```

In `crm/merge.js`, add stable-id helper near Slack helpers:

```js
function discordStableId(id) {
    return id ? `discord_${String(id).replace(/[^a-zA-Z0-9_:-]/g, '_')}` : null;
}
```

Add `loadDiscord(index, providedContacts = null)` near `loadSlack`:

```js
function loadDiscord(index, providedContacts = null) {
    const contacts = providedContacts || load(path.join(DATA, 'discord/contacts.json'));
    if (!contacts) { console.log('discord/contacts.json not found, skipping'); return; }
    let merged = 0;
    for (const c of contacts) {
        if (!c || typeof c !== 'object') continue;
        const id = c.discordRef || c.id;
        const name = typeof c.name === 'string' ? c.name.trim() : '';
        if (!id || !name) continue;
        const stableId = discordStableId(id);
        const contact = index.upsert([], [], name, stableId);
        contact.sources.discord = {
            id: String(id),
            name,
            discordRef: String(id),
            messageCount: Number.isFinite(Number(c.messageCount)) ? Number(c.messageCount) : 0,
            lastMessageAt: c.lastMessageAt || null,
        };
        if (!contact.name && name) contact.name = name;
        merged++;
    }
    console.log(`Merged ${merged} Discord contacts`);
}
```

Call `loadDiscord(index)` in the main merge flow next to Slack/source loaders.

In `buildInteractions(options = {})`, add Discord after Slack or before sorting:

```js
const discordThreads = options.discordThreads || load(path.join(DATA, 'discord/messages.json'));
if (discordThreads) {
    for (const thread of discordThreads) {
        for (const m of thread.messages || []) {
            interactions.push(createInteraction('discord', {
                ...m,
                chatId: thread.id,
                chatName: thread.chatName || 'Discord conversation',
                type: thread.type || 'dm',
            }));
        }
    }
}
```

Export helpers for tests without changing CLI behavior:

```js
module.exports = {
    // existing exports...
    loadDiscord,
    buildInteractions,
};
```

**Step 4: Run focused tests**

Run:

```bash
node --test tests/unit/merge.test.js --test-name-pattern='Discord'
node --test tests/unit/discord-import.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/schema.js crm/merge.js tests/unit/merge.test.js tests/unit/discord-import.test.js
git commit -m "feat: merge Discord export evidence"
```

---

### Task 4: Add Discord to source-health and safe source-label contracts

**Objective:** Let Hermes preflight Discord source readiness and show safe provenance labels without parsing free-form text.

**Files:**
- Modify: `crm/source-events.js`
- Modify: `scripts/minty-service-status.js`
- Modify: `scripts/minty-mcp-server.js`
- Modify: `crm/ui.html.js` only if source cards/status labels are generated from a static source list there
- Test: `tests/unit/agent-source-health.test.js`
- Test: `tests/unit/minty-mcp-server.test.js`
- Test: `tests/unit/source-events.test.js`

**Step 1: Add failing tests**

In `tests/unit/source-events.test.js`, add:

```js
test('[SourceEvents] canonicalizes Discord as a safe source label', () => {
    const { canonicalSafeSource } = require('../../crm/source-events');
    assert.equal(canonicalSafeSource('discord'), 'discord');
    assert.equal(canonicalSafeSource('Discord DM'), 'discord');
});
```

In `tests/unit/minty-mcp-server.test.js`, update schema/source-list tests so tool descriptions mention `discord` for `search_network`, `person_context`, `workflow_brief`, and `source_health`.

In `tests/unit/agent-source-health.test.js`, add a source-health fixture with `syncState.discord` and assert Discord is returned as a safe source row when requested.

**Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js --test-name-pattern='Discord|source_health|tools/list'
```

Expected: FAIL because Discord is not yet a canonical source in all contracts.

**Step 3: Implement source contracts**

In `crm/source-events.js`, add Discord to `SAFE_SOURCE_LABELS`:

```js
discord: 'discord',
discorddm: 'discord',
discorddirect: 'discord',
```

In `scripts/minty-service-status.js`, add `discord` to `SUPPORTED_SOURCE_NAMES`:

```js
'whatsapp', 'email', 'googleContacts', 'linkedin', 'telegram', 'sms', 'calendar', 'discord',
```

In `scripts/minty-mcp-server.js`, update source filter descriptions from:

```text
telegram, whatsapp, linkedin, slack, email, sms, googlecontacts
```

to:

```text
telegram, whatsapp, linkedin, discord, slack, email, sms, googlecontacts
```

If `crm/ui.html.js` has static source labels/cards, add a minimal Discord label/card only if current UI source cards require it for readiness visibility. Keep copy clear: “Import local Discord DM/direct-group exports. No live Discord connection.”

**Step 4: Run focused tests**

Run:

```bash
node --test tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js --test-name-pattern='Discord|source_health|tools/list'
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/source-events.js scripts/minty-service-status.js scripts/minty-mcp-server.js crm/ui.html.js tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose Discord source readiness"
```

---

### Task 5: Add docs, privacy regression, and full verification

**Objective:** Make the new source safe for future users/builders and prevent accidental live-API creep.

**Files:**
- Modify: `README.md` or `docs/HERMES_INTEGRATION.md` if source setup docs live there
- Modify: `package.json` test script only if the project manually enumerates unit tests
- Test: `tests/unit/discord-import.test.js`
- Optional create: `tests/fixtures/discord-export.json` if the builder wants a reusable synthetic smoke fixture

**Step 1: Add privacy/safety tests**

Append to `tests/unit/discord-import.test.js`:

```js
test('[DiscordImport] importer module has no live Discord provider hooks', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'sources', 'discord', 'import.js'), 'utf8');

    assert.equal(source.includes('discord.com/api'), false);
    assert.equal(source.includes('Authorization'), false);
    assert.equal(source.includes('BOT_TOKEN'), false);
    assert.equal(source.includes('WebSocket'), false);
});
```

If `package.json` has an explicit `npm test` file list, add `tests/unit/discord-import.test.js` to it.

**Step 2: Add docs**

Add a short docs section near source/import setup:

```md
### Discord export import

Minty supports a local-file Discord import for DMs/direct groups:

```bash
DISCORD_EXPORT_FILE=<path-to-local-export.json> npm run discord
npm run merge
```

This importer is file-only. It does not connect to Discord, use bot tokens, join servers, scrape channels, or send messages. Agent-facing output uses the safe source label `discord` and redacts raw Discord user/channel/message ids.
```

If adding a fixture smoke, keep it synthetic:

```bash
DISCORD_EXPORT_FILE=tests/fixtures/discord-export.json DISCORD_OUT_DIR=$(mktemp -d) npm run discord
```

**Step 3: Run verification**

Run:

```bash
node --test tests/unit/discord-import.test.js
node --test tests/unit/merge.test.js --test-name-pattern='Discord'
node --test tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js --test-name-pattern='Discord|source_health|tools/list'
npm test
```

Expected: all pass.

**Step 4: Manual no-network smoke**

Run with a temp synthetic export:

```bash
node - <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-discord-smoke-'));
const exportFile = path.join(dir, 'export.json');
fs.writeFileSync(exportFile, JSON.stringify({
  users: [
    { id: 'self', global_name: 'Self Fixture' },
    { id: 'friend', global_name: 'Friend Fixture' }
  ],
  conversations: [{
    id: 'dm1',
    type: 'dm',
    participants: ['self', 'friend'],
    messages: [{ id: 'm1', authorId: 'friend', timestamp: '2026-05-01T10:00:00.000Z', content: 'hello' }]
  }]
}));
process.env.DISCORD_EXPORT_FILE = exportFile;
process.env.DISCORD_OUT_DIR = path.join(dir, 'out');
process.env.DISCORD_SELF_USER_IDS = 'self';
require('./sources/discord/import').runDiscordImport({ logger: { log() {}, error() {} } });
const output = fs.readFileSync(path.join(dir, 'out', 'contacts.json'), 'utf8') + fs.readFileSync(path.join(dir, 'out', 'messages.json'), 'utf8');
if (output.includes('friend') || output.includes('dm1') || output.includes('m1')) process.exit(1);
console.log('discord smoke ok');
NODE
```

Expected: `discord smoke ok`.

**Step 5: Commit**

```bash
git add README.md docs/HERMES_INTEGRATION.md package.json tests/unit/discord-import.test.js tests/fixtures/discord-export.json
git commit -m "docs: document Discord export import"
```

---

## Final verification checklist

- [ ] `node --test tests/unit/discord-import.test.js` passes.
- [ ] `node --test tests/unit/merge.test.js --test-name-pattern='Discord'` passes.
- [ ] `node --test tests/unit/source-events.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js --test-name-pattern='Discord|source_health|tools/list'` passes.
- [ ] `npm test` passes.
- [ ] `npm run discord` works against a synthetic local export and performs no network access.
- [ ] Serialized agent-facing output contains `discord` as a source label but no raw Discord ids, handles, invite URLs, message ids, token names, or private paths.
- [ ] No live Discord API/token/webhook/gateway code was added.

## Builder notes

- If the real export shape differs, keep parser inputs flexible but tests synthetic. Add one small adapter at a time; do not import broad raw dumps into the repo.
- If merge helpers are not currently exported cleanly, prefer tiny test-only-safe exports over shelling out to mutate real `data/`.
- If Discord source health requires artifacts before sync-state exists, treat `data/discord/messages.json` presence plus `sync-state.discord.lastSyncAt` as configured/evidence-bearing; fail empty when neither exists.
- Keep every new source field behind the same trust contract already used by Slack/Telegram: local raw artifacts may contain ids for debugging, but agent envelopes must expose safe refs, counts, citations, confidence, and freshness only.
