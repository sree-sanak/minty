# Agent Intro Paths MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `intro_paths` MCP tool so Hermes can answer “who is my warmest path to this person/company/goal?” with source-backed, privacy-safe network paths.

**Architecture:** Reuse Minty's existing `crm/people-graph.js` path finder and `crm/agent-retrieval.js` ranking instead of inventing another graph. Extend `scripts/agent-query.js` to load `group-memberships.json`, add a pure `crm/agent-intro-paths.js` envelope builder, then expose it through `scripts/minty-mcp-server.js`. The MCP envelope must redact group chat ids/names and contact details while preserving machine-readable citations, freshness, confidence, and empty-state discipline.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `interactions.json`, `insights.json`, `group-memberships.json`, `crm/people-graph.js`, `crm/agent-retrieval.js`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's pivot is agent-native private network memory. The current MCP surface can find relevant people (`search_network`), explain a known person (`person_context`), and summarize a goal (`workflow_brief`). The remaining high-leverage gap is path selection: when Hermes finds a relevant but cold target, it still cannot answer **“how do I actually get to them through the network I already have?”**

The underlying graph capability already exists in `crm/people-graph.js` through `findIntroPaths()` and WhatsApp-derived `group-memberships.json`, but it is not exposed to Hermes. This plan turns that existing capability into one small, trusted MCP workflow.

This complements, not duplicates, existing plans:

- `2026-05-02-agent-retrieval-citations.md` tightens citations/confidence for retrieval results.
- `2026-04-30-agent-meeting-prep-mcp.md` adds calendar-driven meeting prep.
- `2026-05-04-agent-goal-actions-mcp.md` uses intro paths as one option inside active-goal next actions.
- `2026-04-28-goal-activation-brief.md` uses intro paths in the UI/Today loop.
- This plan exposes intro path selection directly to Hermes for the narrower moment after `search_network` or `workflow_brief` finds a relevant-but-cold target. `goal_next_actions` answers “what should I do for my active goals?”; `intro_paths` answers “what is my warmest path into this target?”

Success criteria:

- MCP `tools/list` includes `intro_paths` beside `search_network`, `person_context`, and `workflow_brief`.
- `intro_paths({ target: "Maya Investor" })` returns redacted paths from warm intermediaries to matched target contacts.
- `intro_paths({ goal: "warm intro to EU crypto insurance partners" })` first ranks goal-relevant targets, then returns best paths into the cold/relevant ones.
- Paths omit emails, phones, raw contact records, raw group chat ids, and raw group names by default.
- Paths include citations with opaque refs, source type, field, group size, and confidence drivers so Hermes can verify that a path came from local co-membership evidence.
- Empty states are explicit: no group graph, no target matches, or only large/noisy groups returns `status: "no_path"` rather than fabricated advice.

Privacy contract:

- Treat group names as private. Many WhatsApp group names contain company names, locations, events, or sensitive communities. The agent-facing envelope should expose `sharedContext.label` such as `"small shared group"`, `groupSize`, and an opaque citation ref, not the raw chat id/name.
- Contact details stay omitted. Return names, role/company metadata already used by `safeResult()`, relationship score, warmth, and confidence only.
- The tool is advisory and read-only. It must never send messages, draft to contacts automatically, mutate contacts, or trigger outreach.

---

### Task 1: Load group memberships for agent/MCP data

**Objective:** Make the shared `loadData()` helper return `groupMemberships` so MCP tools can use the people graph without separate file reads. If `2026-05-04-agent-goal-actions-mcp.md` has already been implemented and `loadData()` already returns an object-valued `groupMemberships`, keep this task to adding/confirming the focused tests only.

**Files:**
- Modify: `scripts/agent-query.js:48-68` only if `groupMemberships` is not already loaded
- Test: `tests/unit/agent-query.test.js`

**Step 1: Write failing tests**

Create `tests/unit/agent-query.test.js` if it does not exist. If it already exists, append these tests:

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

test('[AgentQuery]: loadData loads group memberships for intro path tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), [{ id: 'c_1', name: 'Alice' }]);
    writeJson(path.join(dir, 'unified', 'insights.json'), {});
    writeJson(path.join(dir, 'unified', 'interactions.json'), []);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), {
        'g_1@g.us': { chatId: 'g_1@g.us', name: 'Private Group', size: 3, members: ['c_1'] },
    });

    const data = loadData(dir);

    assert.deepEqual(Object.keys(data.groupMemberships), ['g_1@g.us']);
    assert.equal(data.groupMemberships['g_1@g.us'].size, 3);
});

test('[AgentQuery]: loadData falls back to empty group memberships when file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), [{ id: 'c_1', name: 'Alice' }]);

    const data = loadData(dir);

    assert.deepEqual(data.groupMemberships, {});
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: FAIL — `groupMemberships` is missing or defaults to `[]`.

**Step 3: Write minimal implementation**

In `scripts/agent-query.js`, change the `loadData()` return contract comment and fallback logic:

```js
/**
 * Load contacts, insights, interactions, and group memberships from a resolved data directory.
 * @param {string} dataDir - Path to data directory (contains unified/ subdir)
 * @returns {{ contacts: object[], insights: object, interactions: object[], groupMemberships: object }}
 */
function loadData(dataDir) {
    function loadJson(file) {
        const fallback = (file === 'insights.json' || file === 'group-memberships.json') ? {} : [];
        const p = path.join(dataDir, 'unified', file);
        if (!fs.existsSync(p)) return fallback;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return fallback;
        }
    }
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        interactions: loadJson('interactions.json'),
        groupMemberships: loadJson('group-memberships.json'),
    };
}
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
git commit -m "feat: load agent group memberships"
```

---

### Task 2: Create the pure intro path envelope builder

**Objective:** Add `buildAgentIntroPaths()` that turns target or goal input into redacted, cited intro-path recommendations.

**Files:**
- Create: `crm/agent-intro-paths.js`
- Test: `tests/unit/agent-intro-paths.test.js`

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
        groupMemberships: [{ chatId: 'g_seed@g.us', chatName: 'Secret Seed Group' }],
    },
    {
        id: 'c_warm',
        name: 'Priya Warm',
        relationshipScore: 86,
        daysSinceContact: 4,
        sources: { linkedin: { company: 'WarmCo', position: 'Founder' } },
        groupMemberships: [{ chatId: 'g_seed@g.us', chatName: 'Secret Seed Group' }],
    },
];

const groupMemberships = {
    'g_seed@g.us': {
        chatId: 'g_seed@g.us',
        name: 'Secret Seed Group',
        size: 4,
        members: ['c_target', 'c_warm'],
        updatedAt: '2026-05-01T10:00:00Z',
    },
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
    assert.equal(serialized.includes('g_seed@g.us'), false);
});

test('[AgentIntroPaths]: returns no_path instead of inventing paths with no group graph', () => {
    const out = buildAgentIntroPaths({ target: 'Maya Target' }, { contacts, groupMemberships: {} });

    assert.equal(out.status, 'no_path');
    assert.equal(out.paths.length, 0);
    assert.match(out.reason, /No shared group graph/i);
});

test('[AgentIntroPaths]: ranks goal-relevant cold targets before warm direct contacts', () => {
    const out = buildAgentIntroPaths(
        { goal: 'warm intro to TargetCo partner', limit: 3 },
        { contacts, groupMemberships, insights: {}, interactions: [] }
    );

    assert.equal(out.status, 'ok');
    assert.equal(out.mode, 'goal');
    assert.equal(out.paths[0].target.name, 'Maya Target');
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

const { queryNetwork, warmthLabel } = require('./agent-retrieval');
const { findIntroPaths } = require('./people-graph');

function clampLimit(value, fallback = 5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(20, Math.floor(n)));
}

function groupLabel(size) {
    if (size <= 6) return 'small shared group';
    if (size <= 30) return 'shared community';
    return 'large shared community';
}

function summarizeContact(c) {
    return {
        name: c.name || null,
        title: c.title || c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.headline || null,
        company: c.company || c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        warmth: warmthLabel(Number(c.relationshipScore) || 0),
        relationshipScore: Number(c.relationshipScore) || 0,
        daysSinceContact: c.daysSinceContact ?? null,
    };
}

function emptyEnvelope(input, reason) {
    return {
        status: 'no_path',
        mode: input.goal ? 'goal' : 'target',
        query: input.goal || input.target || '',
        reason,
        paths: [],
        diagnostics: { targetMatches: 0, searchedTargets: 0 },
        safety: safetyEnvelope(),
    };
}

function safetyEnvelope() {
    return {
        contactDetailsOmitted: true,
        groupNamesOmitted: true,
        groupChatIdsOmitted: true,
        readOnly: true,
        noLlmCalls: true,
        noOutreachTriggered: true,
    };
}

function targetCandidates(input, data, limit) {
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(c => c && !c.isGroup) : [];
    if (input.goal) {
        const result = queryNetwork(input.goal, {
            contacts,
            insights: data.insights || {},
            interactions: Array.isArray(data.interactions) ? data.interactions : [],
            limit: Math.max(limit * 3, limit),
        });
        return result.results
            .filter(r => (Number(r.relationshipScore) || 0) < 70)
            .map(r => contacts.find(c => c.id === r.id))
            .filter(Boolean);
    }

    const needle = String(input.target || '').toLowerCase().trim();
    if (!needle) return [];
    return contacts.filter(c => String(c.name || '').toLowerCase().includes(needle)).slice(0, limit * 2);
}

function buildPath(target, path, index) {
    const group = path.sharedGroupsWithTarget[0] || {};
    const groupSize = Number(group.size) || null;
    return {
        ref: `intro_path_${index + 1}`,
        target: summarizeContact(target),
        intermediary: {
            name: path.intermediaryName,
            title: path.intermediaryTitle || null,
            company: path.intermediaryCompany || null,
            warmth: warmthLabel(Number(path.intermediaryScore) || 0),
            relationshipScore: Number(path.intermediaryScore) || 0,
        },
        sharedContext: {
            label: groupLabel(groupSize || 999),
            groupSize,
        },
        pathScore: path.pathScore,
        confidence: path.intermediaryScore >= 70 && groupSize && groupSize <= 30 ? 'high' : 'medium',
        suggestedAction: `Ask ${path.intermediaryName} if they are comfortable making a warm intro to ${target.name}.`,
        citations: [{
            ref: `intro_path_${index + 1}_group_1`,
            source: 'group-memberships',
            field: 'sharedGroup',
            provenance: 'local-whatsapp-roster',
            groupSize,
            observedAt: null,
        }],
    };
}

function buildAgentIntroPaths(input = {}, data = {}) {
    const normalized = input && typeof input === 'object' ? input : {};
    const limit = clampLimit(normalized.limit, 5);
    const groupMemberships = data.groupMemberships && typeof data.groupMemberships === 'object' ? data.groupMemberships : {};
    if (Object.keys(groupMemberships).length === 0) {
        return emptyEnvelope(normalized, 'No shared group graph is available. Run merge after syncing WhatsApp group rosters.');
    }

    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(c => c && !c.isGroup) : [];
    const targets = targetCandidates(normalized, data, limit);
    if (!targets.length) return emptyEnvelope(normalized, 'No target contacts matched the request.');

    const paths = [];
    for (const target of targets) {
        const found = findIntroPaths(target.id, contacts, groupMemberships, { maxPaths: 2, maxGroupSize: normalized.maxGroupSize || 200 });
        for (const p of found) paths.push({ target, path: p });
    }

    const materialized = paths
        .sort((a, b) => b.path.pathScore - a.path.pathScore)
        .slice(0, limit)
        .map((entry, i) => buildPath(entry.target, entry.path, i));

    if (!materialized.length) return emptyEnvelope(normalized, 'No safe intro path found through small enough shared groups.');

    return {
        status: 'ok',
        mode: normalized.goal ? 'goal' : 'target',
        query: normalized.goal || normalized.target || '',
        paths: materialized,
        diagnostics: { targetMatches: targets.length, searchedTargets: targets.length },
        dataFreshness: { generatedAt: new Date().toISOString(), groupCount: Object.keys(groupMemberships).length },
        safety: safetyEnvelope(),
    };
}

module.exports = { buildAgentIntroPaths, groupLabel };
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
git commit -m "feat: build agent intro path envelopes"
```

---

### Task 3: Expose `intro_paths` through the MCP server

**Objective:** Register an MCP tool that calls `buildAgentIntroPaths()` using loaded contacts, insights, interactions, and group memberships.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-68,96-181`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
test('tools/list includes intro_paths', async () => {
    const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, sampleData());
    const names = response.result.tools.map(t => t.name).sort();
    assert.ok(names.includes('intro_paths'));
});

test('intro_paths returns redacted intro path envelope', async () => {
    const data = {
        contacts: [
            { id: 'c_target', name: 'Maya Target', relationshipScore: 10, groupMemberships: [{ chatId: 'g_1' }] },
            { id: 'c_warm', name: 'Priya Warm', relationshipScore: 88, groupMemberships: [{ chatId: 'g_1' }] },
        ],
        insights: {},
        interactions: [],
        groupMemberships: { g_1: { chatId: 'g_1', name: 'Secret Group', size: 3, members: ['c_target', 'c_warm'] } },
    };

    const response = handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, data);

    const envelope = JSON.parse(response.result.content[0].text);
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.paths[0].intermediary.name, 'Priya Warm');
    assert.equal(JSON.stringify(envelope).includes('Secret Group'), false);
    assert.equal(JSON.stringify(envelope).includes('g_1'), false);
});

test('intro_paths rejects calls without target or goal', async () => {
    const response = handleMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'intro_paths', arguments: {} },
    }, { contacts: [], insights: {}, interactions: [], groupMemberships: {} });

    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /target or goal/);
});
```

If this file uses `describe/it` instead of `test`, adapt the wrapper but keep the assertions identical.

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — `intro_paths` is not listed and calls are unknown.

**Step 3: Wire the tool**

In `scripts/minty-mcp-server.js`, import the new builder:

```js
const { buildAgentIntroPaths } = require('../crm/agent-intro-paths');
```

Add this object to `TOOLS`:

```js
{
    name: 'intro_paths',
    description:
        'Find privacy-safe warm intro paths to a target person or goal-relevant targets. ' +
        'Returns redacted intermediary paths with source-backed group co-membership citations. ' +
        'Read-only — no messages sent, no contacts mutated, group names and contact details omitted.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', description: 'Target person name to reach, e.g. "Maya Patel"' },
            goal: { type: 'string', description: 'Goal query for target discovery, e.g. "warm intro to EU insurance partners"' },
            limit: { type: 'number', description: 'Max paths to return (1-20, default 5)' },
            maxGroupSize: { type: 'number', description: 'Ignore groups larger than this size (default 200)' },
        },
    },
}
```

Inside `executeTool()`, make sure group memberships are read safely:

```js
const groupMemberships = (data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships)) ? data.groupMemberships : {};
```

Then add the execution branch before the unknown-tool return:

```js
if (name === 'intro_paths') {
    const hasTarget = args.target && typeof args.target === 'string' && args.target.trim();
    const hasGoal = args.goal && typeof args.goal === 'string' && args.goal.trim();
    if (!hasTarget && !hasGoal) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required argument: target or goal' }] };
    }
    const envelope = buildAgentIntroPaths({
        target: hasTarget ? args.target.trim() : undefined,
        goal: hasGoal ? args.goal.trim() : undefined,
        limit: clampLimit(args.limit, 5),
        maxGroupSize: args.maxGroupSize,
    }, { contacts, insights, interactions, groupMemberships });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/agent-intro-paths.test.js tests/unit/agent-query.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose intro paths over MCP"
```

---

### Task 4: Document Hermes usage and safety boundaries

**Objective:** Update Hermes-facing docs and the bundled Hermes skill so agents know when to call `intro_paths` and how to interpret redacted path evidence.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:100-120`
- Modify: `hermes/minty-network-memory/SKILL.md:30-60,95-107`

**Step 1: Update integration guide**

In `docs/HERMES_INTEGRATION.md`, add after `workflow_brief`:

```md
### intro_paths
Warm intro path finder. Input: `{ target?, goal?, limit?, maxGroupSize? }`.
Returns redacted paths from warm intermediaries to a target person or goal-relevant targets, with group co-membership citations. Group names, chat ids, emails, phones, and raw contact records are omitted.

Use this after `search_network` or `workflow_brief` finds a relevant but cold target and Hermes needs to answer: “what is the warmest path in?”
```

Add an example row:

```md
| `"Warm intro path to Alice Müller"` | Redacted intermediary paths with source-backed co-membership evidence |
```

**Step 2: Update Hermes skill**

In `hermes/minty-network-memory/SKILL.md`, add to “Available tools”:

````md
### intro_paths
Find warm intro paths to a known target or goal-relevant targets. Use only when the user needs a path into someone, not for generic relationship maintenance.

```json
{ "target": "Alice Müller", "limit": 3 }
```

```json
{ "goal": "warm intro to EU crypto insurance partners", "limit": 5 }
```

Interpretation rules:
- Prefer high-confidence paths with warm intermediaries and small shared groups.
- Do not reveal or infer raw group names; Minty intentionally redacts them.
- Treat the suggested action as advisory. Hermes may draft an ask only after user approval.
````

Add it to the workflow example after `workflow_brief`:

```md
2. If a top person is cold, call intro_paths({ target: "Alice Müller" })
   → Returns possible warm intermediaries and redacted shared-context citations
```

**Step 3: Verify docs render enough for grep-based discovery**

Run:

```bash
node -e "for (const f of ['docs/HERMES_INTEGRATION.md','hermes/minty-network-memory/SKILL.md']) { const s=require('fs').readFileSync(f,'utf8'); if (!s.includes('intro_paths')) { console.error(f + ' missing intro_paths'); process.exitCode = 1; } else { console.log(f + ': intro_paths'); } }"
```

Expected: both files print an `intro_paths` line.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document intro paths MCP tool"
```

---

### Task 5: Add MCP smoke coverage and full verification

**Objective:** Prove the new tool appears in MCP and returns a redacted envelope with demo data.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`
- No production file changes unless a smoke test reveals a bug.

**Step 1: Add one whole-envelope privacy test if not already covered**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
test('intro_paths envelope omits PII-prone graph fields', async () => {
    const data = {
        contacts: [
            {
                id: 'c_target',
                name: 'Maya Target',
                emails: ['maya@example.com'],
                phones: ['+15555550100'],
                relationshipScore: 10,
                groupMemberships: [{ chatId: 'secret@g.us', chatName: 'Sensitive Founder Group' }],
            },
            {
                id: 'c_warm',
                name: 'Priya Warm',
                emails: ['priya@example.com'],
                phones: ['+15555550200'],
                relationshipScore: 88,
                groupMemberships: [{ chatId: 'secret@g.us', chatName: 'Sensitive Founder Group' }],
            },
        ],
        insights: {},
        interactions: [],
        groupMemberships: {
            'secret@g.us': { chatId: 'secret@g.us', name: 'Sensitive Founder Group', size: 3, members: ['c_target', 'c_warm'] },
        },
    };

    const response = handleMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, data);

    const serialized = response.result.content[0].text;
    assert.equal(serialized.includes('maya@example.com'), false);
    assert.equal(serialized.includes('+15555550100'), false);
    assert.equal(serialized.includes('secret@g.us'), false);
    assert.equal(serialized.includes('Sensitive Founder Group'), false);
});
```

**Step 2: Run focused tests**

Run:

```bash
node --test tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 3: Run full unit suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Run MCP smoke manually**

Run:

```bash
npm run seed:demo
python3 - <<'PY' | node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"intro-smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},
    {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"intro_paths","arguments":{"goal":"warm intro to investors in London","limit":2}}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY
```

Expected:
- `tools/list` includes `intro_paths`.
- The `tools/call` response is JSON text with `status` equal to either `ok` or `no_path`.
- The response does not contain raw group chat ids (`@g.us`), emails, phone numbers, or raw group names.

**Step 5: Commit**

```bash
git add tests/unit/minty-mcp-server.test.js
git commit -m "test: cover intro paths MCP privacy"
```

---

## Final verification checklist

Run before marking implementation done:

```bash
node --test tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js
npm test
npm run seed:demo
npm run agent -- "warm intro to investors in London"
```

Expected:
- All tests pass.
- Demo data seeds successfully.
- Existing `agent` CLI still works.
- MCP `intro_paths` returns source-backed paths or an honest `no_path` empty state.
- No returned envelope includes emails, phones, raw group ids, raw group names, raw contact records, or outreach side effects.

## Product decision preserved

This plan keeps the UI secondary and makes Hermes more capable first. It does not add another CRM workflow. It makes the assistant answer the real activation question: **not just “who can help?”, but “what warm path do I have into them?”**
