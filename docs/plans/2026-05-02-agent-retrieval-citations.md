# Agent Retrieval Citations Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make every Minty agent/MCP recommendation carry machine-readable citations, confidence drivers, and freshness/safety metadata so Hermes can distinguish trusted relationship context from weak guesses.

**Architecture:** Add a pure citation layer to `crm/query-reasons.js` and `crm/agent-retrieval.js` without changing storage formats or adding dependencies. Evidence reasons keep their existing human labels for UI compatibility, but also include internal `citation` objects with source type, field, private contact id, provenance, observed timestamp, and confidence impact. Before anything reaches MCP/Hermes-facing envelopes, private ids are converted to opaque citation refs that are unique across the response. MCP envelopes then expose a stable `retrievalContract` and refuse to label results “high confidence” unless they have at least one goal-relevant semantic citation tied to the parsed user goal/query terms, not merely any allowed contact metadata field.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `insights.json`, `crm/query-reasons.js`, `crm/agent-retrieval.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's pivot is not “a better CRM screen.” It is agent-native private network memory: Hermes asks, “who can help with this goal, why, and what should I do next?” Today the MCP surface exists (`search_network`, `person_context`, `workflow_brief`) and returns redacted evidence labels, but the trust contract is still too soft:

- evidence is mostly `{ kind, label, detail }`, not a citation Hermes can inspect;
- `confidence` can become `high` from blended scores even when provenance is weak;
- freshness is available per contact in loose fields, but not normalized as agent-facing metadata;
- `workflow_brief` compresses evidence labels into prose and drops citation structure.

That is the next product gap. Before adding more workflows, Minty needs a retrieval contract that makes agents safer: source-backed means source-backed, not “nice-sounding explanation.”

This plan complements existing plans:

- `2026-04-27-goal-match-evidence.md` makes human-facing goal recommendations explain why someone matches.
- `2026-04-30-agent-meeting-prep-mcp.md` adds a new meeting workflow.
- This plan tightens the shared retrieval envelope underneath existing MCP tools so every workflow can cite its claims.

Success criteria:

- `queryNetwork()` results include `citations[]`, `confidenceDrivers`, `freshness`, and a stricter `confidence` value.
- High confidence requires at least one goal-relevant semantic citation with concrete local provenance (`source`, `field`, `provenance`, and an opaque public ref), not just warmth or recency.
- `search_network`, `person_context`, and `workflow_brief` preserve citations instead of collapsing them into strings.
- Privacy remains intact: no emails, phone numbers, raw message bodies, raw contacts, raw calendar descriptions, or private contact ids enter agent-facing citations.
- Existing callers that read `evidence[]`, `warmth`, `suggestedAction`, and `safety` keep working.

---

### Task 1: Add citation helpers for query reasons

**Objective:** Attach machine-readable citations to reasons created by `crm/query-reasons.js` while preserving current labels.

**Files:**
- Modify: `crm/query-reasons.js:128-208`
- Test: `tests/unit/query-reasons.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/query-reasons.test.js`:

```js
test('[QueryReasons]: keyword reasons include contact-source citation metadata', () => {
    const parsed = { raw: 'stripe payments', roles: [], locations: [], intent: 'find' };
    const candidate = {
        id: 'c_stripe',
        name: 'Dana Stripe',
        company: 'Stripe',
        title: 'Payments Lead',
        relationshipScore: 70,
        daysSinceContact: 3,
    };
    const reasons = buildReasons(candidate, parsed, { contactsById: { c_stripe: candidate } });
    const keyword = reasons.find(r => r.kind === 'keyword');

    assert.ok(keyword, 'keyword reason exists');
    assert.deepEqual(keyword.citation, {
        source: 'contact',
        subjectId: 'c_stripe', // private; stripped before agent/MCP output
        field: 'company',
        provenance: 'local-contact',
        observedAt: null,
    });
});

test('[QueryReasons]: topic reasons cite insights topics without raw message bodies', () => {
    const parsed = { raw: 'crypto insurance', roles: [], locations: [], intent: 'find' };
    const candidate = { id: 'c_alice', name: 'Alice', relationshipScore: 60 };
    const reasons = buildReasons(candidate, parsed, {
        contactsById: { c_alice: candidate },
        insightsByContactId: { c_alice: { topics: ['crypto insurance'], analyzedAt: '2026-05-01T10:00:00Z' } },
    });
    const topic = reasons.find(r => r.kind === 'topic');

    assert.ok(topic, 'topic reason exists');
    assert.equal(topic.citation.source, 'insights');
    assert.equal(topic.citation.field, 'topics');
    assert.equal(topic.citation.subjectId, 'c_alice');
    assert.equal(topic.citation.observedAt, '2026-05-01T10:00:00Z');
    assert.equal(JSON.stringify(topic).includes('message'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/query-reasons.test.js
```

Expected: FAIL — citation fields are missing.

**Step 3: Add citation builders**

In `crm/query-reasons.js`, add helpers above `buildReasons()`:

```js
function citation(source, subjectId, field, provenance, observedAt = null) {
    return {
        source,
        subjectId: subjectId || null,
        field,
        provenance,
        observedAt: observedAt || null,
    };
}

function contactObservedAt(contact) {
    return contact?.updatedAt || contact?.lastContactedAt || null;
}

function citedReason(reason, cite) {
    return { ...reason, citation: cite };
}
```

Then update reason pushes:

```js
reasons.push(citedReason({
    kind: 'role',
    label: titleCase(r),
    detail: candidate.title ? candidate.title : (candidate.company ? 'at ' + candidate.company : null),
}, citation('contact', candidate.id, 'title', 'local-contact', contactObservedAt(contact || candidate))));
```

Use this mapping:

- role → `source: 'contact'`, `field: 'title'`, `provenance: 'local-contact'`
- location → `source: 'contact'`, `field: 'location'`, `provenance: 'local-contact'`
- keyword → derive field from `explainKeywordMatch()` by returning `{ label, field }` or a small helper; acceptable fields: `company`, `title`, `linkedin.company`, `linkedin.position`, `apollo.headline`, `apollo.industry`
- topic → `source: 'insights'`, `field: 'topics'`, `provenance: 'local-insight'`, `observedAt: insight.analyzedAt || null`
- warmth → `source: 'contact'`, `field: 'relationshipScore'`, `provenance: 'derived-local'`
- recent → `source: 'contact'`, `field: 'daysSinceContact'`, `provenance: 'derived-local'`

Do not include emails, phones, raw contact objects, or raw interaction bodies in citations.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/query-reasons.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/query-reasons.js tests/unit/query-reasons.test.js
git commit -m "feat: cite query evidence sources"
```

---

### Task 2: Normalize citations in the agent retrieval envelope

**Objective:** Expose stable `citations[]`, `freshness`, and `confidenceDrivers` on each `queryNetwork()` result.

**Files:**
- Modify: `crm/agent-retrieval.js:32-37` and `crm/agent-retrieval.js:137-158`
- Test: `tests/unit/agent-retrieval.test.js`

**Step 1: Write failing test**

Append inside `describe('agent-retrieval: queryNetwork()')` in `tests/unit/agent-retrieval.test.js`:

```js
it('returns citations, confidence drivers, and freshness metadata for agent trust', () => {
    const out = queryNetwork('payments infrastructure', { contacts: CONTACTS, insights: INSIGHTS });
    const result = out.results[0];

    assert.equal(result.name, 'Priya Payments');
    assert.equal('id' in result, false, 'agent-facing envelope omits private contact ids');
    assert.ok(Array.isArray(result.citations));
    assert.ok(result.citations.length > 0);
    assert.ok(result.citations.every(c => c.source && c.field && c.provenance && c.ref));
    assert.equal(result.citations.some(c => c.subjectId || c.contactId), false);
    assert.ok(Array.isArray(result.confidenceDrivers));
    assert.ok(result.confidenceDrivers.includes('cited_evidence'));
    assert.deepEqual(result.freshness, {
        daysSinceContact: 2,
        stale: false,
        oldestAllowedDays: 180,
    });
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js
```

Expected: FAIL — new fields are missing.

**Step 3: Add normalization helpers**

In `crm/agent-retrieval.js`, add near `confidenceLevel()`:

```js
function hasConcreteCitation(reason) {
    const c = reason && reason.citation;
    return !!(c && c.source && c.field && c.subjectId && c.provenance);
}

const SEMANTIC_CITATION_FIELDS = new Set([
    'title', 'location', 'company', 'linkedin.company',
    'linkedin.position', 'apollo.headline', 'apollo.industry', 'topics',
]);

function hasSemanticCitation(reason) {
    const c = reason && reason.citation;
    // The reason must have been produced by an actual parsed-goal/query match.
    // Do not count unrelated contact metadata just because its field is semantic.
    return hasConcreteCitation(reason) && SEMANTIC_CITATION_FIELDS.has(c.field);
}

const PUBLIC_CITATION_SOURCES = new Set(['contact', 'insights']);
const PUBLIC_CITATION_FIELDS = new Set([
    'title', 'location', 'company', 'linkedin.company',
    'linkedin.position', 'apollo.headline', 'apollo.industry',
    'topics', 'relationshipScore', 'daysSinceContact',
]);
const PUBLIC_CITATION_PROVENANCE = new Set(['local-contact', 'local-insight', 'derived-local']);
const PUBLIC_CITATION_SUPPORTS = new Set(['role', 'location', 'keyword', 'topic', 'warmth', 'recent']);

function publicCitation(reason, index, resultIndex = 0) {
    const c = reason.citation;
    if (!PUBLIC_CITATION_SOURCES.has(c.source)) return null;
    if (!PUBLIC_CITATION_FIELDS.has(c.field)) return null;
    if (!PUBLIC_CITATION_PROVENANCE.has(c.provenance)) return null;
    if (!PUBLIC_CITATION_SUPPORTS.has(reason.kind)) return null;
    return {
        ref: `result:${resultIndex + 1}:cite:${index + 1}`,
        source: c.source,
        field: c.field,
        provenance: c.provenance,
        observedAt: c.observedAt || null,
        supports: reason.kind,
    };
}

function publicCitations(reasons, resultIndex = 0) {
    return (reasons || []).reduce((out, reason) => {
        if (!hasConcreteCitation(reason)) return out;
        const mapped = publicCitation(reason, out.length, resultIndex);
        if (mapped) out.push(mapped);
        return out;
    }, []);
}

function hasPublicSemanticCitation(reason) {
    return hasSemanticCitation(reason) && !!publicCitation(reason, 0, 0);
}

function freshness(daysSinceContact, oldestAllowedDays = 180) {
    const days = daysSinceContact == null ? null : Number(daysSinceContact);
    return {
        daysSinceContact: Number.isFinite(days) ? days : null,
        stale: Number.isFinite(days) ? days > oldestAllowedDays : null,
        oldestAllowedDays,
    };
}

function confidenceDrivers(reasons, relationshipScore, fresh) {
    const drivers = [];
    if ((reasons || []).some(hasPublicSemanticCitation)) drivers.push('cited_evidence');
    if ((relationshipScore || 0) >= 50) drivers.push('warm_relationship');
    if (fresh && fresh.stale === false) drivers.push('recent_or_known_contact');
    if (fresh && fresh.stale === true) drivers.push('stale_contact_penalty');
    return drivers;
}

function agentConfidence(matchScore, relationshipScore, reasons, fresh) {
    const base = confidenceLevel(matchScore, relationshipScore);
    const cited = (reasons || []).some(hasPublicSemanticCitation);
    if (!cited) return 'low';
    if (fresh && fresh.stale === true && base === 'high') return 'medium';
    return base;
}
```

Then in the result map, include the result index so public citation refs are response-unique, and compute once:

```js
results.map((r, resultIndex) => {
    const fresh = freshness(r.daysSinceContact);
    const drivers = confidenceDrivers(r.reasons || [], r.relationshipScore, fresh);
    // ...existing result mapping...
});
```

Add fields inside that mapped result:

```js
confidence: agentConfidence(r.matchScore, r.relationshipScore, r.reasons || [], fresh),
confidenceDrivers: drivers,
citations: publicCitations(r.reasons || [], resultIndex),
freshness: fresh,
```

Keep the existing `evidence[]` field unchanged except it may now include no `citation` to preserve compatibility. Remove the private `id` field from the agent-facing result envelope (MCP already omits it); tests should assert private contact ids only remain inside internal reason citations. Confidence and MCP `sourceBacked` calculations must depend on public-safe mapped citations, not raw internal `reason.citation` objects.

**Step 4: Run tests**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js tests/unit/query-reasons.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-retrieval.js tests/unit/agent-retrieval.test.js
git commit -m "feat: expose agent retrieval citations"
```

---

### Task 3: Make confidence strict and test low-evidence behavior

**Objective:** Prevent warmth-only or generic fallback results from being presented as high-confidence agent facts.

**Files:**
- Modify: `tests/unit/agent-retrieval.test.js`
- Modify: `crm/agent-retrieval.js` only if tests expose gaps

**Step 1: Add guard tests**

Append inside the `queryNetwork()` describe block:

```js
it('does not assign high confidence without semantic citations', () => {
    const out = queryNetwork('contacts', { contacts: CONTACTS, insights: INSIGHTS });
    const uncited = out.results.find(r => r.citations.length === 0);

    assert.ok(uncited, 'fixture should include at least one generic uncited result');
    assert.equal(uncited.confidence, 'low');
    assert.equal(uncited.confidenceDrivers.includes('cited_evidence'), false);
});

it('downgrades stale cited contacts from high to medium confidence', () => {
    const contacts = [{
        id: 'c_stale', name: 'Stale Investor',
        sources: { linkedin: { position: 'Investor', company: 'Old Fund', location: 'London, UK' } },
        relationshipScore: 95, daysSinceContact: 365, interactionCount: 20,
    }];
    const out = queryNetwork('investor in London', { contacts, insights: {}, limit: 1 });

    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].freshness.stale, true);
    assert.notEqual(out.results[0].confidence, 'high');
    assert.ok(out.results[0].confidenceDrivers.includes('stale_contact_penalty'));
});
```

**Step 2: Run targeted tests**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js
```

Expected: PASS if Task 2 implemented strict confidence correctly; otherwise fix `agentConfidence()`.

**Step 3: Verify legacy exact-shape test**

The existing test `result envelope carries exact confidence and metadata for known contact` will need to include the new fields. Update its expected object rather than deleting the test. It should still verify:

- no emails or phones;
- existing fields keep their names;
- new `citations`, `confidenceDrivers`, and `freshness` are stable.

**Step 4: Run related tests**

Run:

```bash
node --test tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-retrieval.js tests/unit/agent-retrieval.test.js
git commit -m "test: enforce cited confidence for agent retrieval"
```

---

### Task 4: Preserve citations through MCP tool envelopes

**Objective:** Ensure `search_network`, `person_context`, and `workflow_brief` expose the new trust contract rather than dropping it in `safeResult()`.

**Files:**
- Modify: `scripts/minty-mcp-server.js:79-92` and `scripts/minty-mcp-server.js:141-148`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Add failing MCP tests**

Append to `tests/unit/minty-mcp-server.test.js` near existing tool-call tests:

```js
it('search_network MCP response includes citations and freshness metadata', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 41, method: 'tools/call',
        params: { name: 'search_network', arguments: { query: 'payments infrastructure', limit: 1 } },
    }, { contacts: CONTACTS, insights: INSIGHTS });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.ok(Array.isArray(parsed.results[0].citations));
    assert.ok(parsed.results[0].freshness);
    assert.ok(Array.isArray(parsed.results[0].confidenceDrivers));
    assert.equal(parsed.retrievalContract.sourceBacked, true);
    assert.equal(parsed.results[0].citations.some(c => c.subjectId || c.contactId), false);
});

it('workflow_brief keeps citation structure for top people', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 42, method: 'tools/call',
        params: { name: 'workflow_brief', arguments: { goal: 'payments infrastructure', limit: 1 } },
    }, { contacts: CONTACTS, insights: INSIGHTS });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.ok(Array.isArray(parsed.topPeople[0].citations));
    assert.ok(parsed.topPeople[0].confidence);
    assert.ok(parsed.topPeople[0].freshness);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — `safeResult()` and `workflow_brief` omit new fields.

**Step 3: Extend `safeResult()`**

In `scripts/minty-mcp-server.js`, update `safeResult(r)` to include:

```js
citations: Array.isArray(r.citations) ? r.citations : [],
confidenceDrivers: Array.isArray(r.confidenceDrivers) ? r.confidenceDrivers : [],
freshness: r.freshness || null,
evidenceBacked: r.evidenceBacked === true,
```

In `search_network` and `person_context` envelopes, add. Note that `sourceBacked: false` is allowed for low-confidence fallback/generic results; clients should treat that as weak evidence, not a failure:

```js
retrievalContract: {
    sourceBacked: result.results.every(r => (r.confidenceDrivers || []).includes('cited_evidence')) || result.results.length === 0,
    confidenceRequiresCitation: true,
    redacted: true,
    readOnly: true,
},
```

For `workflow_brief`, build `topPeople` with `safeResult(r)` plus `why`:

```js
const topPeople = result.results.map(r => ({
    ...safeResult(r),
    why: (r.evidence || []).map(e => e.label).join('; ') || 'No strong cited reason found',
}));
```

Keep the safety block unchanged.

**Step 4: Run MCP tests**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: preserve citations in MCP envelopes"
```

---

### Task 5: Document the retrieval contract for Hermes and MCP clients

**Objective:** Make agent-facing docs explain what `confidence`, `citations`, `freshness`, and safety fields mean.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:90-114`
- Modify: `docs/OPENCLAW_HERMES.md` around MCP tool and privacy sections
- Modify: `hermes/minty-network-memory/SKILL.md:54-60`

**Step 1: Update `docs/HERMES_INTEGRATION.md`**

Under “Privacy model,” add:

```md
## Retrieval contract

Minty MCP responses are structured retrieval envelopes, not free-form CRM summaries. `retrievalContract.sourceBacked` is true only when every returned result has semantic cited evidence; false means the client must describe the result as weak/uncited evidence.

- `citations[]` names the public-allowlisted local source family (`contact` or `insights`), field, provenance such as `derived-local`, an opaque response-unique `ref`, and observed timestamp when available. It must not include private contact ids.
- `confidence` is capped at `low` unless at least one semantic citation is tied to the parsed goal/query terms and supports the recommendation claim.
- `freshness.stale` tells agents whether relationship context is old enough to treat carefully.
- `retrievalContract.confidenceRequiresCitation` means Hermes should not present uncited results as facts.
- Contact details, raw contacts, raw message bodies, emails, phones, URLs, and outreach actions are omitted.
```

**Step 2: Update `hermes/minty-network-memory/SKILL.md`**

Under “Safety constraints,” add:

```md
6. **Trust citations over prose.** Treat `citations[]`, `confidence`, and `freshness` as the authority. If a result has no citations or low confidence, say Minty has weak evidence rather than presenting it as fact.
```

Under the workflow example, add:

```md
When drafting an answer, mention the strongest cited reason and the freshness status. Do not expose private contact ids to users; citation `ref` values are for debugging/traceability only.
```

**Step 3: Update `docs/OPENCLAW_HERMES.md`**

Add a short “Trust contract” section with the same semantics, but keep it public-safe: no private strategy notes, no Sree-specific examples.

**Step 4: Verify docs diff**

Run:

```bash
git diff -- docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
```

Expected: only public-safe documentation about agent retrieval fields.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document Minty agent retrieval contract"
```

---

### Task 6: Run full verification and citation smoke

**Objective:** Prove the new trust contract works end-to-end from CLI/MCP without leaking direct contact details.

**Files:**
- Modify only if tests expose bugs.

**Step 1: Run unit suite**

Run:

```bash
npm test
```

Expected: all unit tests PASS.

**Step 2: Seed demo data**

Run:

```bash
npm run seed:demo
```

Expected: demo data is generated under `data-demo/`.

**Step 3: Smoke CLI retrieval contract**

Run:

```bash
CRM_DATA_DIR=./data-demo node scripts/agent-query.js "who can help with crypto insurance" | python3 -c '
import json, re, sys
payload = json.load(sys.stdin)
assert "results" in payload
for result in payload["results"]:
    assert "citations" in result
    assert "freshness" in result
    assert "confidenceDrivers" in result
    assert "id" not in result
    text = json.dumps(result)
    assert "@" not in text
    assert not re.search(r"\b\+?\d[\d\s().-]{6,}\d\b", text)
    assert "contactId" not in text and "subjectId" not in text
print("agent retrieval contract ok")
'
```

Expected: prints `agent retrieval contract ok`.

**Step 4: Smoke MCP retrieval contract**

Run:

```bash
python3 -c '
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_network","arguments":{"query":"crypto insurance","limit":2}}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
' | CRM_DATA_DIR=./data-demo node scripts/minty-mcp-server.js | python3 -c '
import json, re, sys
responses = [json.loads(line) for line in sys.stdin if line.strip()]
call = next(r for r in responses if r.get("id") == 2)
payload = json.loads(call["result"]["content"][0]["text"])
assert payload["retrievalContract"]["confidenceRequiresCitation"] is True
for result in payload["results"]:
    assert "citations" in result
    assert "freshness" in result
    assert "id" not in result
    text = json.dumps(result)
    assert "contactId" not in text and "subjectId" not in text
    assert "@" not in text
    assert not re.search(r"\b\+?\d[\d\s().-]{6,}\d\b", text)
print("mcp retrieval contract ok")
'
```

Expected: prints `mcp retrieval contract ok`.

**Step 5: Verify final status**

Run:

```bash
git status --short --branch
```

Expected: clean working tree after the task commits.

---

## Verification checklist

After all tasks:

```bash
npm test
npm run seed:demo
CRM_DATA_DIR=./data-demo node scripts/agent-query.js "who can help with crypto insurance"
git status --short --branch
```

Expected:

- Unit tests pass.
- Agent CLI and MCP responses include `citations[]`, `freshness`, `confidenceDrivers`, and `retrievalContract` where applicable.
- `confidence: "high"` never appears on uncited results.
- Direct contact details remain omitted.
- Working tree is clean after task commits.

## Rollback plan

If the citation schema feels too heavy for first-release MCP clients, keep the internal `citation` metadata in `query-reasons.js` and `agent-retrieval.js`, but temporarily omit `retrievalContract` from MCP envelopes. Do not remove strict confidence gating; agents should not present high-confidence uncited results.
