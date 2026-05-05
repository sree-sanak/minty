# Agent Goal Actions MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `goal_next_actions` MCP tool so Hermes can ask Minty what to do next for active goals using local goals, ranked contacts, pipeline state, and warm intro paths.

**Architecture:** Extend the existing agent data loader to include `goals.json` and `group-memberships.json`, add a pure `crm/agent-goal-actions.js` envelope builder, then expose it through `scripts/minty-mcp-server.js`. The tool reuses existing primitives (`rankContactsForGoal`, `buildGoalRetro`, `findIntroPaths`) and returns redacted, source-backed action options; it does not create goals, mutate stages, send messages, or require runtime LLM calls.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `interactions.json`, `goals.json`, `group-memberships.json`, `crm/utils.js`, `crm/goal-retro.js`, `crm/people-graph.js`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's current agent surface can answer “who matches this query?” through `search_network`, `person_context`, and `workflow_brief`. That is necessary, but still too passive for the Hermes wedge. The core promise is: **the user's AI assistant can answer who can help with this goal, why, and what should I do next.**

The repo already has the right primitives:

- `rankContactsForGoal()` ranks people for a goal.
- `buildGoalRetro()` understands assigned contacts, stuck stages, ghosted outreach, and replies.
- `findIntroPaths()` finds warm paths through `group-memberships.json`.
- Existing plans cover UI-facing goal activation/daily moves and trust citations.

The remaining product gap is agent activation: Hermes should not have to infer next actions by manually combining several files or opening the CRM UI. This plan turns the existing goal loop into a privacy-safe MCP workflow.

Success criteria:

- MCP `tools/list` includes `goal_next_actions`.
- `goal_next_actions({ limit: 3 })` returns at most three active-goal briefs.
- `goal_next_actions({ goal: "raise seed" })` narrows to matching active goals, or returns an honest empty state.
- Each brief includes one primary `nextAction`, supporting `pipelineFollowUps`, `directAsks`, and `introPaths` arrays where evidence exists.
- All output omits emails, phones, raw message bodies, raw contact records, raw group chat IDs, and private contact IDs except opaque citation refs.
- Empty or weak data returns `status: "empty"` / `confidence: "low"`, not made-up action advice.

---

### Task 1: Load goal-loop data for agent tools

**Objective:** Make `scripts/agent-query.js` load active goal and group graph files for MCP reuse while preserving existing CLI behavior.

**Files:**
- Modify: `scripts/agent-query.js:48-70`
- Test: `tests/unit/agent-retrieval.test.js` or `tests/unit/minty-mcp-server.test.js` where `loadData()` helper coverage currently lives

**Step 1: Write failing test**

Append near the existing `loadData()` test coverage:

```js
it('loads goals and group memberships for agent goal tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-data-'));
    const unified = path.join(dir, 'unified');
    fs.mkdirSync(unified, { recursive: true });
    fs.writeFileSync(path.join(unified, 'contacts.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(unified, 'interactions.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(unified, 'goals.json'), JSON.stringify([{ id: 'g_1', text: 'raise seed', active: true }]));
    fs.writeFileSync(path.join(unified, 'group-memberships.json'), JSON.stringify({ 'seed@g.us': { name: 'Seed', size: 3, members: [] } }));

    const { loadData } = require('../../scripts/agent-query');
    const data = loadData(dir);

    assert.deepEqual(data.goals, [{ id: 'g_1', text: 'raise seed', active: true }]);
    assert.deepEqual(data.groupMemberships, { 'seed@g.us': { name: 'Seed', size: 3, members: [] } });
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js
```

Expected: FAIL — `data.goals` and `data.groupMemberships` are missing.

**Step 3: Write minimal implementation**

Update the JSDoc and fallback handling in `scripts/agent-query.js`:

```js
/**
 * @returns {{ contacts: object[], insights: object, interactions: object[], contactEvidence: object, goals: object[], groupMemberships: object }}
 */
function loadData(dataDir) {
    function loadJson(file) {
        const objectFiles = new Set(['insights.json', 'contact-evidence.json', 'group-memberships.json']);
        const fallback = objectFiles.has(file) ? {} : [];
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
        contactEvidence: loadJson('contact-evidence.json'),
        goals: loadJson('goals.json'),
        groupMemberships: loadJson('group-memberships.json'),
    };
}
```

Keep the CLI path unchanged except destructuring can ignore the new fields.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js
```

Expected: PASS for the updated helper coverage.

**Step 5: Commit**

```bash
git add scripts/agent-query.js tests/unit/agent-retrieval.test.js
git commit -m "feat: load goal data for agent tools"
```

---

### Task 2: Build the pure agent goal-action envelope

**Objective:** Create `buildAgentGoalActions()` that turns local goals, contacts, interactions, and group memberships into redacted next-action briefs.

**Files:**
- Create: `crm/agent-goal-actions.js`
- Test: `tests/unit/agent-goal-actions.test.js`

**Step 1: Write failing tests**

Create `tests/unit/agent-goal-actions.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentGoalActions } = require('../../crm/agent-goal-actions');

function contact(id, overrides = {}) {
    return {
        id,
        name: id,
        relationshipScore: 50,
        daysSinceContact: null,
        interactionCount: 1,
        emails: ['private@example.com'],
        phones: ['+447700900123'],
        sources: { linkedin: { company: 'ExampleCo', position: 'Founder' } },
        ...overrides,
    };
}

test('[AgentGoalActions]: prioritizes active pipeline follow-up before new asks', () => {
    const goals = [{
        id: 'g_1',
        text: 'raise seed round',
        active: true,
        assignments: { c_stuck: { stage: 'Contacted', updatedAt: '2026-04-10T00:00:00Z' } },
    }];
    const contacts = [
        contact('c_stuck', { name: 'Maya Partner', relationshipScore: 82 }),
        contact('c_new', { name: 'Alex Angel', relationshipScore: 90 }),
    ];

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships: {} }, {
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.briefs[0].goalId, 'g_1');
    assert.equal(out.briefs[0].nextAction.type, 'pipeline_follow_up');
    assert.match(out.briefs[0].nextAction.label, /Maya Partner/);
});

test('[AgentGoalActions]: includes warm intro path when direct relationship is cold', () => {
    const goals = [{ id: 'g_2', text: 'reach target investor', active: true }];
    const contacts = [
        contact('c_target', { name: 'Target Investor', relationshipScore: 10, groupMemberships: [{ chatId: 'seed@g.us' }] }),
        contact('c_warm', { name: 'Warm Founder', relationshipScore: 85, groupMemberships: [{ chatId: 'seed@g.us' }] }),
    ];
    const groupMemberships = { 'seed@g.us': { name: 'Seed Founders', size: 3, members: ['c_target', 'c_warm'] } };

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships }, {
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.briefs[0].introPaths[0].target.name, 'Target Investor');
    assert.equal(out.briefs[0].introPaths[0].intermediary.name, 'Warm Founder');
    assert.equal(out.briefs[0].introPaths[0].sharedContext.label, 'small shared group');
    assert.equal(out.briefs[0].introPaths[0].sharedContext.groupSize, 3);
    assert.equal(out.briefs[0].introPaths[0].citation.source, 'group-memberships');
    assert.equal(JSON.stringify(out).includes('seed@g.us'), false);
    assert.equal(JSON.stringify(out).includes('Seed Founders'), false);
});

test('[AgentGoalActions]: redacts direct contact details and returns honest empty state', () => {
    const out = buildAgentGoalActions({ goals: [], contacts: [contact('c_1')], interactions: [], groupMemberships: {} }, {
        now: '2026-05-04T09:00:00Z',
    });

    const serialized = JSON.stringify(out);
    assert.equal(out.status, 'empty');
    assert.equal(serialized.includes('private@example.com'), false);
    assert.equal(serialized.includes('+447700900123'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: FAIL — `Cannot find module '../../crm/agent-goal-actions'`.

**Step 3: Write minimal implementation**

Create `crm/agent-goal-actions.js`:

```js
'use strict';

const { rankContactsForGoal } = require('./utils');
const { buildGoalRetro } = require('./goal-retro');
const { findIntroPaths } = require('./people-graph');

function summarizeContact(c) {
    return {
        name: c.name || null,
        title: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.headline || null,
        company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        warmth: warmth(c.relationshipScore || 0),
        relationshipScore: Number(c.relationshipScore) || 0,
        daysSinceContact: c.daysSinceContact ?? null,
        interactionCount: c.interactionCount || 0,
    };
}

function warmth(score) {
    if (score >= 70) return 'strong';
    if (score >= 50) return 'warm';
    if (score >= 30) return 'cool';
    return 'cold';
}

function groupLabel(size) {
    if (size <= 6) return 'small shared group';
    if (size <= 30) return 'shared community';
    return 'large shared community';
}

function byContactId(interactions) {
    const out = Object.create(null);
    for (const i of Array.isArray(interactions) ? interactions : []) {
        const id = i && (i.contactId || i.contact_id || i.personId);
        if (!id) continue;
        if (!out[id]) out[id] = [];
        out[id].push(i);
    }
    return out;
}

function stageAgeDays(assignment, nowMs) {
    const t = Date.parse(assignment && assignment.updatedAt);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((nowMs - t) / 86400000));
}

function pipelineFollowUps(goal, contactsById, nowMs) {
    const assignments = goal.assignments && typeof goal.assignments === 'object' ? goal.assignments : {};
    return Object.entries(assignments)
        .map(([contactId, assignment]) => {
            const c = contactsById.get(contactId);
            if (!c) return null;
            return {
                contact: summarizeContact(c),
                stage: assignment.stage || null,
                ageDays: stageAgeDays(assignment, nowMs),
                citationRef: 'goal:' + goal.id + ':assignment',
            };
        })
        .filter(Boolean)
        .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0))
        .slice(0, 2);
}

function directAsks(goal, ranked, assignedIds) {
    return ranked
        .filter(c => !assignedIds.has(c.id) && (Number(c.relationshipScore) || 0) >= 60)
        .slice(0, 2)
        .map((c, index) => ({
            contact: summarizeContact(c),
            reason: 'Warm and relevant to “' + goal.text + '”.',
            citationRef: 'goal:' + goal.id + ':direct:' + (index + 1),
        }));
}

function introPaths(goal, ranked, contacts, groupMemberships, assignedIds) {
    const paths = [];
    for (const target of ranked) {
        if (assignedIds.has(target.id)) continue;
        if ((Number(target.relationshipScore) || 0) >= 60) continue;
        const candidates = findIntroPaths(target.id, contacts, groupMemberships || {}, { maxPaths: 1, maxGroupSize: 200 });
        if (!candidates.length) continue;
        const top = candidates[0];
        paths.push({
            target: summarizeContact(target),
            intermediary: {
                name: top.intermediaryName,
                title: top.intermediaryTitle || null,
                company: top.intermediaryCompany || null,
                relationshipScore: top.intermediaryScore || 0,
            },
            sharedContext: top.sharedGroupsWithTarget[0] ? {
                label: groupLabel(top.sharedGroupsWithTarget[0].size || 999),
                groupSize: top.sharedGroupsWithTarget[0].size || null,
            } : null,
            reason: 'Warmer path through shared small-group context.',
            citation: {
                ref: 'goal:' + goal.id + ':intro:' + (paths.length + 1),
                source: 'group-memberships',
                field: 'sharedGroup',
                provenance: 'local-whatsapp-roster',
                groupSize: top.sharedGroupsWithTarget[0] ? top.sharedGroupsWithTarget[0].size || null : null,
            },
            citationRef: 'goal:' + goal.id + ':intro:' + (paths.length + 1),
        });
        if (paths.length >= 2) break;
    }
    return paths;
}

function chooseNextAction(goal, followUps, asks, paths) {
    if (followUps.length) {
        return {
            type: 'pipeline_follow_up',
            label: 'Follow up with ' + followUps[0].contact.name + ' for “' + goal.text + '”.',
            citationRef: followUps[0].citationRef,
        };
    }
    if (asks.length) {
        return {
            type: 'direct_ask',
            label: 'Ask ' + asks[0].contact.name + ' about “' + goal.text + '”.',
            citationRef: asks[0].citationRef,
        };
    }
    if (paths.length) {
        return {
            type: 'warm_intro_path',
            label: 'Ask ' + paths[0].intermediary.name + ' for context on ' + paths[0].target.name + '.',
            citationRef: paths[0].citationRef,
        };
    }
    return {
        type: 'no_action',
        label: 'No strong source-backed action found for “' + goal.text + '”.',
        citationRef: null,
    };
}

function buildAgentGoalActions(data, opts = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(c => c && !c.isGroup) : [];
    const goals = (Array.isArray(data.goals) ? data.goals : []).filter(g => g && g.active !== false && g.text);
    const goalQuery = String(opts.goal || '').trim().toLowerCase();
    const selected = goalQuery ? goals.filter(g => String(g.text || '').toLowerCase().includes(goalQuery)) : goals;
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 10) : 5;
    const nowMs = Date.parse(opts.now) || Date.now();
    const contactsById = new Map(contacts.map(c => [c.id, c]));
    const interactionsByContactId = byContactId(data.interactions);

    const briefs = selected.slice(0, limit).map(goal => {
        const assignedIds = new Set(Object.keys(goal.assignments || {}));
        const ranked = rankContactsForGoal(contacts, goal.text, 10);
        const retro = buildGoalRetro(goal, contacts, interactionsByContactId, new Set(['me']));
        const followUps = pipelineFollowUps(goal, contactsById, nowMs);
        const asks = directAsks(goal, ranked, assignedIds);
        const paths = introPaths(goal, ranked, contacts, data.groupMemberships || {}, assignedIds);
        return {
            goalId: goal.id,
            goalText: goal.text,
            status: followUps.length || asks.length || paths.length ? 'actionable' : 'weak',
            confidence: followUps.length || asks.length || paths.length ? 'medium' : 'low',
            nextAction: chooseNextAction(goal, followUps, asks, paths),
            pipelineFollowUps: followUps,
            directAsks: asks,
            introPaths: paths,
            diagnostics: {
                rankedContactsConsidered: ranked.length,
                assignedContacts: assignedIds.size,
                retroStatus: retro ? 'available' : 'missing',
            },
        };
    });

    return {
        status: briefs.length ? 'ok' : 'empty',
        briefs,
        generatedAt: new Date(nowMs).toISOString(),
        retrievalContract: {
            sourceBacked: briefs.some(b => b.status === 'actionable'),
            redacted: true,
            readOnly: true,
            confidenceRequiresLocalGoalData: true,
        },
        safety: {
            contactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'rawContact', 'rawMessageBody', 'chatId'],
            noLlmCalls: true,
            readOnly: true,
            noOutreachTriggered: true,
        },
    };
}

module.exports = { buildAgentGoalActions };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-goal-actions.js tests/unit/agent-goal-actions.test.js
git commit -m "feat: build agent goal action briefs"
```

---

### Task 3: Expose `goal_next_actions` through MCP

**Objective:** Register and execute a new MCP tool that returns the goal-action envelope from Task 2.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-68`
- Modify: `scripts/minty-mcp-server.js:95-184`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing MCP tests**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
it('lists the goal_next_actions MCP tool', async () => {
    const resp = handleMessage({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} }, {});
    assert.ok(resp.result.tools.some(t => t.name === 'goal_next_actions'));
});

it('returns redacted goal next actions from MCP', async () => {
    const resp = handleMessage({
        jsonrpc: '2.0',
        id: 78,
        method: 'tools/call',
        params: { name: 'goal_next_actions', arguments: { goal: 'seed', limit: 1 } },
    }, {
        contacts: [
            { id: 'c_1', name: 'Maya Partner', relationshipScore: 82, emails: ['maya@example.com'], sources: { linkedin: { position: 'Partner', company: 'Seed Fund' } } },
        ],
        interactions: [],
        insights: {},
        contactEvidence: {},
        goals: [{ id: 'g_1', text: 'raise seed round', active: true, assignments: { c_1: { stage: 'Contacted', updatedAt: '2026-05-01T00:00:00Z' } } }],
        groupMemberships: {},
    });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.briefs[0].nextAction.type, 'pipeline_follow_up');
    assert.equal(JSON.stringify(parsed).includes('maya@example.com'), false);
    assert.equal(parsed.safety.readOnly, true);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — the tool is not registered.

**Step 3: Add the MCP tool definition and execution branch**

At the top of `scripts/minty-mcp-server.js`, add:

```js
const { buildAgentGoalActions } = require('../crm/agent-goal-actions');
```

Add this object to `TOOLS`:

```js
{
    name: 'goal_next_actions',
    description:
        'Return read-only next actions for active Minty goals using local goal pipeline state, ranked contacts, and warm intro paths. ' +
        'Omit direct contact details and never trigger outreach.',
    inputSchema: {
        type: 'object',
        properties: {
            goal: { type: 'string', description: 'Optional substring filter for active goal text, e.g. "seed"' },
            limit: { type: 'number', description: 'Max goal briefs to return (1-10, default 5)' },
        },
    },
}
```

In `executeTool()`, normalize loaded data:

```js
const goals = Array.isArray(data.goals) ? data.goals : [];
const groupMemberships = (data.groupMemberships && typeof data.groupMemberships === 'object' && !Array.isArray(data.groupMemberships)) ? data.groupMemberships : {};
```

Then add a branch before the unknown-tool return:

```js
if (name === 'goal_next_actions') {
    const envelope = buildAgentGoalActions({
        contacts,
        interactions,
        goals,
        groupMemberships,
    }, {
        goal: typeof args.goal === 'string' ? args.goal : '',
        limit: clampLimit(args.limit, 5),
    });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

**Step 4: Run MCP tests**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/agent-goal-actions.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose goal next actions in MCP"
```

---

### Task 4: Document the Hermes workflow and run focused verification

**Objective:** Update agent-facing docs so Hermes users understand when to call `goal_next_actions` vs `workflow_brief`.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:100-113`
- Modify: `hermes/minty-network-memory/SKILL.md:11-52`
- Modify: `README.md` only if it already lists MCP tools in the same section

**Step 1: Update docs**

Add to `docs/HERMES_INTEGRATION.md` under “Available tools”:

```md
### goal_next_actions
Goal activation brief. Input: `{ goal?, limit? }`.
Returns active-goal next actions from local goal pipeline state, ranked contacts, and warm intro paths. Use this when Hermes needs “what should I do next for my current goals?” rather than a fresh open-ended search.
```

Add to `hermes/minty-network-memory/SKILL.md`:

````md
### goal_next_actions
Ask Minty for the next source-backed action on active goals.

```json
{ "goal": "seed", "limit": 3 }
```

Use this before inventing a plan from memory when the workflow is explicitly about Sree's current goals. Treat `status: "empty"` or `confidence: "low"` as a stop sign: ask for narrower goal context or sync data instead of hallucinating an action.
````

If Markdown fences nest awkwardly, use four backticks around the outer snippet while editing.

**Step 2: Run focused tests**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 3: Smoke the MCP tool with demo data**

Run:

```bash
npm run seed:demo
python3 - <<'PY' | CRM_DATA_DIR=./data-demo node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"goal-actions-smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"goal_next_actions","arguments":{"limit":1}}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY
```

Expected: JSON-RPC response for id `2` includes `"status"`, `"briefs"`, and `"safety"`; it must not include raw emails, phones, raw group chat IDs, or raw group names from fixtures.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md README.md tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js scripts/agent-query.js scripts/minty-mcp-server.js crm/agent-goal-actions.js
git commit -m "docs: document goal next actions MCP workflow"
```

---

## Verification checklist

Run before landing the feature branch:

```bash
node --test tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-retrieval.test.js
npm test
```

If the implementation touches the SPA or server routes unexpectedly, also run:

```bash
npm run test:e2e
```

Privacy checks:

- `JSON.stringify(goal_next_actions output)` contains no `emails`, `phones`, raw message bodies, raw contact objects, or group chat ids.
- Low-evidence goals return `status: "weak"` or top-level `status: "empty"`; do not fabricate a next action.
- Suggested actions remain advisory. No mutations, no outreach, no API calls.

## Non-goals

- No goal creation or stage mutation through MCP.
- No bulk outreach, message drafting, or automatic sending.
- No hosted/cloud dependency.
- No new CRM UI surface in this plan; the UI remains trust/debug/edit layer.
