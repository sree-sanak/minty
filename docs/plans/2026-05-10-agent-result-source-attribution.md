# Agent Result Source Attribution Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make every evidence-backed agent result carry machine-readable safe source labels, even for unfiltered `search_network`, `person_context`, and `workflow_brief` calls.

**Architecture:** Minty already computes query-level evidence sources in `crm/agent-retrieval.js`, but currently only attaches `matchedSources` / `answerSources` / `sourceSummary` when an explicit source filter is present. Reuse the existing `collectQueryMatchedSources()` map to attach safe source labels for unfiltered evidence-backed results, while preserving strict source-filter answerability and never falling back to raw contact channels as evidence.

**Tech Stack:** Plain Node.js CommonJS, `node:test`, existing MCP JSON-RPC server, existing privacy helpers.

---

## Product framing

Recent work added `source_health`, source answerability gates, source-filtered retrieval, and user-facing source display labels. The remaining trust gap is the normal agent path: Hermes usually asks broad questions like “who can help with EU crypto insurance distribution?” without a `source` filter. Today those unfiltered results can include evidence labels such as “Telegram evidence” in prose, but omit the machine-readable `matchedSources`, `answerSources`, and `sourceSummary` fields that Hermes/OpenClaw should use in answers.

This makes source transparency inconsistent: source-filtered answers are easy to cite safely, while broad answers require an agent to infer provenance from free-form evidence text. The product should not teach agents to parse prose for trust metadata.

## Current-state evidence

On current `main`, this synthetic query returns Telegram evidence but no source fields:

```bash
node - <<'NODE'
const { queryNetwork } = require('./crm/agent-retrieval');
const out = queryNetwork('defi operators', {
  contacts: [{ id: 'c', name: 'Source Person', sources: { telegram: { userId: 'private' } }, activeChannels: ['telegram'], relationshipScore: 80, daysSinceContact: 2, interactionCount: 3 }],
  interactions: [{ id: 'i', source: 'telegram', type: 'direct', contactId: 'c', body: 'Discussed defi operators and distribution.' }],
  nowForTests: '2026-05-10T00:00:00Z'
});
console.log(out.results[0]);
NODE
```

Observed: `evidence[1].label === 'Telegram evidence'`, but `matchedSources`, `answerSources`, and `sourceSummary` are absent.

## Related existing plans

- `docs/plans/2026-05-09-source-answerability-gate.md` gates explicit source-filtered answers. This plan must not weaken it.
- `docs/plans/2026-05-09-agent-surface-docs-contract.md` keeps tool/docs/skill drift under test.
- `docs/plans/2026-05-08-source-filter-agent-evals.md` covers structured source-filter evals; this plan adds unfiltered source-attribution coverage.

## Acceptance criteria

- Unfiltered `queryNetwork()` results include safe `matchedSources`, `answerSources`, and `sourceSummary` when the match has query-level interaction/contact-evidence/hybrid evidence sources.
- Unfiltered results do **not** claim provenance from mere contact profile availability or `activeChannels` when no query-level evidence source exists.
- Explicit `source` / `sources` filters keep the current fail-closed behavior: stale/invalid/no-evidence filters return empty results with answerability metadata.
- MCP `search_network`, `person_context`, and `workflow_brief` preserve the new source fields where relevant.
- Serialized MCP output still excludes emails, phones, raw contact IDs, raw source handles, group names, raw message bodies, raw timestamps, private paths, URLs, and raw invalid input.
- Docs/skill text tells agents to prefer `sourceSummary` / `answerSources` for broad answers, not just source-scoped answers.

## Non-goals

- Do not add a new MCP tool.
- Do not add live source syncs, mutate contacts, send messages, modify cron jobs, deploy, or touch private `data/` artifacts.
- Do not expose raw evidence source payloads, channel names, message text, IDs, emails, phones, or URLs.
- Do not block unfiltered generic queries based on source health; answerability remains only for explicit source filters.
- Do not treat profile source availability as evidence provenance unless a future task names and tests a separate `profileSources` field.

---

### Task 1: Add failing unfiltered source-attribution tests in agent retrieval

**Objective:** Pin the desired source fields for broad evidence-backed results and prove profile-only matches do not overclaim sources.

**Files:**
- Modify: `tests/unit/agent-retrieval.test.js`

**Step 1: Write failing tests**

Add these tests near the existing source display label tests in the `agent-retrieval: source filters and answerability` describe block.

```js
it('adds safe source labels to unfiltered evidence-backed results', () => {
    const contacts = [{
        id: 'c_unfiltered_tg',
        name: 'Unfiltered Telegram Person',
        sources: { telegram: { userId: 'tg_private_handle' } },
        activeChannels: ['telegram'],
        relationshipScore: 80,
        daysSinceContact: 2,
        interactionCount: 3,
        emails: ['unfiltered-source@example.com'],
        phones: ['+15550001111'],
    }];
    const interactions = [{
        id: 'i_unfiltered_tg',
        source: 'telegram',
        type: 'direct',
        contactId: 'c_unfiltered_tg',
        body: 'Discussed defi market operators and distribution.',
    }];

    const out = queryNetwork('defi operators', {
        contacts,
        insights: {},
        interactions,
        nowForTests: '2026-05-10T00:00:00Z',
    });

    assert.equal(out.results.length, 1);
    assert.deepEqual(out.results[0].matchedSources, ['telegram']);
    assert.deepEqual(out.results[0].answerSources, ['Telegram']);
    assert.equal(out.results[0].sourceSummary, 'Telegram');
    const serialized = JSON.stringify(out.results[0]);
    assert.equal(serialized.includes('tg_private_handle'), false);
    assert.equal(serialized.includes('unfiltered-source@example.com'), false);
    assert.equal(serialized.includes('+15550001111'), false);
});

it('does not add unfiltered matchedSources from profile availability alone', () => {
    const contacts = [{
        id: 'c_profile_only',
        name: 'Profile Only Founder',
        title: 'Founder',
        sources: { linkedin: { publicIdentifier: 'private-linkedin-handle' } },
        activeChannels: ['linkedin'],
        relationshipScore: 55,
        daysSinceContact: 12,
        interactionCount: 0,
    }];

    const out = queryNetwork('founder', {
        contacts,
        insights: {},
        interactions: [],
        nowForTests: '2026-05-10T00:00:00Z',
    });

    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].matchedSources, undefined);
    assert.equal(out.results[0].answerSources, undefined);
    assert.equal(out.results[0].sourceSummary, undefined);
    assert.equal(JSON.stringify(out.results[0]).includes('private-linkedin-handle'), false);
});
```

**Step 2: Run test to verify failure**

```bash
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js
```

Expected: FAIL on the first new test because unfiltered evidence-backed results do not yet include `matchedSources` / `answerSources` / `sourceSummary`.

**Step 3: Commit**

```bash
git add tests/unit/agent-retrieval.test.js
git commit -m "test: define unfiltered agent source attribution"
```

---

### Task 2: Attach query-evidence sources for unfiltered results

**Objective:** Reuse existing query evidence source attribution for broad results without weakening explicit filters.

**Files:**
- Modify: `crm/agent-retrieval.js`

**Step 1: Implement minimal helper change**

Replace `matchedSourcesForResult()` inside `queryNetwork()` with this shape:

```js
function matchedSourcesForResult(r) {
    const contact = contactsById[r.id];
    const evidenceMatched = sourceList(queryMatchedSources.byContact && queryMatchedSources.byContact[r.id]);
    // sourceList() must normalize missing evidence to [] so this branch is safe
    // for contacts without query-level attribution.
    if (evidenceMatched.length) {
        const safeEvidenceSources = evidenceMatched.filter(isKnownSource);
        return sourceFilter ? safeEvidenceSources.filter(s => sourceFilter.includes(s)) : safeEvidenceSources;
    }
    if (!sourceFilter || !contact) return undefined;
    // Explicit source-filtered answers must be backed by query-level evidence,
    // not merely by profile/source availability on the contact record.
    return [];
}
```

Keep the existing result spread unchanged:

```js
...(matchedSources ? { matchedSources, ...sourceDisplayFields(matchedSources) } : {}),
```

Because an empty array is truthy in JavaScript, update the spread guard to avoid emitting empty fields:

```js
...(matchedSources && matchedSources.length ? { matchedSources, ...sourceDisplayFields(matchedSources) } : {}),
```

Do not use evidence-kind markers such as `interaction`, `contact-evidence`, or `hybrid` as display sources. Only canonical safe source keys accepted by `isKnownSource()` should reach `matchedSources` / `answerSources` / `sourceSummary`. Also verify the existing explicit-filter `answerability` metadata is still emitted from the source-filter branch even when `matchedSources` is an empty array and therefore suppressed from the result envelope. Concretely, do not gate `answerability` on `matchedSources`; keep it attached from the existing `sourceFilter ? { answerability: ... } : {}` branch (or equivalent) so filtered no-evidence/stale/invalid results still return a machine-readable blocked empty state.

**Step 2: Run targeted test**

```bash
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 3: Commit**

```bash
git add crm/agent-retrieval.js tests/unit/agent-retrieval.test.js
git commit -m "feat: expose evidence source labels on broad agent results"
```

---

### Task 3: Preserve MCP fields for `person_context` and broad search

**Objective:** Ensure the MCP boundary allows the new safe fields everywhere `safeResult()` can return them.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`
- Modify only if needed: `scripts/minty-mcp-server.js`

**Step 1: Write/update failing MCP tests**

In `tests/unit/minty-mcp-server.test.js`, add a broad `search_network` test near existing source display tests:

```js
it('broad search_network includes safe source display labels for evidence-backed results', async () => {
    const contacts = [{
        id: 'mcp_unfiltered_tg', name: 'MCP Telegram Person',
        sources: { telegram: { userId: 'mcp_private_handle' } },
        activeChannels: ['telegram'], relationshipScore: 70, daysSinceContact: 4, interactionCount: 2,
        emails: ['mcp-source@example.com'], phones: ['+15550002222'],
    }];
    const interactions = [{
        id: 'mcp_i_tg', source: 'telegram', type: 'direct', contactId: 'mcp_unfiltered_tg',
        body: 'Discussed defi distribution operators.',
    }];

    const resp = await handleMessage({
        jsonrpc: '2.0', id: 70, method: 'tools/call',
        params: { name: 'search_network', arguments: { query: 'defi operators' } },
    }, { contacts, insights: {}, interactions, nowForTests: '2026-05-10T00:00:00Z' });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.results.length, 1);
    assert.deepEqual(parsed.results[0].matchedSources, ['telegram']);
    assert.deepEqual(parsed.results[0].answerSources, ['Telegram']);
    assert.equal(parsed.results[0].sourceSummary, 'Telegram');
    assertNoDirectContactDetails(parsed);
    assert.equal(JSON.stringify(parsed).includes('mcp_private_handle'), false);
});
```

Update the existing `person_context` allowlist test so it permits safe source-display fields:

```js
const ALLOWED = new Set([
    'name', 'title', 'company', 'city', 'warmth', 'relationshipScore',
    'confidence', 'evidence', 'suggestedAction', 'daysSinceContact',
    'interactionCount', 'matchedSources', 'answerSources', 'sourceSummary',
]);
```

Add a `person_context` source-display test:

```js
it('person_context preserves safe source labels for evidence-backed matches', async () => {
    const contacts = [{
        id: 'mcp_pc_tg', name: 'Person Context Telegram',
        sources: { telegram: { userId: 'pc_private_handle' } },
        activeChannels: ['telegram'], relationshipScore: 70, daysSinceContact: 4, interactionCount: 2,
        emails: ['pc-source@example.com'], phones: ['+15550003333'],
    }];
    const interactions = [{
        id: 'pc_i_tg', source: 'telegram', type: 'direct', contactId: 'mcp_pc_tg',
        body: 'Discussed defi distribution operators.',
    }];

    const resp = await handleMessage({
        jsonrpc: '2.0', id: 71, method: 'tools/call',
        params: { name: 'person_context', arguments: { person: 'defi operators' } },
    }, { contacts, insights: {}, interactions, nowForTests: '2026-05-10T00:00:00Z' });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.matches.length, 1);
    assert.deepEqual(parsed.matches[0].answerSources, ['Telegram']);
    assert.equal(parsed.matches[0].sourceSummary, 'Telegram');
    assertNoDirectContactDetails(parsed);
    assert.equal(JSON.stringify(parsed).includes('pc_private_handle'), false);
});
```

Add a matching `workflow_brief` broad-query test that seeds one source-attributed synthetic contact and asserts each returned person preserves `answerSources` / `sourceSummary` while `assertNoDirectContactDetails(parsed)` still passes. This prevents `search_network` and `person_context` from drifting ahead of the brief surface. If `workflow_brief` uses a separate allowlist or mapper from `safeResult()`, update and test that boundary explicitly; do not assume the `person_context` allowlist change covers brief people.

```js
it('workflow_brief preserves safe source labels for broad evidence-backed people', async () => {
    const contacts = [{
        id: 'mcp_wb_tg', name: 'Workflow Brief Telegram',
        sources: { telegram: { userId: 'wb_private_handle' } },
        activeChannels: ['telegram'], relationshipScore: 72, daysSinceContact: 3, interactionCount: 2,
        emails: ['wb-source@example.com'], phones: ['+155****4444'],
    }];
    const interactions = [{
        id: 'wb_i_tg', source: 'telegram', type: 'direct', contactId: 'mcp_wb_tg',
        body: 'Discussed defi distribution operators.',
    }];

    const resp = await handleMessage({
        jsonrpc: '2.0', id: 72, method: 'tools/call',
        params: { name: 'workflow_brief', arguments: { goal: 'defi operators' } },
    }, { contacts, insights: {}, interactions, nowForTests: '2026-05-10T00:00:00Z' });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.people.length, 1);
    assert.deepEqual(parsed.people[0].answerSources, ['Telegram']);
    assert.equal(parsed.people[0].sourceSummary, 'Telegram');
    assertNoDirectContactDetails(parsed);
    assert.equal(JSON.stringify(parsed).includes('wb_private_handle'), false);
});
```

**Step 2: Run MCP test**

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: PASS. If it fails because `safeResult()` strips these fields, update `scripts/minty-mcp-server.js#safeResult()` to keep the already-redacted `answerSources` and `sourceSummary` fields. Do not expose any raw `sources` payload.

**Step 3: Commit**

```bash
git add tests/unit/minty-mcp-server.test.js scripts/minty-mcp-server.js
git commit -m "test: preserve source labels at MCP boundary"
```

---

### Task 4: Update docs and Hermes skill guidance

**Objective:** Teach agents to use source display fields for broad answers as well as source-scoped answers.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Modify if docs drift tests require it: `tests/unit/agent-surface-docs.test.js`

**Step 1: Patch docs**

In `docs/HERMES_INTEGRATION.md`, update the `search_network` / `person_context` / `workflow_brief` tool descriptions to say:

```md
When a result is backed by source-attributed evidence, prefer `sourceSummary` or `answerSources` for display. Use `matchedSources` only as a machine-readable safe key list. Do not parse free-form evidence labels to infer source provenance.
```

In `hermes/minty-network-memory/SKILL.md`, keep the existing source-label guidance and add:

```md
Broad, unfiltered queries should still show per-person source labels when Minty returns them. If a result has no `sourceSummary`, do not invent a source from the contact's known channels; say the evidence source is unspecified.
```

**Step 2: Run docs contract test**

```bash
node --test --test-concurrency=1 tests/unit/agent-surface-docs.test.js
```

Expected: PASS. If it fails on an exact text assertion, update only the expected safe documentation text.

**Step 3: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: clarify agent source label display contract"
```

---

### Task 5: Add deterministic eval coverage

**Objective:** Make source-attribution drift visible in the agent workflow eval path.

**Files:**
- Modify: `tests/fixtures/agent-workflows.json`
- Modify: `tests/unit/evaluation.test.js`

**Step 1: Add eval fixture case**

Append a synthetic broad query case that requires safe source labels but does not pass a `source` filter:

```json
{
  "name": "broad-query-source-labels",
  "target": "query_network",
  "arguments": { "query": "source-label-fixture defi operators" },
  "minResults": 1,
  "requirePaths": ["results.0.sourceSummary", "results.0.answerSources.0", "safety.readOnly"],
  "forbiddenSubstrings": ["@", "+1555000", "private_handle", "raw message"]
}
```

If the fixture data lacks matching source-labeled evidence, update the synthetic fixture setup in the eval tests, not real `data/`.

**Step 2: Run eval tests and demo eval**

```bash
node --test --test-concurrency=1 tests/unit/evaluation.test.js
npm run seed:demo
npm run network:evaluate
```

Expected: both pass, and `network:evaluate` reports no missing required paths for `broad-query-source-labels`.

**Step 3: Commit**

```bash
git add tests/fixtures/agent-workflows.json tests/unit/evaluation.test.js
git commit -m "test: cover source labels in broad agent evals"
```

---

### Task 6: Final verification and privacy scan

**Objective:** Prove the change is safe across targeted tests, full test suite, docs, and protocol smoke.

**Files:**
- No new files beyond prior tasks.

**Step 1: Run final checks**

```bash
node --check crm/agent-retrieval.js
node --check scripts/minty-mcp-server.js
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js tests/unit/evaluation.test.js tests/unit/agent-surface-docs.test.js
npm test
npm run network:evaluate
git diff --check
```

Expected: all pass.

**Step 2: Run protocol-level smoke without private data**

```bash
npm run seed:demo
python3 - <<'PY' | node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"source-label-smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_network","arguments":{"query":"crypto insurance"}}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY
```

Expected: protocol response contains valid JSON-RPC and no direct contact details. If demo fixtures do not contain matching source-labeled evidence, treat that as a demo-data gap for a separate plan; do not weaken the implementation.

**Step 3: Commit final cleanup if needed**

```bash
git status --short --branch
git commit -m "chore: verify agent source attribution" # only if prior verification required committed cleanup
```

---

## Reviewer checklist

- [ ] Unfiltered source labels come only from query-matched interaction/contact-evidence/hybrid evidence.
- [ ] Explicit source filters still fail closed on invalid, stale, empty, or no-query-evidence sources.
- [ ] `answerability` remains absent for unfiltered queries.
- [ ] MCP `safeResult()` allowlist includes only `matchedSources`, `answerSources`, and `sourceSummary` as new safe fields; it still strips `id`, `sources`, `activeChannels`, `emails`, `phones`, raw source handles, and raw interaction text.
- [ ] `person_context` and `workflow_brief` preserve source display fields where relevant.
- [ ] Docs and the Hermes skill tell agents not to infer source provenance from raw contact channels.
- [ ] No generated private `data/` files are staged.

## Handoff note

This is a small product-trust change, not a new workflow. It closes the gap between “Minty has evidence” and “Hermes can safely say which source backs each recommendation” for the default broad-query path.
