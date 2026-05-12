# Agent Intro Paths MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `intro_paths` MCP tool so Hermes/OpenClaw can answer “what is my warmest path to this person/company/goal?” with privacy-safe, source-backed network paths.

**Architecture:** Reuse the existing `crm/people-graph.js` `findIntroPaths()` primitive and current `queryNetwork()` ranking instead of creating a new recommender. First load `group-memberships.json` through the shared agent data loader, then add a pure `crm/agent-intro-paths.js` envelope builder, expose it in `scripts/minty-mcp-server.js`, and update the exact agent-surface docs contract. The MCP envelope returns names plus high-level role/company/warmth metadata only; raw group names, group ids, raw contact ids, emails, phones, message bodies, URLs, source handles, and private paths stay out.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, `scripts/agent-query.js`, `crm/people-graph.js`, `crm/agent-retrieval.js`, `scripts/minty-mcp-server.js`, `tests/unit/minty-mcp-server.test.js`, `tests/unit/agent-surface-docs.test.js`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`.

---

## Current state and verified gap

As of `77edbd6`, Minty exposes five MCP tools: `search_network`, `person_context`, `workflow_brief`, `source_health`, and `meeting_prep`. Retrieval trust work has landed: source-health gating, citations, confidence drivers, freshness, source labels, GBrain export privacy hardening, and meeting-prep MCP privacy all exist. `crm/people-graph.js` already has the warm-path primitive (`findIntroPaths()` over `group-memberships.json`), but Hermes cannot call it directly.

The remaining activation gap is narrow: after `workflow_brief` or `search_network` identifies a relevant but cold target, Hermes still cannot ask Minty **who can warm-intro me and why that path is trustworthy**. This plan updates the older intro-path handoff to current `main`: the MCP tool list must become six tools, the docs drift test must include `intro_paths`, and the plan must preserve the newer privacy/source-trust contract.

## Success criteria

- `loadData()` returns object-shaped `groupMemberships` from `data/unified/group-memberships.json` without exposing it in existing query outputs.
- Pure `buildAgentIntroPaths(args, data)` supports:
  - `target: "Maya Target"` — find warm paths to named people/company matches.
  - `goal: "warm intro to EU crypto insurance partners"` — rank goal-relevant targets with `queryNetwork()`, then find paths.
- MCP `tools/list` includes exactly six tools: `intro_paths`, `meeting_prep`, `person_context`, `search_network`, `source_health`, `workflow_brief`.
- Tool output includes honest empty states: `missing_input`, `no_group_graph`, `no_target_matches`, `no_goal_targets`, or `no_path`.
- Each path includes safe target/intermediary summaries, shared-context bucket/count, confidence, confidence drivers, freshness, and opaque citation refs.
- Serialized output never includes raw group names, group chat ids, raw contact ids, emails, phones, source handles, message bodies, URLs, or private paths.
- Docs and bundled Hermes skill mention `intro_paths`, and `tests/unit/agent-surface-docs.test.js` remains exact.

## Non-goals

- No outreach, message drafting, sending, task creation, contact mutation, Calendar mutation, or CRM stage updates.
- No UI screen, new database, new dependency, runtime LLM call, external API call, or service scheduler change.
- No exact group names or chat ids in agent envelopes. Group names are private because they often reveal communities, companies, events, or sensitive context.
- No real Sree data in tests, fixtures, docs examples, or expected output.

---

### Task 1: Load group memberships in the shared agent data loader

**Objective:** Make `loadData()` return sanitized object-shaped `groupMemberships` for MCP tools while preserving existing source-events, hybrid-index, and calendar sync-state behavior.

**Files:**
- Modify: `scripts/agent-query.js`
- Create: `tests/unit/agent-query.test.js`

**Step 1: Write failing test**

Create `tests/unit/agent-query.test.js`:

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
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), {
        g_private: { chatId: 'g_private', name: 'Private Group', size: 3, members: ['c_1'] },
    });
    writeJson(path.join(dir, 'sync-state.json'), {
        calendar: {
            lastSyncAt: '2026-05-06T07:00:00Z',
            stale: false,
            upcomingMeetings: [{ id: 'event-1', title: 'Safe loader test', attendees: [] }],
            tokenPath: '/private/token.json',
        },
    });

    const data = loadData(dir);

    assert.deepEqual(Object.keys(data.groupMemberships), ['g_private']);
    assert.equal(data.groupMemberships.g_private.size, 3);
    assert.equal(data.syncState.calendar.lastSyncAt, '2026-05-06T07:00:00Z');
    assert.equal(data.syncState.calendar.upcomingMeetings[0].id, 'event-1', 'must preserve meeting_prep loader behavior');
    assert.equal(Object.hasOwn(data.syncState.calendar, 'tokenPath'), false, 'syncState remains sanitized');
});

test('[AgentQuery]: loadData rejects malformed group memberships', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), []);

    assert.deepEqual(loadData(dir).groupMemberships, {});
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: FAIL because `groupMemberships` is not loaded yet.

**Step 3: Write minimal implementation**

In `scripts/agent-query.js`, update the JSDoc return shape to include `groupMemberships: object`.

Then update `fallbackFor()` and object-file validation:

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

Add the return field without removing existing fields:

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
        sources: { linkedin: { company: 'TargetCo', position: 'Partner', publicIdentifier: 'raw-handle' } },
        groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Seed Group' }],
        emails: ['maya@example.com'], phones: ['+15550001111'],
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

function assertNoPrivateGraphFields(out) {
    const serialized = JSON.stringify(out);
    for (const forbidden of ['Secret Seed Group', 'g_seed', 'c_target', 'c_warm', 'maya@example.com', '+15550001111', 'raw-handle']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
}

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
    assert.deepEqual(out.paths[0].confidenceDrivers, ['warm_intermediary', 'small_shared_group']);
    assert.equal(out.safety.groupNamesOmitted, true);
    assertNoPrivateGraphFields(out);
});

test('[AgentIntroPaths]: returns honest empty state when no group graph exists', () => {
    const out = buildAgentIntroPaths({ target: 'Maya Target' }, { contacts, groupMemberships: {} });
    assert.equal(out.status, 'no_group_graph');
    assert.deepEqual(out.paths, []);
    assert.equal(out.emptyState.reason, 'No local group co-membership graph is available.');
});

test('[AgentIntroPaths]: supports goal mode through ranked target candidates', () => {
    const out = buildAgentIntroPaths({ goal: 'intro to TargetCo partner' }, {
        contacts,
        groupMemberships,
        insights: {},
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        hybridIndex: [],
        limit: 3,
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.mode, 'goal');
    assert.equal(out.paths[0].target.company, 'TargetCo');
    assertNoPrivateGraphFields(out);
});

test('[AgentIntroPaths]: requires target or goal', () => {
    const out = buildAgentIntroPaths({}, { contacts, groupMemberships });
    assert.equal(out.status, 'missing_input');
    assert.deepEqual(out.paths, []);
});

// If callers provide both fields, the explicit target wins so Hermes can refine a
// broad goal without accidentally switching modes.
test('[AgentIntroPaths]: target takes precedence over goal', () => {
    const out = buildAgentIntroPaths({ target: 'Maya Target', goal: 'unrelated goal' }, {
        contacts,
        groupMemberships,
        insights: {},
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        hybridIndex: [],
    });
    assert.equal(out.status, 'ok');
    assert.equal(out.mode, 'target');
    assert.equal(out.paths[0].target.name, 'Maya Target');
    assertNoPrivateGraphFields(out);
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
    return 'intro:' + crypto.createHash('sha256').update(parts.filter(Boolean).join(':')).digest('hex').slice(0, 12);
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
        warmth: warmthLabel(Number(contact.relationshipScore) || 0),
        relationshipScore: Number(contact.relationshipScore) || 0,
        daysSinceContact: Number.isFinite(Number(contact.daysSinceContact)) ? Number(contact.daysSinceContact) : null,
    };
}
function sharedContext(group) {
    const size = Math.max(0, Number(group && group.size) || 0);
    return { label: size > 25 ? 'shared community' : 'small shared group', groupSize: size };
}
function confidenceDrivers(intermediary, group) {
    const drivers = [];
    if ((Number(intermediary.relationshipScore) || 0) >= 70) drivers.push('warm_intermediary');
    if ((Number(group && group.size) || 0) > 0 && (Number(group && group.size) || 0) <= 25) drivers.push('small_shared_group');
    return drivers.length ? drivers : ['shared_group_evidence'];
}
function targetMatches(target, contacts, limit) {
    const q = String(target || '').trim().toLowerCase();
    if (!q) return [];
    return contacts.filter(c => {
        const haystack = [c.name, titleOf(c), companyOf(c), c.apollo?.headline].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
    }).slice(0, limit);
}
function rankedGoalTargets(goal, data, limit) {
    const result = queryNetwork(goal, {
        contacts: data.contacts,
        insights: data.insights || {},
        interactions: data.interactions || [],
        contactEvidence: data.contactEvidence || {},
        sourceEvents: data.sourceEvents,
        hybridIndex: data.hybridIndex,
        syncState: data.syncState || {},
        limit: Math.max(limit * 3, 10),
    });
    const byName = new Map(data.contacts.map(c => [String(c.name || '').toLowerCase(), c]));
    return result.results.map(r => byName.get(String(r.name || '').toLowerCase())).filter(Boolean).slice(0, limit);
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
        confidenceDrivers: confidenceDrivers(intermediary, group),
        freshness: {
            targetDaysSinceContact: Number.isFinite(Number(target.daysSinceContact)) ? Number(target.daysSinceContact) : null,
            intermediaryDaysSinceContact: Number.isFinite(Number(intermediary.daysSinceContact)) ? Number(intermediary.daysSinceContact) : null,
        },
        citations: [{
            ref: opaqueRef(target.name, intermediary.name, String(group.size || 0)),
            source: 'group-memberships',
            field: 'co_membership',
            provenance: 'local-group-roster',
            groupSize: Number(group.size) || 0,
            observedAt: now || null,
        }],
    };
}
function empty(status, reason) {
    return {
        status,
        paths: [],
        emptyState: { reason },
        safety: safetyEnvelope(),
    };
}
function safetyEnvelope() {
    return {
        readOnly: true,
        noOutreachTriggered: true,
        contactDetailsOmitted: true,
        rawContactIdsOmitted: true,
        groupNamesOmitted: true,
        groupIdsOmitted: true,
        rawMessagesOmitted: true,
    };
}
function buildAgentIntroPaths(args = {}, data = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(c => c && !c.isGroup) : [];
    const groupMemberships = data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships) ? data.groupMemberships : {};
    const limit = Math.max(1, Math.min(10, Number(args.limit || data.limit || 5)));
    const now = data.now || new Date().toISOString();
    if (!args.target && !args.goal) return empty('missing_input', 'Provide target or goal.');
    if (!Object.keys(groupMemberships).length) return empty('no_group_graph', 'No local group co-membership graph is available.');

    const useGoal = !args.target && Boolean(args.goal);
    const targets = useGoal ? rankedGoalTargets(String(args.goal), { ...data, contacts }, limit) : targetMatches(String(args.target), contacts, limit);
    if (!targets.length) return empty(useGoal ? 'no_goal_targets' : 'no_target_matches', 'No source-backed target contacts matched.');

    const contactById = new Map(contacts.map(c => [c.id, c]));
    const paths = [];
    for (const target of targets) {
        const rawPaths = findIntroPaths(target.id, contacts, groupMemberships, { maxPaths: limit, maxGroupSize: 200 });
        for (const p of rawPaths) paths.push(pathToEnvelope(target, p, contactById, now));
        if (paths.length >= limit) break;
    }
    if (!paths.length) return empty('no_path', 'No warm path was found through local group co-membership evidence.');
    return {
        status: 'ok',
        mode: useGoal ? 'goal' : 'target',
        query: useGoal ? args.goal : args.target,
        paths: paths.slice(0, limit),
        diagnostics: { targetsConsidered: targets.length, graphGroupsConsidered: Object.keys(groupMemberships).length },
        safety: safetyEnvelope(),
    };
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

**Objective:** Add the MCP tool definition and execution branch while preserving the existing `meeting_prep`, `source_health`, citations, and privacy redaction contracts.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Update the existing `responds to tools/list with all tool definitions` assertion:

```js
assert.equal(tools.length, 6);
const names = tools.map(t => t.name).sort();
assert.deepEqual(names, ['intro_paths', 'meeting_prep', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
```

Add focused tool schema coverage near the existing `tool definitions` block:

```js
it('intro_paths has target or goal inputs only', () => {
    const tool = TOOLS.find(t => t.name === 'intro_paths');
    assert.ok(tool);
    assert.ok(tool.inputSchema.properties.target);
    assert.ok(tool.inputSchema.properties.goal);
    assert.ok(tool.inputSchema.properties.limit);
    assert.equal(tool.inputSchema.properties.contactId, undefined);
    assert.equal(tool.inputSchema.properties.groupId, undefined);
    assert.equal(tool.inputSchema.required, undefined);
});
```

Add MCP execution coverage near the tool-call tests:

```js
it('[MCP]: intro_paths returns a redacted JSON envelope', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, {
        contacts: [
            { id: 'c_target', name: 'Maya Target', relationshipScore: 12, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }], emails: ['maya@example.com'] },
            { id: 'c_warm', name: 'Priya Warm', relationshipScore: 86, groupMemberships: [{ chatId: 'g_seed', chatName: 'Secret Group' }] },
        ],
        insights: {}, interactions: [], contactEvidence: {}, sourceEvents: [], hybridIndex: [], syncState: {},
        groupMemberships: { g_seed: { chatId: 'g_seed', name: 'Secret Group', size: 3, members: ['c_target', 'c_warm'] } },
    });

    const text = resp.result.content[0].text;
    const out = JSON.parse(text);
    assert.equal(out.status, 'ok');
    assert.equal(out.paths[0].intermediary.name, 'Priya Warm');
    for (const forbidden of ['Secret Group', 'g_seed', 'c_target', 'c_warm', 'maya@example.com']) {
        assert.equal(text.includes(forbidden), false, forbidden);
    }
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
            goal: { type: 'string', description: 'Goal to rank possible targets before finding paths' },
            limit: { type: 'number', description: 'Max paths to return (1-10, default 5)' },
        },
    },
},
```

Inside `executeTool()`, add the shared input extraction near `syncState`:

```js
const groupMemberships = (data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships)) ? data.groupMemberships : {};
```

Then add this branch before the unknown-tool return:

```js
if (name === 'intro_paths') {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!target && !goal) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required argument: target or goal' }] };
    }
    const envelope = buildAgentIntroPaths({
        target: target || undefined,
        goal: goal || undefined,
        limit: Math.max(1, Math.min(10, clampLimit(args.limit, 5))),
    }, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, syncState, groupMemberships, now: nowForTests });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

Add a regression alongside the happy-path MCP execution test proving forwarded `syncState` stays internal:

```js
it('[MCP]: intro_paths does not echo syncState internals', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 43, method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Maya Target' } },
    }, {
        contacts: [
            { id: 'c_target', name: 'Maya Target', relationshipScore: 12, groupMemberships: [{ chatId: 'g_seed' }] },
            { id: 'c_warm', name: 'Priya Warm', relationshipScore: 86, groupMemberships: [{ chatId: 'g_seed' }] },
        ],
        insights: {}, interactions: [], contactEvidence: {}, sourceEvents: [], hybridIndex: [],
        syncState: { calendar: { lastSyncAt: '2026-05-01T00:00:00Z', upcomingMeetings: [{ id: 'private-event' }] } },
        groupMemberships: { g_seed: { chatId: 'g_seed', name: 'Secret Group', size: 3, members: ['c_target', 'c_warm'] } },
    });

    const text = resp.result.content[0].text;
    for (const forbidden of ['calendar', 'lastSyncAt', 'private-event', 'upcomingMeetings']) {
        assert.equal(text.includes(forbidden), false, forbidden);
    }
});
```

**Step 4: Run targeted tests to verify pass**

Run:

```bash
node --test tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose intro paths over MCP"
```

---

### Task 4: Update Hermes docs, skill, and docs drift contract

**Objective:** Keep the human/Hermes-facing contract exact after adding `intro_paths`.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Modify: `tests/unit/agent-surface-docs.test.js`

**Step 1: Write failing docs drift test update**

In `tests/unit/agent-surface-docs.test.js`, update the exact tool list:

```js
assert.deepEqual(toolNames, ['intro_paths', 'meeting_prep', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
```

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: FAIL until docs and skill mention `intro_paths`.

**Step 2: Update `docs/HERMES_INTEGRATION.md`**

Add an available-tools section after `workflow_brief` or before `source_health`:

```md
### intro_paths
Warm-intro path finder. Input: `{ target?, goal?, limit? }` with at least one of `target` or `goal`.
Returns privacy-safe paths through local group co-membership evidence: target, intermediary, shared-context size bucket/count, confidence, citations, freshness, diagnostics, and safety metadata. It never returns raw group names, group chat ids, contact ids, emails, phones, source handles, message bodies, URLs, or private paths, and it never sends outreach.
```

Also update any readiness/tool-list prose so Hermes-native includes `intro_paths` alongside the other five tools.

**Step 3: Update `hermes/minty-network-memory/SKILL.md`**

Add a use-case bullet near the top:

```md
- **Intro paths** — `intro_paths` when Sree asks who can warm-intro him to a person/company/goal.
```

Add an available-tools section:

````md
### intro_paths
Find warm intro paths to a target person/company or goal through local group co-membership evidence.

```json
{ "target": "Maya Target", "limit": 3 }
{ "goal": "warm intro to EU crypto insurance partners", "limit": 3 }
```

Use this after `workflow_brief` or `search_network` identifies a relevant target but the direct relationship is weak. Treat output as advisory only: no messages are sent, group names/ids and contact details are omitted, and empty states mean Minty has no safe local path evidence.
````

Because that Markdown section contains a nested JSON fence, the outer example uses a four-backtick fence. Keep that structure if editing this plan.

**Step 4: Run docs contract**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: document intro paths agent surface"
```

---

### Task 5: Add an MCP smoke script and package command

**Objective:** Prove `intro_paths` works through the stdio MCP path on synthetic data without requiring real contacts.

**Files:**
- Modify: `package.json`
- Create: `scripts/smoke-intro-paths-mcp.js`

**Step 1: Add package script**

In `package.json` scripts near `mcp`, add:

```json
"mcp:smoke:intro-paths": "node scripts/smoke-intro-paths-mcp.js"
```

**Step 2: Create smoke script**

Create `scripts/smoke-intro-paths-mcp.js`:

```js
#!/usr/bin/env node
'use strict';

const { handleMessage } = require('./minty-mcp-server');

async function main() {
    const data = {
        contacts: [
            { id: 'c_private_alpha', name: 'Demo Target', relationshipScore: 12, groupMemberships: [{ chatId: 'demo_group' }] },
            { id: 'c_private_beta', name: 'Demo Warm Intro', relationshipScore: 88, groupMemberships: [{ chatId: 'demo_group' }] },
        ],
        insights: {},
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        hybridIndex: [],
        syncState: {},
        groupMemberships: { demo_group: { chatId: 'demo_group', name: 'Private Demo Group', size: 3, members: ['c_private_alpha', 'c_private_beta'] } },
    };
    const resp = await handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'intro_paths', arguments: { target: 'Demo Target', limit: 1 } },
    }, data);
    const text = resp.result.content[0].text;
    const parsed = JSON.parse(text);
    if (parsed.status !== 'ok') throw new Error('intro_paths status was ' + parsed.status);
    for (const forbidden of ['demo_group', 'Private Demo Group', 'c_private_alpha', 'c_private_beta']) {
        if (text.includes(forbidden)) throw new Error('MCP smoke leaked private field: ' + forbidden);
    }
    console.log('intro_paths MCP smoke passed');
}

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
```

**Step 3: Run smoke**

Run:

```bash
npm run mcp:smoke:intro-paths
```

Expected: PASS and prints `intro_paths MCP smoke passed`.

**Step 4: Commit**

```bash
git add package.json scripts/smoke-intro-paths-mcp.js
git commit -m "test: add intro paths MCP smoke"
```

---

### Task 6: Full verification

**Objective:** Prove the feature is integrated without widening the agent privacy surface.

**Files:**
- No new files; verification only.

**Step 1: Run targeted checks**

```bash
node --test tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-surface-docs.test.js
npm run mcp:smoke:intro-paths
```

Expected: PASS.

**Step 2: Run full unit suite**

```bash
npm test
```

Expected: PASS.

**Step 3: Run privacy scan over changed output snippets**

Run this quick static check against the implementation diff before opening the PR:

```bash
git diff --check
node -e "const fs=require('fs'); const text=fs.readFileSync('tests/unit/agent-intro-paths.test.js','utf8'); for (const s of ['Secret Seed Group','g_seed','maya@example.com']) if (!text.includes(s)) throw new Error('missing privacy sentinel '+s); console.log('privacy sentinels present')"
```

Expected: PASS. The sentinels should exist only in tests as forbidden values, not in returned envelopes.

**Step 4: Commit any final fixes**

```bash
git add crm/agent-intro-paths.js scripts/agent-query.js scripts/minty-mcp-server.js scripts/smoke-intro-paths-mcp.js tests/unit/agent-query.test.js tests/unit/agent-intro-paths.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-surface-docs.test.js docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md package.json
git commit -m "test: verify intro paths MCP contract"
```

Only make this final commit if previous tasks left verification-only fixes. Otherwise skip it and open the PR from the task commits.

---

## Builder handoff notes

- Start from current `main`; do not resurrect older four-tool assertions from preserved branches.
- Keep the `meeting_prep` tool untouched except for exact tool-list counts.
- `scripts/agent-query.js` may carry sensitive internal calendar fields for `meeting_prep`; do not expose `syncState` wholesale in `intro_paths` output.
- `findIntroPaths()` returns group names/ids internally. The new envelope builder must treat those as private implementation evidence and convert them to safe group-size context plus opaque refs.
- If implementation discovers `group-memberships.json` is not generated in demo data, keep the MCP unit/smoke test synthetic and open a separate source-data issue; do not couple this tool to real WhatsApp data in the first PR.
