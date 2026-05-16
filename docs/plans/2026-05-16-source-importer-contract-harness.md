# Source Importer Contract Harness Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add one shared regression harness that proves every local-file source importer preserves Minty's agent trust contract: local-only reads, safe normalized artifacts, merge compatibility, source-health visibility, and no raw identifiers/details in serialized outputs.

**Architecture:** Keep this as tests-first quality infrastructure, not a new product surface. Create `tests/unit/source-importer-contract.test.js` with a small registry of importer modules and fixture builders for Discord, Slack, and iMessage once the iMessage importer lands. The harness should call the importers' existing pure/run helpers, inspect normalized artifacts, exercise `crm/merge.js` and `crm/agent-source-health.js`, and assert privacy/leak boundaries with source-specific forbidden sentinels.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, Node built-ins (`fs`, `os`, `path`, `assert`), existing importer modules, existing `ContactIndex`, `loadDiscord` / `loadSlack` / `loadIMessage`, and `buildAgentSourceHealth`. No new dependencies, no provider calls, no runtime LLM calls.

---

## Product context

Minty's trust stack is now broad enough for Hermes/OpenClaw to ask useful relationship questions, and recent builder work has shifted into source depth: Discord, Slack, and iMessage local importers. The risk has changed. The next failure mode is not “does this one importer parse a fixture?”; it is drift across importers where one new source is added to `package.json` and `merge.js` but not source health, or one importer redacts IDs but still leaks local paths in progress failures.

This plan closes that gap without adding CRM busywork or another MCP tool. It makes source depth safer by turning Minty's importer trust contract into a reusable test harness builders can extend for every new local source.

## Current-state evidence

- `docs/plans/2026-05-15-discord-export-importer.md` and `docs/plans/2026-05-15-slack-export-importer.md` repeated the same acceptance criteria: local-file-only, no provider hooks, safe normalized contacts/messages, merge compatibility, source-health visibility, and privacy redaction.
- Current source-depth work is staged on `feat/imessage-local-importer` for issue #237 with `sources/imessage/import.js`, `tests/unit/imessage-import.test.js`, `crm/merge.js`, `crm/schema.js`, `crm/agent-source-health.js`, `scripts/minty-service-status.js`, and `package.json` changes.
- The repeated assertions still live inside per-source tests. That is fine for source-specific parsing, but weak for future sources because there is no single place that says “a Minty importer is safe only if it satisfies all of these invariants.”

## Acceptance criteria

- A new `tests/unit/source-importer-contract.test.js` runs with `node --test` and is added to `npm test` after the existing importer tests.
- The harness covers `discord` and `slack` immediately, and covers `imessage` once issue #237's importer module exists on the branch being implemented.
- For each registered source, the contract proves:
  - the run helper writes normalized local artifacts under a temp output dir only;
  - normalized contacts/messages use the canonical source key;
  - serialized normalized artifacts omit raw source IDs, handles, direct contact details, URLs, local/private paths, and secret-shaped values;
  - artifacts can be loaded into `ContactIndex` through the source's `crm/merge.js` loader;
  - interactions produced by `buildInteractions()` retain the canonical source key;
  - `buildAgentSourceHealth()` can report the source as evidence-bearing using synthetic contacts/interactions/sync state;
  - importer module source text lacks live provider/send hooks for that source.
- Source-specific parser edge cases stay in per-source tests; the shared harness only enforces the cross-source Minty contract.
- No real exports, real contact data, host-specific absolute paths, tokens, Apple/Slack/Discord provider credentials, or raw message databases are read or committed.

## Non-goals

- No new source importer.
- No new MCP tool, CLI command, UI, daemon behavior, or GBrain export change.
- No live Slack/Discord/Apple/iCloud access, scraping, OAuth, bot tokens, webhooks, or sends.
- No generic plugin API yet; this is a narrow test harness for the importers Minty already has.
- No broad refactor of `crm/merge.js`. Extract helpers only if the contract test cannot stay readable.

---

### Task 1: Add the contract test skeleton and registry

**Objective:** Create a shared test file with an explicit importer registry and skip iMessage until the module exists.

**Files:**
- Create: `tests/unit/source-importer-contract.test.js`
- Later modify: `package.json`

**Step 1: Write failing skeleton test**

Create `tests/unit/source-importer-contract.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ContactIndex } = require('../../crm/utils');
const merge = require('../../crm/merge');
const { buildAgentSourceHealth } = require('../../crm/agent-source-health');

function moduleExists(relativePath) {
    return fs.existsSync(path.join(__dirname, '../..', relativePath));
}

function tmpDir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `minty-importer-contract-${label}-`));
}

const REGISTRY = [
    {
        source: 'discord',
        modulePath: 'sources/discord/import.js',
        testName: 'Discord',
    },
    {
        source: 'slack',
        modulePath: 'sources/slack/import.js',
        testName: 'Slack',
    },
    {
        source: 'imessage',
        modulePath: 'sources/imessage/import.js',
        testName: 'iMessage',
    },
];

test('[SourceImporterContract] registry points at existing modules or known in-flight modules', () => {
    const missing = REGISTRY
        .filter(row => row.source !== 'imessage')
        .filter(row => !moduleExists(row.modulePath));

    assert.deepEqual(missing, []);
});
```

**Step 2: Run test to verify the skeleton passes**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js
```

Expected: PASS. This task creates the file and establishes the registry without asserting final behavior yet.

**Step 3: Commit**

```bash
git add tests/unit/source-importer-contract.test.js
git commit -m "test: add source importer contract skeleton"
```

---

### Task 2: Add shared privacy and module-hook assertions

**Objective:** Enforce cross-source privacy and no-live-provider invariants in one place.

**Files:**
- Modify: `tests/unit/source-importer-contract.test.js`

**Step 1: Write failing tests/helpers**

Append these helpers below the registry:

```js
function assertSerializedSafe(source, value, forbidden) {
    const serialized = JSON.stringify(value);
    for (const sentinel of forbidden) {
        assert.equal(serialized.includes(sentinel), false, `${source} leaked ${sentinel}`);
    }
    assert.equal(serialized.includes('https://'), false, `${source} leaked URL`);
    assert.equal(serialized.includes('file://'), false, `${source} leaked file URL`);
    assert.equal(serialized.includes('Bearer '), false, `${source} leaked bearer token`);
    assert.equal(serialized.includes('api_key'), false, `${source} leaked api key marker`);
}

function assertNoLiveProviderHooks(source, modulePath, forbiddenHooks) {
    const text = fs.readFileSync(path.join(__dirname, '../..', modulePath), 'utf8');
    for (const hook of forbiddenHooks) {
        assert.equal(text.includes(hook), false, `${source} importer contains live hook ${hook}`);
    }
}
```

Then add a placeholder test to prove helpers are called:

```js
test('[SourceImporterContract] helper catches forbidden serialized sentinels', () => {
    assert.throws(() => assertSerializedSafe('fixture', { value: 'RAW_SECRET' }, ['RAW_SECRET']));
    assert.doesNotThrow(() => assertSerializedSafe('fixture', { value: '[redacted]' }, ['RAW_SECRET']));
});
```

**Step 2: Run focused test**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js --test-name-pattern='helper catches'
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tests/unit/source-importer-contract.test.js
git commit -m "test: add importer privacy contract helpers"
```

---

### Task 3: Register Discord in the contract harness

**Objective:** Prove the existing Discord importer satisfies the shared contract without duplicating parser edge-case tests.

**Files:**
- Modify: `tests/unit/source-importer-contract.test.js`

**Step 1: Add Discord fixture builder and contract row**

Add this helper:

```js
function writeDiscordFixture(root) {
    const exportFile = path.join(root, 'discord-export.json');
    const outDir = path.join(root, 'discord-out');
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
                content: 'Discussed local memory via ada' + '@' + 'example.test and https://private.example/path token abc123',
            }],
        }],
    };
    fs.writeFileSync(exportFile, JSON.stringify(fixture, null, 2));
    return { exportFile, outDir };
}
```

Update the Discord registry row:

```js
{
    source: 'discord',
    modulePath: 'sources/discord/import.js',
    testName: 'Discord',
    forbidden: ['RAW_ADA_DISCORD', 'RAW_DISCORD_CHANNEL', 'RAW_DISCORD_MESSAGE', 'ada@example.test', 'private.example', 'token abc123'],
    forbiddenHooks: ['DISCORD_BOT_TOKEN', 'discord.com/api', 'GatewayIntentBits', 'sendMessage', 'node-fetch', 'axios'],
    run(root) {
        const { runDiscordImport } = require('../../sources/discord/import');
        const { exportFile, outDir } = writeDiscordFixture(root);
        return runDiscordImport({ exportFile, outDir, dataDir: root, progress: null, logger: { log() {} } });
    },
    load(index, contacts) {
        merge.loadDiscord(index, contacts);
    },
    interactions(result) {
        return merge.buildInteractions({ discordMessages: result.messages });
    },
},
```

**Step 2: Add the shared contract test loop**

Append:

```js
for (const row of REGISTRY.filter(r => r.run)) {
    test(`[SourceImporterContract] ${row.testName} satisfies local importer trust contract`, () => {
        const root = tmpDir(row.source);
        const result = row.run(root);

        assert.equal(result.source, row.source);
        assert.ok(Array.isArray(result.contacts));
        assert.ok(result.contacts.length > 0);
        assert.ok(Array.isArray(result.messages));
        assert.ok(result.messages.length > 0);
        assert.ok(result.contacts.every(c => c.source === row.source));
        assert.ok(result.messages.every(m => m.source === row.source));
        assertSerializedSafe(row.source, result, row.forbidden);
        assertNoLiveProviderHooks(row.source, row.modulePath, row.forbiddenHooks);

        const index = new ContactIndex();
        const originalLog = console.log;
        try {
            console.log = () => {};
            row.load(index, result.contacts);
        } finally {
            console.log = originalLog;
        }
        assert.ok(index.contacts.length > 0, `${row.source} should load contacts into ContactIndex`);

        const interactions = row.interactions(result);
        assert.ok(interactions.some(i => i.source === row.source), `${row.source} should produce source-keyed interactions`);

        const health = buildAgentSourceHealth({
            contacts: index.contacts,
            interactions,
            contactEvidence: [],
            sourceEvents: [],
            syncState: { [row.source]: { lastSyncAt: '2026-05-16T00:00:00.000Z' } },
        }, { source: row.source, now: '2026-05-16T01:00:00.000Z' });

        assert.equal(health.status, 'ok');
        assert.equal(health.sources.length, 1);
        assert.equal(health.sources[0].source, row.source);
        assert.equal(health.sources[0].evidenceBearing, true);
        assert.equal(health.sources[0].answerable, true);
    });
}
```

**Step 3: Run focused test**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js --test-name-pattern='Discord satisfies'
```

Expected: PASS. If it fails because `runDiscordImport()` or `loadDiscord()` is not exported, export the already-existing function from its module rather than duplicating code in the test.

**Step 4: Commit**

```bash
git add tests/unit/source-importer-contract.test.js sources/discord/import.js crm/merge.js
git commit -m "test: enforce Discord importer trust contract"
```

---

### Task 4: Register Slack in the contract harness

**Objective:** Prove the Slack local export importer satisfies the same contract as Discord.

**Files:**
- Modify: `tests/unit/source-importer-contract.test.js`

**Step 1: Add Slack fixture builder**

Add:

```js
function writeSlackFixture(root) {
    const exportDir = path.join(root, 'slack-export');
    const outDir = path.join(root, 'slack-out');
    fs.mkdirSync(path.join(exportDir, 'D_RAW_SLACK_ADA'), { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'users.json'), JSON.stringify([
        { id: 'U_RAW_SELF_SLACK', name: 'self', real_name: 'Fixture Self' },
        { id: 'U_RAW_ADA_SLACK', name: 'ada_fixture', real_name: 'Ada Example', profile: { title: 'Founder', email: 'ada' + '@' + 'example.test' } },
    ], null, 2));
    fs.writeFileSync(path.join(exportDir, 'dms.json'), JSON.stringify([
        { id: 'D_RAW_SLACK_ADA', members: ['U_RAW_SELF_SLACK', 'U_RAW_ADA_SLACK'] },
    ], null, 2));
    fs.writeFileSync(path.join(exportDir, 'mpims.json'), JSON.stringify([], null, 2));
    fs.writeFileSync(path.join(exportDir, 'D_RAW_SLACK_ADA', '2026-05-15.json'), JSON.stringify([
        { type: 'message', user: 'U_RAW_ADA_SLACK', ts: '1780000000.000100', text: 'Slack memory via ada' + '@' + 'example.test at https://private.example token abc123' },
    ], null, 2));
    return { exportDir, outDir };
}
```

Update the Slack registry row:

```js
{
    source: 'slack',
    modulePath: 'sources/slack/import.js',
    testName: 'Slack',
    forbidden: ['U_RAW_ADA_SLACK', 'D_RAW_SLACK_ADA', 'ada@example.test', 'private.example', 'token abc123'],
    forbiddenHooks: ['SLACK_BOT_TOKEN', 'SLACK_USER_TOKEN', 'https://slack.com/api', 'chat.postMessage', 'conversations.history', '@slack/web-api', 'node-fetch', 'axios'],
    run(root) {
        const { runSlackImport } = require('../../sources/slack/import');
        const { exportDir, outDir } = writeSlackFixture(root);
        return runSlackImport({ exportDir, outDir, dataDir: root, selfUserIds: ['U_RAW_SELF_SLACK'], progress: null, logger: { log() {} } });
    },
    load(index, contacts) {
        merge.loadSlack(index, contacts);
    },
    interactions(result) {
        return merge.buildInteractions({ slackMessages: result.messages });
    },
},
```

**Step 2: Run focused test**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js --test-name-pattern='Slack satisfies'
```

Expected: PASS.

**Step 3: Commit**

```bash
git add tests/unit/source-importer-contract.test.js
git commit -m "test: enforce Slack importer trust contract"
```

---

### Task 5: Register iMessage after issue #237 lands

**Objective:** Make the iMessage source-depth work prove the same trust contract as Discord and Slack.

**Files:**
- Modify: `tests/unit/source-importer-contract.test.js`
- Possibly modify only if missing exports: `sources/imessage/import.js`, `crm/merge.js`

**Step 1: Add iMessage fixture builder**

Only do this after `sources/imessage/import.js`, `merge.loadIMessage`, and `merge.buildInteractions({ imessageMessages })` exist on the implementation branch.

```js
function writeIMessageFixture(root) {
    const exportFile = path.join(root, 'imessage-export.json');
    const outDir = path.join(root, 'imessage-out');
    const fixture = {
        selfHandles: ['RAW_SELF_IMESSAGE'],
        handles: [
            { id: 'RAW_SELF_IMESSAGE', value: '+15550001010', displayName: 'Fixture Self' },
            { id: 'RAW_ADA_IMESSAGE', value: '+15550001111', displayName: 'Ada Example' },
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
    fs.writeFileSync(exportFile, JSON.stringify(fixture, null, 2));
    return { exportFile, outDir };
}
```

Update the iMessage registry row:

```js
{
    source: 'imessage',
    modulePath: 'sources/imessage/import.js',
    testName: 'iMessage',
    forbidden: ['RAW_ADA_IMESSAGE', 'RAW_IMESSAGE_CHAT', 'RAW_IMESSAGE_MESSAGE', '+15550001111', 'ada@example.test', 'private.example', '/Users/fixture/Library/Messages', 'token abc123'],
    forbiddenHooks: ['chat.db', 'iCloud', 'osascript', 'Messages.app', 'AppleScript', 'sendMessage', 'sqlite3', 'node-fetch', 'axios'],
    run(root) {
        const { runIMessageImport } = require('../../sources/imessage/import');
        const { exportFile, outDir } = writeIMessageFixture(root);
        return runIMessageImport({ exportFile, outDir, dataDir: root, progress: null, logger: { log() {} } });
    },
    load(index, contacts) {
        merge.loadIMessage(index, contacts);
    },
    interactions(result) {
        return merge.buildInteractions({ imessageMessages: result.messages });
    },
},
```

**Step 2: Run focused test**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js --test-name-pattern='iMessage satisfies'
```

Expected: PASS after #237 lands. If #237 has not landed yet, leave the iMessage row without `run()` and add a comment that it becomes active in the iMessage PR.

**Step 3: Commit**

```bash
git add tests/unit/source-importer-contract.test.js sources/imessage/import.js crm/merge.js
git commit -m "test: enforce iMessage importer trust contract"
```

---

### Task 6: Add the harness to `npm test`

**Objective:** Make the shared source contract run in the default verification path.

**Files:**
- Modify: `package.json`

**Step 1: Update test script ordering**

In `package.json`, add `tests/unit/source-importer-contract.test.js` immediately after the per-source importer tests in the `test` script:

```json
"test": "node --test --test-concurrency=1 tests/unit/schema.test.js tests/unit/email-import.test.js tests/unit/discord-import.test.js tests/unit/slack-import.test.js tests/unit/imessage-import.test.js tests/unit/source-importer-contract.test.js ..."
```

If `tests/unit/imessage-import.test.js` is not present on the implementation branch yet, add the contract file after `tests/unit/slack-import.test.js` and move it after iMessage when #237 lands.

**Step 2: Run focused and full unit checks**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js
npm test
```

Expected: both PASS.

**Step 3: Commit**

```bash
git add package.json tests/unit/source-importer-contract.test.js
git commit -m "test: run source importer contract in unit suite"
```

---

### Task 7: Add a short contributor note for future importers

**Objective:** Make the contract discoverable so future source-depth work extends the harness instead of copying only per-source tests.

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `tests/README.md`

**Step 1: Update docs**

In `ARCHITECTURE.md`, under “Adding a new importer”, add:

```md
After adding source-specific parser tests, register the source in `tests/unit/source-importer-contract.test.js`. A Minty importer is not considered agent-ready until the shared contract proves local-only behavior, safe normalized artifacts, merge compatibility, source-health visibility, and no raw identifiers/details in serialized output.
```

In `tests/README.md`, extend the importer row:

```md
| New importer in `sources/` | `tests/unit/<source>-import.test.js` for parser/file edge cases, plus `tests/unit/source-importer-contract.test.js` for the shared agent trust contract; integration tests only for live fetchers | |
```

**Step 2: Verify docs and tests**

Run:

```bash
node --test tests/unit/source-importer-contract.test.js
npm test
```

Expected: PASS.

**Step 3: Commit**

```bash
git add ARCHITECTURE.md tests/README.md tests/unit/source-importer-contract.test.js
git commit -m "docs: document importer trust contract"
```

---

## Final verification

Run:

```bash
node --test tests/unit/source-importer-contract.test.js
npm test
git diff --check HEAD~7..HEAD
```

Expected:

- Source importer contract test passes.
- Full unit suite passes.
- Diff check reports no whitespace errors.
- No test fixture or docs string includes real export paths, real emails/phones, raw private message database paths, provider tokens, or live API endpoints beyond forbidden-hook sentinel strings inside tests.

## Implementation notes

- Keep source-specific fixtures tiny. The harness is for invariants, not parser coverage.
- If a source lacks an exported `run<Source>Import()` helper, export the existing function; do not duplicate filesystem import logic in the harness.
- If `buildAgentSourceHealth()` requires source events in addition to contacts/interactions/sync state for a new source, add synthetic `sourceEvents` with safe canonical source labels and no raw bodies.
- Use string concatenation for synthetic emails in fixtures (`'ada' + '@' + 'example.test'`) so future leakage scans do not confuse the plan/test fixture with real PII.
- Do not run this against real `data/`; every contract row must use a temp directory created inside the test.

## Why this matters

Source depth is now Minty's bottleneck, but every new source widens the privacy/trust attack surface. A shared importer contract lets builders add high-signal sources faster without weakening the Hermes/OpenClaw promise: agents get more evidence, but never raw IDs, contact details, private paths, provider hooks, or unverifiable source claims.
