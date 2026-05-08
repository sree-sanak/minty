# Agent Intro Paths MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `intro_paths` MCP tool so Hermes/OpenClaw can answer “what is my warmest path to this person/company/goal?” with privacy-safe, source-backed network paths.

**Architecture:** Reuse Minty's existing `crm/people-graph.js` `findIntroPaths()` and `crm/agent-retrieval.js` `queryNetwork()` primitives instead of adding a new graph or recommender. Extend the shared agent data loader to include `group-memberships.json`, add a pure `crm/agent-intro-paths.js` envelope builder, expose it from `scripts/minty-mcp-server.js`, and document the workflow in `docs/HERMES_INTEGRATION.md`. The tool returns person names and high-level role/company metadata only; group names, group ids, raw contact ids, emails, phones, message bodies, and source file paths stay out of the MCP envelope.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `interactions.json`, `insights.json`, `contact-evidence.json`, `source-events.json`, `hybrid-index.json`, `group-memberships.json`, `crm/people-graph.js`, `crm/agent-retrieval.js`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's current agent surface can find relevant people (`search_network`), explain a known person (`person_context`), summarize a goal (`workflow_brief`), and preflight source trust (`source_health`). Recent work has also tightened privacy envelopes and source-filter behavior. The remaining activation gap is narrower and higher leverage: once Hermes finds a relevant but cold target, it still cannot ask Minty **how to reach them through the user's existing warm network**.

The graph primitive already exists: `crm/people-graph.js` can find warm intermediaries through `group-memberships.json`. This plan exposes that proven primitive as a small MCP workflow. It complements existing plans rather than duplicating them:

- `2026-05-04-agent-goal-actions-mcp.md` can later call intro paths internally, but `intro_paths` should stand alone for ad-hoc Hermes questions like “who can intro me to Maya?” or “what is my path into Stripe?”
- `2026-05-06-agent-source-health-mcp.md` answers whether a source is fresh and evidence-bearing before relying on it.
- `2026-05-06-hermes-readiness-doctor.md` answers install/readiness posture.
- `2026-05-07-memory-refresh-diagnostics.md` answers whether the refresh pipeline completed.

This plan is adapted from the preserved off-branch plan in `3f13729` and updated against current `main`/branch state: `source_health` already exists, `scripts/agent-query.js` already loads sanitized `syncState`, and `tests/unit/minty-mcp-server.test.js` currently asserts exactly four tools: `person_context`, `search_network`, `source_health`, and `workflow_brief`.

## Success criteria

- MCP `tools/list` includes `intro_paths` beside `search_network`, `person_context`, `workflow_brief`, and `source_health`.
- `intro_paths({ target: "Maya Target" })` returns redacted paths from warm intermediaries to matched target contacts.
- `intro_paths({ goal: "warm intro to EU crypto insurance partners" })` first ranks goal-relevant targets, then returns best intro paths into them.
- Empty states are explicit and honest: `no_group_graph`, `no_target_matches`, `no_goal_targets`, or `no_path` — never fabricated advice.
- Paths include opaque citation refs, source/provenance labels, group size bucket/count, confidence drivers, and freshness metadata.
- Serialized tool output never includes raw group names, raw group chat ids, emails, phones, raw contact ids, raw message bodies, token paths, or source file paths.

## Non-goals

- Do not send messages, draft outreach, create tasks, mutate contacts, or mark relationship stages.
- Do not expose exact group names or chat ids. Treat group names as private because they often contain companies, locations, events, or sensitive communities.
- Do not add a new UI screen, database, dependency, runtime LLM call, or sync path.
- Do not replace `search_network`, `workflow_brief`, `source_health`, or goal-actions plans; this is a focused path-finding tool.
- Do not use real Sree data in tests or fixtures.

---

### Task 1: Load group memberships in the shared agent data loader

**Objective:** Make `loadData()` return object-shaped `groupMemberships` while preserving existing `syncState`, optional `sourceEvents`, and optional `hybridIndex` behavior.

**Files:**
- Modify: `scripts/agent-query.js:48-104`
- Modify or create: `tests/unit/agent-query.test.js`

**Step 1: Write failing test**

Create `tests/unit/agent-query.test.js` if it does not exist; if it already exists, append the tests below and preserve its current imports/helpers.

```js
test('[AgentQuery]: loadData loads group memberships for intro path tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), [{ id: 'c_1', name: 'Alice' }]);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), {
        g_private: { chatId: 'g_private', name: 'Private Group', size: 3, members: ['c_1'] },
    });
    writeJson(path.join(dir, 'sync-state.json'), { telegram: { lastSyncAt: '2026-05-06T07:00:00Z', tokenPath: '/secret/token.json' } });

    const data = loadData(dir);

    assert.deepEqual(Object.keys(data.groupMemberships), ['g_private']);
    assert.equal(data.groupMemberships.g_private.size, 3);
    assert.equal(data.syncState.telegram.lastSyncAt, '2026-05-06T07:00:00Z', 'must preserve existing syncState loader behavior');
    assert.equal(Object.hasOwn(data.syncState.telegram, 'tokenPath'), false, 'syncState remains sanitized');
});

test('[AgentQuery]: loadData rejects malformed group memberships', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), []);

    assert.deepEqual(loadData(dir).groupMemberships, {});
});
```

If the file is new, include:

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

Expected: FAIL because `groupMemberships` is not loaded yet.

**Step 3: Write minimal implementation**

In `scripts/agent-query.js`, update the `loadData()` return JSDoc to include `groupMemberships: object`. Then make `group-memberships.json` an object-shaped file alongside `insights.json` and `contact-evidence.json`:

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

Add the return field without removing `syncState`:

```js
groupMemberships: loadJson('group-memberships.json'),
syncState: loadRootSyncState('sync-state.json'),
```

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
        id: 'c_target', name: 'Maya Target', relationshipScore: 12, daysSinceContact: 400,
        sources: { linkedin: { company: 'TargetCo', position: 'Partner' } },
        groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Seed Group' }],
    },
    {
        id: 'c_warm', name: 'Priya Warm', relationshipScore: 86, daysSinceContact: 4,
        sources: { linkedin: { company: 'WarmCo', position: 'Founder' } },
        groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Seed Group' }],
    },
];
const groupMemberships = {
    g_seed: { chatId: 'g_seed', name: 'Secret Seed Group', size: 4, members: ['c_target', 'c_warm'], updatedAt: '2026-05-01T10:00:00Z' },
};

test('[AgentIntroPaths]: returns redacted path for named target', () => {
    const out = buildAgentIntroPaths({ target: 'Maya Target' }, { contacts, groupMemberships, now: '2026-05-03T12:00:00Z' });

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
    const out = buildAgentIntroPaths({ goal: 'intro to TargetCo partner' }, { contacts, groupMemberships, limit: 3 });

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

Create `crm/agent-intro-paths.js`. Keep the implementation pure and deterministic. The core shape should be:

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
    return { label: size > 25 ? 'shared community' : 'small shared group', groupSize: size };
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
            ref: opaqueRef(target.name, intermediary.name, String(group.size || 0)),
            source: 'group-memberships',
            field: 'co_membership',
            provenance: 'local_group_roster',
            groupSize: Number(group.size) || 0,
            generatedAt: now,
        }],
    };
}
```

Then implement:

- `targetMatches(target, contacts, limit)` by matching lowercased target text against name/title/company/headline fields, not raw ids.
- `rankedGoalTargets(goal, data, limit)` by calling `queryNetwork(goal, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, limit: Math.max(limit * 3, 10) })`, mapping result names back to contacts, and keeping relevant targets. Do not require cold-only targets at first; warm paths can still be useful, and tests should not depend on hidden relationship thresholds.
- `buildAgentIntroPaths(args, data)` with `status`, `mode`, `paths`, `emptyState` when applicable, and a `safety` object asserting read-only/no outreach/contact details omitted/group names omitted/group ids omitted/raw messages omitted.

Export:

```js
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

**Objective:** Add the MCP tool definition and execution branch while preserving `source_health` and existing privacy redaction.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-309`
- Modify: `tests/unit/minty-mcp-server.test.js:118-128` and append near the tool-call tests

**Step 1: Write failing tests**

Update the existing `responds to tools/list with all tool definitions` assertion in `tests/unit/minty-mcp-server.test.js` from current four-tool exactness to five-tool exactness:

```js
assert.equal(tools.length, 5);
const names = tools.map(t => t.name).sort();
assert.deepEqual(names, ['intro_paths', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
```

Add focused MCP execution coverage:

```js
it('[MCP]: intro_paths returns redacted JSON envelope', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, {
        contacts: [
            { id: 'c_target', name: 'Maya Target', relationshipScore: 12, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }] },
            { id: 'c_warm', name: 'Priya Warm', relationshipScore: 86, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }] },
        ],
        insights: {}, interactions: [], contactEvidence: {}, sourceEvents: [], hybridIndex: [], syncState: {},
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

Add a tool definition after `workflow_brief` and before `source_health`:

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
            goal: { type: 'string', description: 'Goal to rank targets before finding paths' },
            limit: { type: 'number', description: 'Max paths to return (1-10, default 5)' },
        },
    },
},
```

Inside `executeTool()`, add:

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
        limit: Math.max(1, Math.min(10, clampLimit(args.limit, 5))),
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
- Modify: `package.json:37-89`
- Create: `scripts/smoke-intro-paths-mcp.js`

**Step 1: Add package script**

In `package.json` scripts, add:

```json
"mcp:smoke:intro-paths": "node scripts/smoke-intro-paths-mcp.js"
```

Place it near the existing `mcp` script.

**Step 2: Create smoke script**

Create `scripts/smoke-intro-paths-mcp.js`:

```js
#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const seed = spawnSync('npm', ['run', 'seed:demo'], { cwd: root, stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status || 1);

const msg = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
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
if (!['ok', 'no_path', 'no_group_graph', 'no_goal_targets', 'no_target_matches'].includes(envelope.status)) {
    throw new Error('Unexpected intro_paths status: ' + envelope.status);
}
const serialized = JSON.stringify(envelope);
const leakPatterns = [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, /\+\d{7,}/, /\b\d+@g\.us\b/i, /Secret/];
for (const pattern of leakPatterns) {
    if (pattern.test(serialized)) throw new Error('Potential privacy leak in intro_paths smoke: ' + pattern);
}
console.log('intro_paths MCP smoke passed:', envelope.status);
```

**Step 3: Run verification**

Run:

```bash
npm run mcp:smoke:intro-paths
```

Expected: PASS with `intro_paths MCP smoke passed: ...`.

**Step 4: Commit**

```bash
git add package.json scripts/smoke-intro-paths-mcp.js
git commit -m "test: add intro paths MCP smoke"
```

---

### Task 5: Document Hermes usage and run final checks

**Objective:** Make the new workflow discoverable without overstating readiness.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:100-117`
- Modify: `hermes/minty-network-memory/SKILL.md` if it exists and lists exact tools

**Step 1: Update docs**

Add this near the MCP tool list:

````md
### intro_paths

Warm path finder. Input: `{ target?, goal?, limit? }`. Use it when Hermes has a specific target or goal and needs to know how to reach that person/company through the user's existing local network.

Examples:

```json
{ "target": "Maya Target" }
{ "goal": "warm intro to EU crypto insurance partners", "limit": 3 }
```

The tool is read-only. It returns redacted path evidence from local group co-membership: target, intermediary, relationship warmth, group size, opaque citation refs, confidence, and honest empty states. It intentionally omits emails, phones, raw contact ids, raw group names, group chat ids, and message bodies. If the question depends on a specific source being fresh, call `source_health` first.
````

If `hermes/minty-network-memory/SKILL.md` has an exact tool list, add `intro_paths` there with the same privacy caveat.

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
text = Path('docs/HERMES_INTEGRATION.md').read_text()
fence = chr(96) * 3
assert text.count(fence) % 2 == 0, 'unbalanced markdown fences'
PY
```

Expected: no output and exit 0.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document intro paths MCP workflow"
```

If the Hermes skill file did not change, omit it from `git add`.

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

Expected: clean worktree except intentional unrelated local work, all tests pass, and commits appear in task order.

## Implementation notes / pitfalls

- `scripts/agent-query.js` currently treats only `insights.json` and `contact-evidence.json` as object files. Add `group-memberships.json` to that object set; do not accidentally force `source-events.json` or `hybrid-index.json` into object shape.
- Preserve current `syncState` loading and sanitization. This plan must be additive to `source_health`, not a regression.
- `tests/unit/minty-mcp-server.test.js` currently asserts `tools.length === 4` and exact sorted names. Update it to exactly five names including both `intro_paths` and `source_health`.
- `findIntroPaths()` returns raw `chatId` and group `name` in `sharedGroupsWithTarget`. The MCP envelope must transform that into `sharedContext` plus opaque citations before serialization.
- Target matching by raw contact id is intentionally not part of this plan; MCP callers should use names/goals, and the tool should not expose or require raw ids.
- Goal mode should reuse `queryNetwork()` so it benefits from source filters, contact evidence, source freshness diagnostics, and future citation improvements.
- If both `target` and `goal` are provided, prefer explicit `target` mode and add a deterministic test documenting that precedence.
- If another task lands first and adds loader fields, preserve those fields and only add missing behavior.
