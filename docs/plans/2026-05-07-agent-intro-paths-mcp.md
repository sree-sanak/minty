# Agent Intro Paths MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `intro_paths` MCP tool so Hermes/OpenClaw can answer “what is my warmest path to this person/company/goal?” with privacy-safe, source-backed network paths.

**Architecture:** Reuse Minty's existing `crm/people-graph.js` `findIntroPaths()` and `crm/agent-retrieval.js` `queryNetwork()` primitives instead of adding a new graph or recommender. Extend the shared agent data loader to include `group-memberships.json`, add a pure `crm/agent-intro-paths.js` envelope builder, expose it from `scripts/minty-mcp-server.js`, and document the workflow in `docs/HERMES_INTEGRATION.md`. The tool returns names and high-level role/company metadata only; group names, group ids, raw contact ids, emails, phones, message bodies, and source file paths stay out of the MCP envelope.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `interactions.json`, `insights.json`, `contact-evidence.json`, `source-events.json`, `hybrid-index.json`, `group-memberships.json`, `crm/people-graph.js`, `crm/agent-retrieval.js`, `crm/source-events.js`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's current agent surface can find relevant people (`search_network`), explain a known person (`person_context`), and summarize a goal (`workflow_brief`). Recent plans cover citations, source health, meeting prep, goal next-actions, evals, and a human evidence-review workbench. The missing activation gap is narrower and higher leverage: once Hermes finds a relevant but cold target, it still cannot ask Minty **how to reach them through the user's existing warm network**.

The graph primitive already exists: `crm/people-graph.js` can find warm intermediaries through `group-memberships.json`. This plan exposes that proven primitive as a small MCP workflow. It complements `2026-05-04-agent-goal-actions-mcp.md` by giving agents a direct target/company/path tool; goal actions may later call this tool internally, but `intro_paths` should stand alone for ad-hoc Hermes questions like “who can intro me to Maya?” or “what is my path into Stripe?”

## Success criteria

- MCP `tools/list` includes `intro_paths` beside `search_network`, `person_context`, and `workflow_brief`.
- `intro_paths({ target: "Maya Target" })` returns redacted paths from warm intermediaries to matched target contacts.
- `intro_paths({ goal: "warm intro to EU crypto insurance partners" })` first ranks goal-relevant cold/relevant targets, then returns the best intro paths into them.
- Empty states are explicit and honest: `no_group_graph`, `no_target_matches`, `no_goal_targets`, or `no_path` — never fabricated advice.
- Paths include opaque citation refs, source/provenance labels, group size bucket/count, confidence drivers, and freshness metadata.
- Serialized tool output never includes raw group names, raw group chat ids, emails, phones, raw contact ids, raw message bodies, token paths, or source file paths.

## Non-goals

- Do not send messages, draft outreach, create tasks, mutate contacts, or mark relationship stages.
- Do not expose exact group names or chat ids. Treat group names as private because they often contain companies, locations, events, or sensitive communities.
- Do not add a new UI screen, database, dependency, runtime LLM call, or sync path.
- Do not replace `search_network`, `workflow_brief`, source-health, or goal-actions plans; this is a focused path-finding tool.
- Do not use real Sree data in tests or fixtures.

---

### Task 1: Load group memberships in the shared agent data loader

**Objective:** Make `loadData()` return object-shaped `groupMemberships` without regressing existing optional files.

**Files:**
- Modify: `scripts/agent-query.js:48-81`
- Modify: `tests/unit/agent-query.test.js`

**Step 1: Write failing test**

Create `tests/unit/agent-query.test.js` if it does not exist; if it already exists, append:

```js
test('[AgentQuery]: loadData loads group memberships for intro path tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), [{ id: 'c_1', name: 'Alice' }]);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), {
        'g_private': { chatId: 'g_private', name: 'Private Group', size: 3, members: ['c_1'] },
    });

    const data = loadData(dir);

    assert.deepEqual(Object.keys(data.groupMemberships), ['g_private']);
    assert.equal(data.groupMemberships.g_private.size, 3);
});

test('[AgentQuery]: loadData rejects malformed group memberships', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), []);

    assert.deepEqual(loadData(dir).groupMemberships, {});
});
```

If the file is new, include the standard imports and helper:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadData } = require('../../scripts/agent-query');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: FAIL because `groupMemberships` is not loaded or malformed object handling is missing.

**Step 3: Write minimal implementation**

In `scripts/agent-query.js`, update the loader comment to include `groupMemberships: object`. Then change `fallbackFor()` and validation:

```js
function fallbackFor(file, missing = false) {
    if (file === 'insights.json' || file === 'contact-evidence.json' || file === 'group-memberships.json') return {};
    if (missing && (file === 'source-events.json' || file === 'hybrid-index.json')) return undefined;
    return [];
}
function loadJson(file) {
    const p = path.join(dataDir, 'unified', file);
    if (!fs.existsSync(p)) return fallbackFor(file, true);
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (file === 'insights.json' || file === 'contact-evidence.json' || file === 'group-memberships.json') {
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackFor(file, false);
        } else {
            if (!Array.isArray(parsed)) return fallbackFor(file, false);
        }
        return parsed;
    } catch {
        return fallbackFor(file, false);
    }
}
```

Add the return field:

```js
groupMemberships: loadJson('group-memberships.json'),
```

Keep any `goals`, `syncState`, or future loader fields if another plan has landed before this one.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-query.js tests/unit/agent-query.test.js
git commit -m "feat: load group memberships for agent tools"
```

---

### Task 2: Add the pure intro-path envelope builder

**Objective:** Convert target/goal input plus local graph data into redacted, cited path recommendations.

**Files:**
- Create: `crm/agent-intro-paths.js`
- Create: `tests/unit/agent-intro-paths.test.js`

**Step 1: Write failing tests**

Create `tests/unit/agent-intro-paths.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentIntroPaths } = require('../../crm/agent-intro-paths');

const contacts = [
    {
        id: 'c_target',
        name: 'Maya Target',
        relationshipScore: 12,
        daysSinceContact: 400,
        sources: { linkedin: { company: 'TargetCo', position: 'Partner' } },
        groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Seed Group' }],
    },
    {
        id: 'c_warm',
        name: 'Priya Warm',
        relationshipScore: 86,
        daysSinceContact: 4,
        sources: { linkedin: { company: 'WarmCo', position: 'Founder' } },
        groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Seed Group' }],
    },
];

const groupMemberships = {
    g_seed: {
        chatId: 'g_seed',
        name: 'Secret Seed Group',
        size: 4,
        members: ['c_target', 'c_warm'],
        updatedAt: '2026-05-01T10:00:00Z',
    },
};

test('[AgentIntroPaths]: returns redacted path for named target', () => {
    const out = buildAgentIntroPaths(
        { target: 'Maya Target' },
        { contacts, groupMemberships, now: '2026-05-03T12:00:00Z' }
    );

    assert.equal(out.status, 'ok');
    assert.equal(out.mode, 'target');
    assert.equal(out.paths.length, 1);
    assert.equal(out.paths[0].target.name, 'Maya Target');
    assert.equal(out.paths[0].intermediary.name, 'Priya Warm');
    assert.equal(out.paths[0].sharedContext.label, 'small shared group');
    assert.equal(out.paths[0].sharedContext.groupSize, 4);
    assert.equal(out.paths[0].citations[0].source, 'group-memberships');
    assert.equal(out.safety.groupNamesOmitted, true);

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('Secret Seed Group'), false);
    assert.equal(serialized.includes('g_seed'), false);
    assert.equal(serialized.includes('c_target'), false);
});

test('[AgentIntroPaths]: returns honest empty state when no group graph exists', () => {
    const out = buildAgentIntroPaths({ target: 'Maya Target' }, { contacts, groupMemberships: {} });
    assert.equal(out.status, 'no_group_graph');
    assert.deepEqual(out.paths, []);
});

test('[AgentIntroPaths]: supports goal mode through ranked target candidates', () => {
    const out = buildAgentIntroPaths(
        { goal: 'intro to TargetCo partner' },
        { contacts, groupMemberships, limit: 3 }
    );

    assert.equal(out.status, 'ok');
    assert.equal(out.mode, 'goal');
    assert.equal(out.paths[0].target.company, 'TargetCo');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-intro-paths.test.js
```

Expected: FAIL — `Cannot find module '../../crm/agent-intro-paths'`.

**Step 3: Write minimal implementation**

Create `crm/agent-intro-paths.js`:

```js
'use strict';

const crypto = require('node:crypto');
const { queryNetwork, warmthLabel } = require('./agent-retrieval');
const { findIntroPaths } = require('./people-graph');

function opaqueRef(...parts) {
    return 'ref_' + crypto.createHash('sha256').update(parts.filter(Boolean).join(':')).digest('hex').slice(0, 12);
}

function titleOf(contact) {
    return contact.apollo?.headline || contact.sources?.linkedin?.position || contact.sources?.googleContacts?.title || null;
}

function companyOf(contact) {
    return contact.sources?.linkedin?.company || contact.sources?.googleContacts?.org || null;
}

function safePerson(contact) {
    return {
        name: contact.name || 'Unknown person',
        title: titleOf(contact),
        company: companyOf(contact),
        warmth: warmthLabel(contact.relationshipScore || 0),
        relationshipScore: Number(contact.relationshipScore) || 0,
        daysSinceContact: Number.isFinite(Number(contact.daysSinceContact)) ? Number(contact.daysSinceContact) : null,
    };
}

function sharedContext(group) {
    const size = Math.max(0, Number(group && group.size) || 0);
    return {
        label: size > 25 ? 'shared community' : 'small shared group',
        groupSize: size,
    };
}

function pathToEnvelope(target, path, contactById, now) {
    const intermediary = contactById.get(path.intermediaryId) || { name: path.intermediaryName, relationshipScore: path.intermediaryScore };
    const group = (path.sharedGroupsWithTarget || [])[0] || {};
    return {
        target: safePerson(target),
        intermediary: safePerson(intermediary),
        sharedContext: sharedContext(group),
        pathScore: path.pathScore,
        confidence: path.pathScore >= 30 ? 'high' : path.pathScore >= 10 ? 'medium' : 'low',
        citations: [{
            ref: opaqueRef(target.id, path.intermediaryId, String(group.size || 0)),
            source: 'group-memberships',
            field: 'co_membership',
            provenance: 'local_whatsapp_group_roster',
            groupSize: Number(group.size) || 0,
            generatedAt: now,
        }],
    };
}

function searchableContactText(contact) {
    return [
        contact.name,
        titleOf(contact),
        companyOf(contact),
        contact.apollo?.headline,
        contact.sources?.linkedin?.headline,
        contact.sources?.linkedin?.company,
        contact.sources?.googleContacts?.org,
    ].filter(Boolean).join(' ').toLowerCase();
}

function targetMatches(target, contacts, limit) {
    const q = String(target || '').trim().toLowerCase();
    if (!q) return [];
    return contacts
        .filter(c => c && !c.isGroup && c.id && c.name && searchableContactText(c).includes(q))
        .slice(0, limit);
}

function rankedGoalTargets(goal, data, limit) {
    const result = queryNetwork(goal, {
        contacts: data.contacts,
        insights: data.insights || {},
        interactions: data.interactions || [],
        contactEvidence: data.contactEvidence || {},
        sourceEvents: data.sourceEvents,
        hybridIndex: data.hybridIndex,
        limit: Math.max(limit * 3, 10),
    });
    const byName = new Map((data.contacts || []).map(c => [c.name, c]));
    return (result.results || [])
        .map(r => byName.get(r.name))
        .filter(Boolean)
        .filter(c => (Number(c.relationshipScore) || 0) < 50)
        .slice(0, limit);
}

function buildAgentIntroPaths(args = {}, data = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const groupMemberships = data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships)
        ? data.groupMemberships
        : {};
    const limit = Math.max(1, Math.min(10, Math.floor(Number(args.limit || data.limit || 5))));
    const now = data.now || new Date().toISOString();
    const contactById = new Map(contacts.filter(c => c && c.id).map(c => [c.id, c]));

    const base = {
        mode: args.goal ? 'goal' : 'target',
        paths: [],
        safety: {
            readOnly: true,
            contactDetailsOmitted: true,
            rawContactIdsOmitted: true,
            groupNamesOmitted: true,
            groupChatIdsOmitted: true,
            rawMessagesOmitted: true,
            noOutreachTriggered: true,
        },
    };

    if (!Object.keys(groupMemberships).length) return { ...base, status: 'no_group_graph', emptyState: 'No group-membership graph is available yet.' };

    const targets = args.goal
        ? rankedGoalTargets(String(args.goal || ''), { ...data, contacts }, limit)
        : targetMatches(args.target, contacts, limit);

    if (!targets.length) {
        return { ...base, status: args.goal ? 'no_goal_targets' : 'no_target_matches', emptyState: 'No matching target contacts with enough local evidence.' };
    }

    for (const target of targets) {
        const paths = findIntroPaths(target.id, contacts, groupMemberships, { maxPaths: 2, maxGroupSize: 200 });
        for (const path of paths) base.paths.push(pathToEnvelope(target, path, contactById, now));
    }
    base.paths.sort((a, b) => b.pathScore - a.pathScore);
    base.paths = base.paths.slice(0, limit);
    if (!base.paths.length) return { ...base, status: 'no_path', emptyState: 'Matching targets exist, but Minty found no small-enough shared group path.' };
    return { ...base, status: 'ok' };
}

module.exports = { buildAgentIntroPaths };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-intro-paths.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-intro-paths.js tests/unit/agent-intro-paths.test.js
git commit -m "feat: add agent intro path envelope builder"
```

---

### Task 3: Expose `intro_paths` through MCP

**Objective:** Add the MCP tool definition and execution branch while preserving redaction and existing tools.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-247`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Update the existing tools/list protocol assertion in `tests/unit/minty-mcp-server.test.js` (currently it expects exactly three tools) and then add focused `intro_paths` tests near the other tool-call tests:

```js
// In the existing "responds to tools/list with all tool definitions" test:
assert.equal(tools.length, 4);
const names = tools.map(t => t.name).sort();
assert.deepEqual(names, ['intro_paths', 'person_context', 'search_network', 'workflow_brief']);

// Add near the tool-call tests:
it('[MCP]: intro_paths returns redacted JSON envelope', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, {
        contacts: [
            { id: 'c_target', name: 'Maya Target', relationshipScore: 12, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }] },
            { id: 'c_warm', name: 'Priya Warm', relationshipScore: 86, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }] },
        ],
        insights: {},
        interactions: [],
        contactEvidence: {},
        groupMemberships: { g_seed: { chatId: 'g_seed', name: 'Secret Group', size: 3, members: ['c_target', 'c_warm'] } },
    });

    const text = resp.result.content[0].text;
    const out = JSON.parse(text);
    assert.equal(out.status, 'ok');
    assert.equal(out.paths[0].intermediary.name, 'Priya Warm');
    assert.equal(text.includes('Secret Group'), false);
    assert.equal(text.includes('g_seed'), false);
    assert.equal(text.includes('c_target'), false);
});
```

If this test file uses `describe/it` instead of `test`, match the existing style and imports.

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL because `intro_paths` is not registered or handled.

**Step 3: Write minimal implementation**

At the top of `scripts/minty-mcp-server.js`, add:

```js
const { buildAgentIntroPaths } = require('../crm/agent-intro-paths');
```

Add a tool definition after `workflow_brief`:

```js
{
    name: 'intro_paths',
    description:
        'Find privacy-safe warm intro paths to a target person/company or goal using local group co-membership evidence. ' +
        'Read-only; no outreach, contact details, group names, or group chat ids are returned.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', description: 'Target person or company to reach' },
            goal: { type: 'string', description: 'Goal to rank targets for before finding paths' },
            limit: { type: 'number', description: 'Max paths to return (1-10, default 5)' },
        },
    },
},
```

Inside `executeTool()`, normalize memberships:

```js
const groupMemberships = (data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships)) ? data.groupMemberships : {};
```

Then add before the unknown-tool return:

```js
if (name === 'intro_paths') {
    if ((!args.target || typeof args.target !== 'string' || !args.target.trim()) &&
        (!args.goal || typeof args.goal !== 'string' || !args.goal.trim())) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required argument: target or goal' }] };
    }
    const envelope = buildAgentIntroPaths({
        target: typeof args.target === 'string' ? args.target.trim() : undefined,
        goal: typeof args.goal === 'string' ? args.goal.trim() : undefined,
        limit: clampLimit(args.limit, 5),
    }, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, groupMemberships });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose intro paths over MCP"
```

---

### Task 4: Add CLI smoke coverage for the MCP tool

**Objective:** Prove the tool works through the stdio MCP path on synthetic demo data.

**Files:**
- Modify: `package.json`
- Create: `scripts/smoke-intro-paths-mcp.js`
- Test: `tests/unit/package-scripts.test.js` if present, otherwise no unit file

**Step 1: Write failing script check**

If `tests/unit/package-scripts.test.js` exists, add:

```js
test('[PackageScripts]: exposes intro paths MCP smoke', () => {
    const pkg = require('../../package.json');
    assert.equal(pkg.scripts['mcp:smoke:intro-paths'], 'node scripts/smoke-intro-paths-mcp.js');
});
```

Run:

```bash
node --test tests/unit/package-scripts.test.js
```

Expected: FAIL until the script is added.

**Step 2: Create smoke script**

Create `scripts/smoke-intro-paths-mcp.js`:

```js
#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const seed = spawnSync(process.execPath, ['scripts/seed-dev-data.js'], { cwd: root, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status || 1);

const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'intro_paths', arguments: { goal: 'warm intro to product leaders at Stripe and Linear', limit: 3 } },
}) + '\n';

const run = spawnSync(process.execPath, ['scripts/minty-mcp-server.js'], {
    cwd: root,
    input: msg,
    encoding: 'utf8',
    env: { ...process.env, CRM_DATA_DIR: path.join(root, 'data-demo') },
});
if (run.status !== 0) {
    process.stderr.write(run.stderr || 'MCP server failed');
    process.exit(run.status || 1);
}
const response = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
const text = response.result && response.result.content && response.result.content[0] && response.result.content[0].text;
const envelope = JSON.parse(text);
if (!['ok', 'no_path', 'no_group_graph', 'no_goal_targets'].includes(envelope.status)) {
    throw new Error('Unexpected intro_paths status: ' + envelope.status);
}
const serialized = JSON.stringify(envelope);
for (const forbidden of ['@', '+44', '+1', 'g.us', 'Secret']) {
    if (serialized.includes(forbidden)) throw new Error('Potential privacy leak in intro_paths smoke: ' + forbidden);
}
console.log('intro_paths MCP smoke passed:', envelope.status);
```

**Step 3: Add package script**

In `package.json` scripts, add:

```json
"mcp:smoke:intro-paths": "node scripts/smoke-intro-paths-mcp.js"
```

**Step 4: Run verification**

Run:

```bash
npm run mcp:smoke:intro-paths
```

Expected: PASS with `intro_paths MCP smoke passed: ...`.

**Step 5: Commit**

```bash
git add package.json scripts/smoke-intro-paths-mcp.js tests/unit/package-scripts.test.js
git commit -m "test: add intro paths MCP smoke"
```

If `tests/unit/package-scripts.test.js` does not exist, omit it from `git add` and the commit.

---

### Task 5: Document Hermes usage and run final checks

**Objective:** Make the new workflow discoverable without overstating readiness.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`

**Step 1: Update docs**

Add a short section near the MCP tool list:

````md
### `intro_paths` — warm path finder

Use `intro_paths` when Hermes has a specific target or goal and needs to know how to reach that person/company through the user's existing local network.

Examples:

```json
{ "target": "Maya Target" }
{ "goal": "warm intro to EU crypto insurance partners", "limit": 3 }
```

The tool is read-only. It returns redacted path evidence from local group co-membership: target, intermediary, relationship warmth, group size, opaque citation refs, confidence, and honest empty states. It intentionally omits emails, phones, raw contact ids, raw group names, group chat ids, and message bodies. If `source_health` exists, call it first when the question depends on a specific source being fresh.
````

Use a four-backtick outer fence because the snippet contains a JSON fence.

**Step 2: Run focused tests**

Run:

```bash
node --test tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js
npm run mcp:smoke:intro-paths
```

Expected: PASS.

**Step 3: Run broad tests**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Check markdown and whitespace**

Run:

```bash
git diff --check
python3 - <<'PY'
from pathlib import Path
p = Path('docs/HERMES_INTEGRATION.md')
text = p.read_text()
assert text.count('```') % 2 == 0, 'unbalanced markdown fences'
PY
```

Expected: no output and exit 0.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md
git commit -m "docs: document intro paths MCP workflow"
```

---

## Final verification for the implementer

Run after all tasks:

```bash
git status --short --branch
node --test tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js
npm run mcp:smoke:intro-paths
npm test
git log --oneline -5
```

Expected: clean worktree except intentional untracked local files, all tests pass, and commits appear in task order.

## Implementation notes / pitfalls

- `scripts/agent-query.js` currently treats only `insights.json` and `contact-evidence.json` as object files. Add `group-memberships.json` to that object set; do not accidentally force `source-events.json` or `hybrid-index.json` into object shape.
- `findIntroPaths()` currently returns raw `chatId` and group `name` in `sharedGroupsWithTarget`. The MCP envelope must transform that into `sharedContext` plus opaque citations before serialization.
- Target matching by raw contact id is intentionally not part of this plan; MCP callers should use names/goals, and the tool should not expose or require raw ids.
- Goal mode should reuse `queryNetwork()` so it benefits from source filters, contact evidence, and future citation/source-health improvements.
- If `2026-05-04-agent-goal-actions-mcp.md` lands first and adds `goals`/`groupMemberships` loader fields, preserve those fields and only add missing behavior.
- If `2026-05-06-agent-source-health-mcp.md` lands first and adds `syncState`, preserve it. Loader changes must be additive.
