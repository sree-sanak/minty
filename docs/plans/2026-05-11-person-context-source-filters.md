# Person Context Source Filters Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Let Hermes ask source-specific person-context questions like “what do I know about Alice from Telegram?” without falling back to cross-source/vibes context.

**Architecture:** Keep `search_network` / `workflow_brief` strict: explicit source filters must remain query-evidence gated. Add a narrower `person_context` source-filter path by extending `queryNetwork()` with an internal `allowProfileSourceMatches` option used only by MCP `person_context`. In that mode, source answerability still uses `source_health` freshness/configuration, but the per-person source match may be backed by safe profile/source presence or query evidence because person lookup is identity/context retrieval, not topical search.

**Tech Stack:** Plain Node.js CommonJS, MCP JSON-RPC server in `scripts/minty-mcp-server.js`, pure retrieval in `crm/agent-retrieval.js`, Node built-in test runner.

---

## Product framing

Recent source-quality work closed the big trust gaps: `source_health`, answerability gates, source attribution fields, citation/freshness preservation, and docs contracts are now present on `main`. The next remaining edge is smaller but real in Hermes workflows: after `workflow_brief` surfaces someone, Hermes often asks for deeper context about that person from a specific source.

Today `person_context` has no `source` / `sources` schema, ignores source arguments if a caller sends them anyway, and returns cross-source matches with no top-level `answerability`. A synthetic smoke on current `main` proved it:

```bash
node - <<'NODE'
const { handleMessage } = require('./scripts/minty-mcp-server');
const resp = handleMessage({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'person_context', arguments:{ person:'Alex', source:'telegram' } } }, {
  contacts: [
    { id:'c_tg', name:'Alex Telegram', sources:{ telegram:{ userId:'tg_private' } }, activeChannels:['telegram'], relationshipScore:80, daysSinceContact:2, interactionCount:2 },
    { id:'c_li', name:'Alex LinkedIn', title:'Founder', sources:{ linkedin:{ publicIdentifier:'li_private' } }, activeChannels:['linkedin'], relationshipScore:70, daysSinceContact:3, interactionCount:1 }
  ],
  interactions: [{ id:'i_tg', source:'telegram', type:'direct', contactId:'c_tg', body:'Discussed seed fundraising with Alex.' }],
  insights: {},
  nowForTests:'2026-05-10T00:00:00Z'
});
const parsed = JSON.parse(resp.result.content[0].text);
console.log(parsed.matches.map(m => m.name), parsed.answerability, parsed.diagnostics.sourceFilter);
NODE
```

Observed: both `Alex Telegram` and `Alex LinkedIn` are returned, `answerability` is absent, and `diagnostics.sourceFilter` is absent. That is worse than an honest empty state because the caller explicitly asked for source-scoped context.

## Related existing plans

- `docs/plans/2026-05-09-source-answerability-gate.md` gates source-scoped topical retrieval. This plan must not weaken that behavior.
- `docs/plans/2026-05-10-agent-result-source-attribution.md` adds safe display source labels. This plan reuses those fields for person context.
- `docs/plans/2026-05-09-agent-surface-docs-contract.md` keeps docs/skill aligned with actual tool inputs.

## Acceptance criteria

- MCP `person_context` schema accepts optional `source` and `sources`, matching `search_network` / `workflow_brief` source filter names.
- `person_context({ person, source })` passes source filters into retrieval and returns only source-matched people.
- Stale, missing, invalid, or empty source filters produce `matches: []` plus top-level `answerability.status === "blocked"`; raw invalid input is never echoed.
- Fresh source-matched person lookup returns `answerability.status === "answerable"` and each match has safe `matchedSources`, `answerSources`, and `sourceSummary`.
- For `person_context` only, source matching may use safe profile/source presence as identity evidence; `search_network` and `workflow_brief` continue requiring query-level evidence for explicit source filters. Add boundary tests that prove those tools still block profile-only source matches.
- Serialized MCP output excludes emails, phones, raw contact ids, interaction ids, source handles, message bodies, raw timestamps, token paths, private paths, URLs, and raw invalid input.
- Docs and the Hermes skill show `person_context` input as `{ person, limit?, source?, sources? }` and tell agents to preflight with `source_health` for source-specific person context.

## Non-goals

- Do not add a new MCP tool.
- Do not make broad `search_network` / `workflow_brief` source filters profile-backed; they stay evidence-gated.
- Do not expose raw source payloads, direct contact details, raw interaction text, group names, source IDs, calendar IDs, private paths, or invalid user input.
- Do not run live source syncs, mutate contacts, send messages, modify cron jobs, deploy, or touch private `data/` artifacts.

---

### Task 1: Add failing MCP tests for `person_context` source filters

**Objective:** Pin the source-filter contract at the MCP boundary before changing implementation.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Add this block near the existing `describe('search_network source filter', ...)` block:

```js
describe('person_context source filter', () => {
    it('person_context tool schema exposes optional source and sources args', () => {
        const tool = TOOLS.find(t => t.name === 'person_context');
        assert.ok(tool.inputSchema.properties.source, 'source property must exist in schema');
        assert.ok(tool.inputSchema.properties.sources, 'sources property must exist in schema');
        assert.equal(tool.inputSchema.properties.source.type, 'string');
        assert.deepEqual(tool.inputSchema.required, ['person']);
    });

    it('filters person_context matches by fresh source and exposes answerability', async () => {
        const contacts = [
            {
                id: 'pc_tg', name: 'Alex Source',
                sources: { telegram: { userId: 'tg_private_handle' } },
                activeChannels: ['telegram'], relationshipScore: 80,
                daysSinceContact: 2, interactionCount: 2,
                emails: ['alex-source@example.com'], phones: ['+155****0101'],
            },
            {
                id: 'pc_li', name: 'Alex Source',
                sources: { linkedin: { publicIdentifier: 'li_private_handle' } },
                activeChannels: ['linkedin'], relationshipScore: 75,
                daysSinceContact: 3, interactionCount: 1,
                emails: ['alex-li@example.com'], phones: [],
            },
        ];
        const interactions = [
            { id: 'i_pc_tg', source: 'telegram', type: 'direct', contactId: 'pc_tg', body: 'Discussed seed fundraising with Alex.' },
            { id: 'i_pc_li', source: 'linkedin', type: 'direct', contactId: 'pc_li', body: 'Discussed founder updates with Alex.' },
        ];

        const resp = await handleMessage({
            jsonrpc: '2.0', id: 140, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Alex Source', source: 'telegram', limit: 5 } },
        }, {
            contacts,
            insights: {},
            interactions,
            syncState: { telegram: { lastSyncAt: '2026-05-10T00:00:00Z' } },
            nowForTests: '2026-05-10T12:00:00Z',
        });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.matches.length, 1);
        assert.equal(parsed.matches[0].name, 'Alex Source');
        assert.deepEqual(parsed.matches[0].matchedSources, ['telegram']);
        assert.deepEqual(parsed.matches[0].answerSources, ['Telegram']);
        assert.equal(parsed.matches[0].sourceSummary, 'Telegram');
        assert.equal(parsed.answerability.status, 'answerable');
        assert.deepEqual(parsed.diagnostics.sourceFilter, ['telegram']);
        assertNoDirectContactDetails(parsed);
        const serialized = JSON.stringify(parsed);
        assert.equal(serialized.includes('tg_private_handle'), false);
        assert.equal(serialized.includes('li_private_handle'), false);
        assert.equal(serialized.includes('alex-source@example.com'), false);
        assert.equal(serialized.includes('pc_tg'), false);
        assert.equal(serialized.includes('pc_li'), false);
        assert.equal(serialized.includes('i_pc_tg'), false);
    });

    it('keeps search_network and workflow_brief evidence-gated for profile-only source matches', async () => {
        const context = {
            contacts: [{
                id: 'pc_profile_only', name: 'Profile Only Telegram',
                sources: { telegram: { userId: 'profile_only_private' } },
                activeChannels: ['telegram'], relationshipScore: 70,
                daysSinceContact: 5, interactionCount: 0,
            }],
            interactions: [],
            insights: {},
            syncState: { telegram: { lastSyncAt: '2026-05-10T00:00:00Z' } },
            nowForTests: '2026-05-10T12:00:00Z',
        };

        for (const toolName of ['search_network', 'workflow_brief']) {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 143, method: 'tools/call',
                params: { name: toolName, arguments: { query: 'Profile Only Telegram', goal: 'Find Profile Only Telegram', source: 'telegram' } },
            }, context);
            const parsed = JSON.parse(resp.result.content[0].text);
            const rows = parsed.results || parsed.people || parsed.matches || [];
            assert.deepEqual(rows, []);
            assert.equal(parsed.answerability.status, 'blocked');
            assert.equal(JSON.stringify(parsed).includes('profile_only_private'), false);
        }
    });

    it('blocks person_context when explicit source is stale', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 141, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Stale Telegram', source: 'telegram' } },
        }, {
            contacts: [{
                id: 'pc_stale', name: 'Stale Telegram',
                sources: { telegram: { userId: 'stale_private' } },
                activeChannels: ['telegram'], relationshipScore: 70,
                daysSinceContact: 2, interactionCount: 1,
            }],
            interactions: [{ id: 'i_stale', source: 'telegram', type: 'direct', contactId: 'pc_stale', body: 'Discussed payments.' }],
            syncState: { telegram: { lastSyncAt: '2026-04-01T00:00:00Z' } },
            nowForTests: '2026-05-10T12:00:00Z',
        });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.deepEqual(parsed.matches, []);
        assert.equal(parsed.answerability.status, 'blocked');
        assert.ok(parsed.answerability.warnings.includes('source_unhealthy'));
        assert.deepEqual(parsed.diagnostics.answerability, parsed.answerability);
        assert.equal(JSON.stringify(parsed).includes('stale_private'), false);
    });

    it('blocks person_context when explicit source health is missing', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 142, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Missing Health', source: 'telegram' } },
        }, {
            contacts: [{
                id: 'pc_missing_health', name: 'Missing Health',
                sources: { telegram: { userId: 'missing_health_private' } },
                activeChannels: ['telegram'], relationshipScore: 70,
                daysSinceContact: 2, interactionCount: 1,
            }],
            interactions: [{ id: 'i_missing_health', source: 'telegram', type: 'direct', contactId: 'pc_missing_health', body: 'Discussed payments.' }],
            syncState: {},
            nowForTests: '2026-05-10T12:00:00Z',
        });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.deepEqual(parsed.matches, []);
        assert.equal(parsed.answerability.status, 'blocked');
        assert.ok(parsed.answerability.warnings.includes('source_unhealthy'));
        assert.equal(JSON.stringify(parsed).includes('missing_health_private'), false);
    });

    it('fails closed for empty person_context source filters', async () => {
        for (const args of [
            { person: 'Alice', source: '' },
            { person: 'Alice', sources: [] },
        ]) {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 142, method: 'tools/call',
                params: { name: 'person_context', arguments: args },
            }, { contacts: [], interactions: [], syncState: {} });

            const parsed = JSON.parse(resp.result.content[0].text);
            assert.deepEqual(parsed.matches, []);
            assert.equal(parsed.answerability.status, 'blocked');
            assert.ok(parsed.answerability.warnings.includes('invalid_source'));
        }
    });

    it('fails closed for invalid person_context source filters without echoing input', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 142, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Alice', source: 'DROP TABLE telegram' } },
        }, { contacts: [], interactions: [], syncState: {} });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.deepEqual(parsed.matches, []);
        assert.equal(parsed.answerability.status, 'blocked');
        assert.ok(parsed.answerability.warnings.includes('invalid_source'));
        assert.equal(JSON.stringify(parsed).includes('DROP TABLE'), false);
    });
});
```

**Step 2: Run test to verify failure**

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: FAIL because `person_context` does not expose source schema, does not pass source filters to `queryNetwork()`, and does not return top-level `answerability`.

**Step 3: Commit**

```bash
git add tests/unit/minty-mcp-server.test.js
git commit -m "test: define person context source filters"
```

---

### Task 2: Add source filter inputs and pass them through `person_context`

**Objective:** Make MCP `person_context` accept the same safe source filter arguments as other retrieval tools.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Extend the tool schema**

In the `person_context` tool definition, replace the `properties` object with:

```js
properties: {
    person: { type: 'string', description: 'Person name to look up' },
    limit: { type: 'number', description: 'Max matches to return (default 3)' },
    source: { type: 'string', description: 'Restrict person context to a single source (telegram, whatsapp, linkedin, slack, email, sms, googlecontacts)' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Restrict person context to multiple sources (telegram, whatsapp, linkedin, slack, email, sms, googlecontacts)' },
},
```

**Step 2: Pass source filters to retrieval**

Inside `executeTool()`'s `person_context` branch, replace:

```js
const result = queryNetwork(person, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, syncState, nowForTests, limit });
```

with:

```js
const queryOpts = {
    contacts,
    insights,
    interactions,
    contactEvidence,
    sourceEvents,
    hybridIndex,
    syncState,
    nowForTests,
    limit,
    allowProfileSourceMatches: true,
};
if (args.source) queryOpts.source = args.source;
if (args.sources) queryOpts.sources = args.sources;
const result = queryNetwork(person, queryOpts);
```

Then add top-level `answerability` beside diagnostics in the envelope:

```js
const envelope = {
    person: result.query,
    matches,
    diagnostics: result.diagnostics,
    ...(result.answerability ? { answerability: result.answerability } : {}),
    safety: result.safety,
};
```

**Step 3: Run targeted test**

```bash
node --test --test-concurrency=1 tests/unit/minty-mcp-server.test.js
```

Expected: still FAIL on filtering/answerability until `queryNetwork()` supports `allowProfileSourceMatches`.

**Step 4: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: pass source filters into person context"
```

---

### Task 3: Support profile-backed source matching only for person context

**Objective:** Let source-scoped person lookup match known people by safe source/profile presence while keeping topical search filters evidence-gated.

**Files:**
- Modify: `crm/agent-retrieval.js`
- Test: `tests/unit/minty-mcp-server.test.js`
- Test: `tests/unit/agent-retrieval.test.js`

**Step 1: Add a pure retrieval regression**

In `tests/unit/agent-retrieval.test.js`, near source-filter tests, add:

```js
it('allows profile-backed source matches only when person context opts in', () => {
    const contacts = [{
        id: 'c_person_tg', name: 'Profile Telegram Person',
        sources: { telegram: { userId: 'private_tg' } },
        activeChannels: ['telegram'], relationshipScore: 75,
        daysSinceContact: 4, interactionCount: 1,
    }];
    const baseOpts = {
        contacts,
        interactions: [],
        source: 'telegram',
        syncState: { telegram: { lastSyncAt: '2026-05-10T00:00:00Z' } },
        nowForTests: '2026-05-10T12:00:00Z',
    };

    const strict = queryNetwork('Profile Telegram Person', baseOpts);
    assert.deepEqual(strict.results, []);
    assert.equal(strict.answerability.status, 'blocked');

    const personContext = queryNetwork('Profile Telegram Person', {
        ...baseOpts,
        allowProfileSourceMatches: true,
    });
    assert.equal(personContext.results.length, 1);
    assert.deepEqual(personContext.results[0].matchedSources, ['telegram']);
    assert.deepEqual(personContext.results[0].answerSources, ['Telegram']);
    assert.equal(personContext.answerability.status, 'answerable');
    assert.equal(JSON.stringify(personContext).includes('private_tg'), false);
});
```

**Step 2: Implement opt-in profile source matching**

In `queryNetwork()`, after `hasExplicitSourceFilter` is defined, add:

```js
const allowProfileSourceMatches = safeOpts.allowProfileSourceMatches === true;
// Internal opt-in for MCP person_context only. Never set this for search_network
// or workflow_brief; those tools must keep explicit source filters query-evidence gated.
```

After `queryMatchedSources` is built, add a helper for profile-backed person-context sources:

```js
function profileSourcesForResult(r) {
    if (!allowProfileSourceMatches || !sourceFilter) return [];
    const contact = contactsById[r.id];
    if (!contact) return [];
    return matchedSourcesForContact(contact, sourceFilter, {}, false);
}

const profileMatchedSources = Object.create(null);
if (allowProfileSourceMatches && sourceFilter) {
    for (const r of evidenced) {
        const sources = profileSourcesForResult(r);
        if (sources.length) profileMatchedSources[r.id] = sources;
    }
}
```

When building source answerability, include profile matches only for this opt-in mode:

```js
const answerabilityMatchedSources = allowProfileSourceMatches && sourceFilter
    ? [...new Set([
        ...queryMatchedSources.sources,
        ...Object.values(profileMatchedSources).flat(),
    ])].sort()
    : queryMatchedSources.sources;
```

Then pass `answerabilityMatchedSources` instead of `queryMatchedSources.sources` to `buildSourceAnswerability()`:

```js
queryMatchedSources: answerabilityMatchedSources,
```

Finally replace `matchedSourcesForResult()` with:

```js
function matchedSourcesForResult(r) {
    const evidenceMatched = sourceList(queryMatchedSources.byContact && queryMatchedSources.byContact[r.id]);
    if (evidenceMatched.length) {
        return sourceFilter ? evidenceMatched.filter(s => sourceFilter.includes(s)) : evidenceMatched;
    }
    if (allowProfileSourceMatches && sourceFilter) {
        return sourceList(profileMatchedSources[r.id]);
    }
    if (!sourceFilter) return undefined;
    return [];
}
```

Keep the result spread guarded against empty arrays:

```js
...(matchedSources && matchedSources.length ? { matchedSources, ...sourceDisplayFields(matchedSources) } : {}),
```

Do not export `allowProfileSourceMatches` through public CLI docs. It is an internal retrieval option so MCP `person_context` can model identity lookup without weakening normal topical search.

**Step 3: Run targeted tests**

```bash
node --test --test-concurrency=1 tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add crm/agent-retrieval.js scripts/minty-mcp-server.js tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: source-filter person context safely"
```

---

### Task 4: Update Hermes docs and skill for source-specific person context

**Objective:** Teach Hermes the new source-filtered person-context workflow and keep docs contract tests aligned.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Update integration docs**

In `docs/HERMES_INTEGRATION.md`, change the `person_context` tool section to:

```md
### person_context
Person lookup. Input: `{ person, limit?, source?, sources? }`.
Returns matching contacts with context, citations, freshness, safe source labels, and no emails/phones. Use `source` / `sources` only after `source_health` when the user asks for context from a specific source, for example “what do I know about Alice from Telegram?”.
```

**Step 2: Update Hermes skill**

In `hermes/minty-network-memory/SKILL.md`, change the `person_context` section example to include source filters:

````md
### person_context
Look up a specific person. Returns relationship context, warmth, evidence, safe source labels, and safe diagnostics.

```json
{ "person": "Alice Müller", "limit": 3 }
{ "person": "Alice Müller", "source": "telegram", "limit": 3 }
```

For source-specific person questions, call `source_health` first. If the source is stale, empty, or blocked, return the blocked state instead of merging in cross-source context.
````

The actual skill file can use normal triple fences; the four-backtick wrapper is only for this implementation-plan snippet.

**Step 3: Run docs contract and targeted MCP tests**

```bash
node --test --test-concurrency=1 tests/unit/agent-surface-docs.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js tests/unit/minty-mcp-server.test.js
git commit -m "docs: document source-filtered person context"
```

---

### Task 5: Final verification

**Objective:** Prove the new contract works without regressions.

**Files:**
- Verify only.

**Step 1: Run full unit suite**

```bash
npm test
```

Expected: PASS.

**Step 2: Run agent evals**

```bash
npm run network:evaluate
```

Expected: PASS; source-filter evals still treat topical search as evidence-gated.

**Step 3: Run a manual MCP smoke**

```bash
node - <<'NODE'
const { handleMessage } = require('./scripts/minty-mcp-server');
const resp = handleMessage({ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name:'person_context', arguments:{ person:'Alex', source:'telegram' } } }, {
  contacts: [
    { id:'c_tg', name:'Alex Telegram', sources:{ telegram:{ userId:'tg_private' } }, activeChannels:['telegram'], relationshipScore:80, daysSinceContact:2, interactionCount:2 },
    { id:'c_li', name:'Alex LinkedIn', sources:{ linkedin:{ publicIdentifier:'li_private' } }, activeChannels:['linkedin'], relationshipScore:70, daysSinceContact:3, interactionCount:1 }
  ],
  interactions: [{ id:'i_tg', source:'telegram', type:'direct', contactId:'c_tg', body:'Discussed seed fundraising with Alex.' }],
  insights: {},
  syncState: { telegram: { lastSyncAt: '2026-05-10T00:00:00Z' } },
  nowForTests:'2026-05-10T12:00:00Z'
});
const parsed = JSON.parse(resp.result.content[0].text);
console.log(JSON.stringify({
  names: parsed.matches.map(m => m.name),
  sources: parsed.matches.map(m => m.sourceSummary),
  answerability: parsed.answerability.status,
  diagnostics: parsed.diagnostics && parsed.diagnostics.sourceFilter,
  leaksPrivateHandle: JSON.stringify(parsed).includes('tg_private'),
}, null, 2));
NODE
```

Expected:

```json
{
  "names": ["Alex Telegram"],
  "sources": ["Telegram"],
  "answerability": "answerable",
  "diagnostics": ["telegram"],
  "leaksPrivateHandle": false
}
```

**Step 4: Check diff hygiene**

```bash
git diff --check HEAD~4..HEAD
```

Expected: no output.

**Step 5: Commit final verification note only if needed**

No extra commit is needed if the previous task commits already contain code/docs. If verification required a small fix, commit only that fix with a precise message.

---

## Implementation checklist

- [ ] `person_context` schema includes `source` and `sources`.
- [ ] `person_context` passes filters to `queryNetwork()` with `allowProfileSourceMatches: true`.
- [ ] `search_network` / `workflow_brief` remain strict and do not profile-match explicit source filters; boundary tests prove profile-only source matches stay blocked there.
- [ ] Source-stale, source-missing, source-empty, and source-invalid person context returns blocked empty state with no raw invalid input.
- [ ] Fresh source-matched person context returns safe source labels and top-level answerability.
- [ ] MCP output excludes emails, phones, raw contact IDs, interaction IDs, source handles, message bodies, token/private paths, and URLs.
- [ ] Docs and Hermes skill document the new source-specific person-context workflow.
- [ ] `npm test` and `npm run network:evaluate` pass.
