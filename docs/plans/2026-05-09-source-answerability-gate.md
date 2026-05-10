# Source Answerability Gate Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make source-filtered `search_network` and `workflow_brief` refuse stale, empty, or non-evidence-bearing source requests with a machine-readable blocked empty state instead of returning plausible people.

**Architecture:** Reuse the existing `crm/agent-source-health.js#buildAgentSourceHealth()` and `buildSourceAnswerability()` helpers inside the agent retrieval/MCP path. `queryNetwork()` should compute a source-health preflight only when an explicit `source`/`sources` filter is supplied, run normal retrieval to check query-specific evidence, then replace results with an honest blocked envelope when the requested source is stale, missing, invalid, or lacks query-matched evidence. MCP should expose the same `answerability` object at top level for `search_network` and `workflow_brief`, and `workflow_brief` should accept `source`/`sources` filters so goal-first source-scoped workflows do not silently ignore source constraints.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `crm/agent-retrieval.js`, `crm/agent-source-health.js`, `scripts/minty-mcp-server.js`, `tests/unit/agent-retrieval.test.js`, `tests/unit/minty-mcp-server.test.js`, `tests/unit/evaluation.test.js`, `tests/fixtures/agent-workflows.json`.

---

## Product framing

Minty now has the raw pieces of the source trust contract: `source_health`, explicit source filters, safe `matchedSources`, source events, source answerability helper tests, and source-filter eval routing. The remaining product gap is enforcement at the answering layer. Today `buildSourceAnswerability()` exists, but `queryNetwork()` does not use it; `search_network` can still return people for an explicit source request when the source is stale/limited, and `workflow_brief` does not accept source filters at all.

That matters because Hermes/OpenClaw need a branching contract, not just prose. For a source-specific question, the right result is sometimes: “blocked, no fresh Telegram evidence; run `npm run memory:refresh` or call `source_health`.” Returning a warm LinkedIn/Email person in that case is worse than an empty state because it teaches the agent to trust stale/private-source guesses.

This complements, not duplicates:

- `2026-05-06-agent-source-health-mcp.md`: built the aggregate source readiness tool.
- `2026-05-08-source-filter-agent-evals.md`: routes evals through MCP and still needs richer source-filter fixtures.
- Current `main` already has `buildSourceAnswerability()` tests in `tests/unit/agent-source-health.test.js`; this plan wires that helper into retrieval and MCP envelopes.
- `2026-05-09-agent-surface-docs-contract.md`: keeps docs/skills aligned after this contract lands.

## Success criteria

- Explicit `source`/`sources` retrieval returns `results: []` when any requested source is invalid, stale, not configured, empty, or lacks query-matched evidence.
- Blocked retrieval includes `diagnostics.answerability` and top-level MCP `answerability` with `status: "blocked"`, `answerable: false`, safe canonical `sources`, warning codes, and `suggestedNextStep`.
- Answerable source-filtered retrieval includes `answerability.status: "answerable"`, `answerableSources`, and every result has `matchedSources` containing only requested safe source keys.
- `workflow_brief` accepts `source` and `sources`, passes them to `queryNetwork()`, returns empty `topPeople` when blocked, and exposes `answerability` for Hermes branching.
- No envelope exposes emails, phones, raw contact ids, source handles, group names, message bodies, token paths, private paths, or raw invalid input.
- `npm run network:evaluate` can include a blocked source-filter case without adding LLM calls or real data fixtures.

## Non-goals

- Do not add a new MCP tool; this is enforcement inside existing retrieval tools.
- Do not weaken source filters to “valid sources only” when the user supplied a mixed invalid list; mixed invalid filters still fail closed.
- Do not block unfiltered generic queries based on source health; the gate applies only to explicit source-scoped retrieval.
- Do not run live source syncs, mutate contacts, send messages, modify cron jobs, deploy, or touch private `data/` artifacts.
- Do not expose raw source-health rows beyond safe answerability metadata already allowed for agents.

---

### Task 1: Add failing retrieval tests for source answerability gating

**Objective:** Define the desired `queryNetwork()` contract before changing implementation.

**Files:**
- Modify: `tests/unit/agent-retrieval.test.js`
- Read-only dependency: `crm/agent-source-health.js`
- Test command reference: `package.json` `npm test` script already includes `tests/unit/agent-retrieval.test.js`

**Step 1: Write failing tests**

Append inside the existing `describe('queryNetwork'...)` area near the source-filter tests in `tests/unit/agent-retrieval.test.js`:

```js
it('blocks explicit source retrieval when the requested source is stale', () => {
    const contacts = [{
        id: 'c_stale_tg', name: 'Stale Telegram Person',
        sources: { telegram: { userId: 'tg_private' } }, activeChannels: ['telegram'],
        relationshipScore: 80, daysSinceContact: 1, interactionCount: 4,
    }];
    const interactions = [{
        id: 'i_stale_tg', source: 'telegram', type: 'direct', contactId: 'c_stale_tg',
        body: 'Discussed payments infrastructure.', timestamp: '2026-05-08T00:00:00Z',
    }];

    const out = queryNetwork('payments infrastructure', {
        contacts,
        interactions,
        source: 'telegram',
        syncState: { telegram: { lastSyncAt: '2026-04-01T00:00:00Z' } },
        nowForTests: '2026-05-09T00:00:00Z',
    });

    assert.deepEqual(out.results, []);
    assert.equal(out.diagnostics.answerability.status, 'blocked');
    assert.equal(out.diagnostics.answerability.answerable, false);
    assert.deepEqual(out.diagnostics.answerability.sources, ['telegram']);
    assert.ok(out.diagnostics.answerability.warnings.includes('no_recent_sync'));
});

it('blocks explicit source retrieval when no query-matched evidence exists for that source', () => {
    const contacts = [{
        id: 'c_tg_robotics', name: 'Telegram Robotics Person',
        sources: { telegram: { userId: 'tg_robotics' } }, activeChannels: ['telegram'],
        relationshipScore: 70, daysSinceContact: 2, interactionCount: 3,
    }];
    const interactions = [{
        id: 'i_tg_robotics', source: 'telegram', type: 'direct', contactId: 'c_tg_robotics',
        body: 'Discussed robotics tooling.', timestamp: '2026-05-08T00:00:00Z',
    }];

    const out = queryNetwork('defi lending', {
        contacts,
        interactions,
        source: 'telegram',
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z' } },
        nowForTests: '2026-05-09T00:00:00Z',
    });

    assert.deepEqual(out.results, []);
    assert.equal(out.diagnostics.answerability.status, 'blocked');
    assert.ok(out.diagnostics.answerability.warnings.includes('no_query_evidence'));
});

it('marks fresh source-filtered retrieval answerable when evidence matches the query', () => {
    const contacts = [{
        id: 'c_tg_defi', name: 'Telegram DeFi Person',
        sources: { telegram: { userId: 'tg_defi' } }, activeChannels: ['telegram'],
        relationshipScore: 70, daysSinceContact: 2, interactionCount: 3,
    }];
    const interactions = [{
        id: 'i_tg_defi', source: 'telegram', type: 'direct', contactId: 'c_tg_defi',
        body: 'Discussed DeFi lending protocols.', timestamp: '2026-05-08T00:00:00Z',
    }];

    const out = queryNetwork('defi lending', {
        contacts,
        interactions,
        source: 'telegram',
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z' } },
        nowForTests: '2026-05-09T00:00:00Z',
    });

    assert.equal(out.results.length, 1);
    assert.deepEqual(out.results[0].matchedSources, ['telegram']);
    assert.equal(out.diagnostics.answerability.status, 'answerable');
    assert.deepEqual(out.diagnostics.answerability.answerableSources, ['telegram']);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js
```

Expected: FAIL because `queryNetwork()` ignores `syncState` / `nowForTests` and never sets `diagnostics.answerability`.

**Step 3: Commit**

Do not commit RED separately unless the implementer wants explicit RED/GREEN commits. If committing RED:

```bash
git add tests/unit/agent-retrieval.test.js
git commit -m "test: define source answerability retrieval gate"
```

---

### Task 2: Wire source answerability into `queryNetwork()`

**Objective:** Enforce the existing source-health answerability helper inside source-filtered retrieval.

**Files:**
- Modify: `crm/agent-retrieval.js`
- Test: `tests/unit/agent-retrieval.test.js`

**Step 1: Import source-health helpers**

At the top of `crm/agent-retrieval.js`, add:

```js
const { buildAgentSourceHealth, buildSourceAnswerability } = require('./agent-source-health');
```

**Step 2: Accept sync state and deterministic time in options**

In `queryNetwork()`, extend the destructuring of `safeOpts` from:

```js
const { contacts: rawContacts, insights: rawInsights, interactions: rawInteractions, contactEvidence: rawContactEvidence, sourceEvents: rawSourceEvents, hybridIndex: rawHybridIndex, limit = 10 } = safeOpts;
```

to:

```js
const {
    contacts: rawContacts,
    insights: rawInsights,
    interactions: rawInteractions,
    contactEvidence: rawContactEvidence,
    sourceEvents: rawSourceEvents,
    hybridIndex: rawHybridIndex,
    syncState: rawSyncState,
    nowForTests,
    limit = 10,
} = safeOpts;
const syncState = rawSyncState && typeof rawSyncState === 'object' && !Array.isArray(rawSyncState) ? rawSyncState : {};
```

**Step 3: Compute query-matched sources after filtering**

After `filtered` is computed and before `page`, add the answerability check. Keep `filtered` mutable (`let filtered = evidenced;`) because the gate may replace it with an honest empty state. Declare `answerability` in the outer `queryNetwork()` scope so the final diagnostics spread can see it.

```js
const queryMatchedSources = sourceFilter
    ? [...new Set(filtered.flatMap(r => matchedSourcesForResult(r) || []))].sort()
    : [];
let answerability;
if (hasExplicitSourceFilter) {
    const health = buildAgentSourceHealth(
        { contacts, interactions, contactEvidence, sourceEvents, syncState },
        { sources: explicitSourceFilter.sources, now: nowForTests },
    );
    answerability = buildSourceAnswerability(health, {
        explicit: true,
        queryEvidenceChecked: invalidSourceFilters.length === 0,
        queryMatchedSources,
    });
    if (!answerability.answerable) filtered = [];
}
```

Important: keep invalid-source fail-closed behavior. When `invalidSourceFilters.length` is nonzero, `filtered` is already `[]`; the answerability object should still be blocked, include only canonical safe source keys/warning codes such as `invalid_source`, and must not echo raw invalid input.

**Step 4: Add answerability to diagnostics**

In the returned `diagnostics` object, add:

```js
...(answerability ? { answerability } : {}),
```

Do not add `answerability` for unfiltered queries.

**Step 5: Run test to verify pass**

Run:

```bash
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crm/agent-retrieval.js tests/unit/agent-retrieval.test.js
git commit -m "fix: gate source-filtered retrieval by answerability"
```

---

### Task 3: Expose top-level MCP answerability for `search_network`

**Objective:** Make Hermes branch on a stable top-level `answerability` field instead of digging through diagnostics.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing MCP test**

Append near the existing `describe('search_network source filter'...)` tests in `tests/unit/minty-mcp-server.test.js`:

```js
it('search_network returns top-level blocked answerability for stale source filters', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 91, method: 'tools/call',
        params: { name: 'search_network', arguments: { query: 'payments infrastructure', source: 'telegram' } },
    }, {
        contacts: [{
            id: 'c_stale_tg', name: 'Stale Telegram Person',
            sources: { telegram: { userId: 'tg_private' } }, activeChannels: ['telegram'],
            relationshipScore: 70, daysSinceContact: 2, interactionCount: 3,
        }],
        interactions: [{
            id: 'i_stale_tg', source: 'telegram', type: 'direct', contactId: 'c_stale_tg',
            body: 'Discussed payments infrastructure.', timestamp: '2026-05-08T00:00:00Z',
        }],
        syncState: { telegram: { lastSyncAt: '2026-04-01T00:00:00Z' } },
        nowForTests: '2026-05-09T00:00:00Z',
    });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.deepEqual(parsed.results, []);
    assert.equal(parsed.answerability.status, 'blocked');
    assert.equal(parsed.answerability.answerable, false);
    assert.ok(parsed.answerability.warnings.includes('no_recent_sync'));
    assertNoDirectContactDetails(parsed);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: FAIL because `search_network` returns answerability only inside diagnostics or not at all.

**Step 3: Pass sync state and top-level answerability through MCP**

In `scripts/minty-mcp-server.js#executeTool`, normalize `syncState` near the existing data loads:

```js
const syncState = (data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)) ? data.syncState : {};
```

In the `search_network` `queryOpts`, add:

```js
syncState,
nowForTests: data.nowForTests,
```

`nowForTests` must remain a test/eval data-injection field only; do not add it to any public MCP input schema or allow callers to spoof source freshness time.

In the `search_network` envelope, add:

```js
answerability: result.diagnostics && result.diagnostics.answerability,
```

If the value is `undefined`, omit it instead of serializing `null`:

```js
if (result.diagnostics && result.diagnostics.answerability) {
    envelope.answerability = result.diagnostics.answerability;
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "fix: expose MCP source answerability"
```

---

### Task 4: Add source filters and answerability to `workflow_brief`

**Objective:** Make goal-first source-scoped workflows enforce the same trust gate as `search_network`.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing schema and behavior tests**

Append in `tests/unit/minty-mcp-server.test.js` near other MCP schema/tool tests:

```js
it('workflow_brief tool schema exposes optional source and sources args', () => {
    const tool = TOOLS.find(t => t.name === 'workflow_brief');
    assert.ok(tool.inputSchema.properties.source, 'source property must exist in workflow_brief schema');
    assert.ok(tool.inputSchema.properties.sources, 'sources property must exist in workflow_brief schema');
    assert.equal(tool.inputSchema.properties.source.type, 'string');
});

it('workflow_brief respects source filters and returns blocked answerability', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 92, method: 'tools/call',
        params: { name: 'workflow_brief', arguments: { goal: 'Find people for payments infrastructure', source: 'telegram' } },
    }, {
        contacts: [{
            id: 'c_stale_tg', name: 'Stale Telegram Person',
            sources: { telegram: { userId: 'tg_private' } }, activeChannels: ['telegram'],
            relationshipScore: 70, daysSinceContact: 2, interactionCount: 3,
        }],
        interactions: [{
            id: 'i_stale_tg', source: 'telegram', type: 'direct', contactId: 'c_stale_tg',
            body: 'Discussed payments infrastructure.', timestamp: '2026-05-08T00:00:00Z',
        }],
        syncState: { telegram: { lastSyncAt: '2026-04-01T00:00:00Z' } },
        nowForTests: '2026-05-09T00:00:00Z',
    });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.deepEqual(parsed.topPeople, []);
    assert.equal(parsed.answerability.status, 'blocked');
    assert.deepEqual(parsed.diagnostics.sourceFilter, ['telegram']);
    assertNoDirectContactDetails(parsed);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: FAIL because `workflow_brief` schema does not expose source filters and does not pass them to `queryNetwork()`.

**Step 3: Update the `workflow_brief` schema**

In `scripts/minty-mcp-server.js`, add to the `workflow_brief` input schema `properties`:

```js
source: { type: 'string', description: 'Restrict the brief to a single source (telegram, whatsapp, linkedin, slack, email, sms, googlecontacts)' },
sources: { type: 'array', items: { type: 'string' }, description: 'Restrict the brief to multiple sources.' },
```

These args must be passed through the same canonical safe-source allowlist and invalid-source fail-closed path as `search_network`; arbitrary caller strings must never become raw envelope values.

**Step 4: Pass source filters to `queryNetwork()`**

Replace the `workflow_brief` call:

```js
const result = queryNetwork(goal, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, limit });
```

with:

```js
const queryOpts = { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, syncState, nowForTests: data.nowForTests, limit };
if (args.source) queryOpts.source = args.source;
if (args.sources) queryOpts.sources = args.sources;
const result = queryNetwork(goal, queryOpts);
```

Then add top-level answerability to the envelope when present:

```js
if (result.diagnostics && result.diagnostics.answerability) {
    envelope.answerability = result.diagnostics.answerability;
}
```

**Step 5: Run test to verify pass**

Run:

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "fix: enforce source answerability in workflow briefs"
```

---

### Task 5: Add deterministic eval coverage for blocked source answers

**Objective:** Make `npm run network:evaluate` catch regressions in source answerability envelopes.

**Files:**
- Modify: `tests/fixtures/agent-workflows.json`
- Modify: `tests/unit/evaluation.test.js` only if current evaluators cannot assert `answerability.status`
- Test command reference: `npm run seed:demo && npm run network:evaluate`

**Step 1: Inspect existing eval capabilities**

Run:

```bash
node --test --test-concurrency=1 tests/unit/evaluation.test.js
```

Expected: PASS baseline.

**Step 2: Add a blocked eval case**

Add a synthetic-only case to `tests/fixtures/agent-workflows.json` after the existing `telegram-source-health-mcp` case:

```json
{
    "name": "invalid-source-search-blocked",
    "target": "mcp:search_network",
    "arguments": {
        "query": "Who did I discuss DeFi lending with?",
        "source": "not-a-real-source"
    },
    "maxResults": 0,
    "disallowFallback": true,
    "requirePaths": [
        "safety.readOnly",
        "answerability.status",
        "diagnostics.invalidSourceFilters.0"
    ],
    "forbidPaths": ["results.0.name", "results.0.email", "results.0.phone"],
    "forbidSubstrings": ["not-a-real-source", "raw-phone-555-0101"]
}
```

If the current evaluator cannot assert exact values, do not overbuild a full assertion DSL. Add only the smallest helper needed in `crm/evaluation.js`, for example `expectPaths` as `{ "answerability.status": "blocked" }`, with tests in `tests/unit/evaluation.test.js`. Also assert that `answerability.suggestedNextStep` is sanitized enough for agent display: no raw private paths, token paths, raw invalid source strings, emails, phones, handles, or message text.

**Step 3: Run evals**

Run:

```bash
npm run seed:demo && npm run network:evaluate
```

Expected: PASS, with the new blocked case counted and no raw invalid source echoed.

**Step 4: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tests/fixtures/agent-workflows.json tests/unit/evaluation.test.js crm/evaluation.js
git commit -m "test: cover blocked source answerability evals"
```

---

## Final verification

Run the following before opening a PR:

```bash
node --test --test-concurrency=1 tests/unit/agent-source-health.test.js tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js tests/unit/evaluation.test.js
npm run seed:demo && npm run network:evaluate
npm test
git diff --check
```

If only `scripts/minty-mcp-server.js`, `crm/agent-retrieval.js`, tests, and `tests/fixtures/agent-workflows.json` changed, `npm run test:e2e` is optional because no browser UI/routes changed. Run it if the implementation also touches `crm/server.js`, `crm/ui.html.js`, or docs that change served UI behavior.

## Builder handoff notes

- Start from current `main`; do not duplicate `2026-05-08-source-filter-agent-evals.md` work. This plan assumes the source-health helper and MCP eval routing already exist.
- Keep all fixtures synthetic. Do not use Sree contacts, private paths, real source handles, raw chat names, message bodies, phone numbers, or emails.
- The first implementation pass should be small: enforce existing answerability, then expose it. Do not redesign scoring, ranking, source ingestion, or source-health semantics while implementing this plan.
- If an independent reviewer flags that `buildAgentSourceHealth()` treats missing sync state as blocked for synthetic tests, update the tests to pass explicit fresh `syncState` rather than weakening the product gate.
