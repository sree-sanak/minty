# Agent Source Health MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a read-only `source_health` MCP tool so Hermes can tell whether Minty's local sources are fresh, usable, and safe to rely on before making network recommendations.

**Architecture:** Reuse existing local artifacts instead of adding another sync path: `data/sync-state.json`, `data/unified/contacts.json`, `interactions.json`, `contact-evidence.json`, `source-events.json`, and the current `queryNetwork()` source diagnostics. Add a pure `crm/agent-source-health.js` summarizer, extend `scripts/agent-query.js` to load sync state, expose `source_health` through `scripts/minty-mcp-server.js`, and document when Hermes should call it. The envelope must report counts, freshness buckets, warnings, and next safe commands without exposing contact details, raw source rows, token paths, message bodies, group names, emails, or phones.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `scripts/agent-query.js`, `scripts/minty-mcp-server.js`, `crm/agent-retrieval.js`, `data/sync-state.json`, `data/unified/contacts.json`, `interactions.json`, `contact-evidence.json`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`.

---

## Product framing

Minty's current agent surface can already answer network questions (`search_network`, `person_context`, `workflow_brief`) and existing plans cover citations, meeting prep, intro paths, goal next actions, and Hermes readiness. The remaining trust gap is narrower: before Hermes answers a source-specific question like “who did I talk to on Telegram?” or “do I have recent Gmail context?”, it has no first-class way to ask **which Minty sources are actually fresh and evidence-bearing right now**.

This matters because source quality is now the weekly reliability theme. Recent implementation work tightened source filters and incremental refresh safety, but the agent still has to infer source readiness from scattered diagnostics after it has already run a query. `source_health` makes source trust an explicit preflight and debug tool inside Hermes/OpenClaw workflows.

This complements, not duplicates, existing plans:

- The off-branch Hermes readiness doctor plan answers “is Minty generally demo/dogfood/Hermes ready?” from the CLI; restore it separately if readiness/install trust becomes the next bottleneck.
- `2026-05-02-agent-retrieval-citations.md` makes individual recommendations cite their evidence.
- Current source-filter work makes source-specific retrieval fail closed.
- This plan answers “which sources are queryable, stale, empty, or missing evidence right now?” via MCP, before or after a workflow query.

Success criteria:

- MCP `tools/list` includes `source_health` beside the existing tools.
- `source_health({})` returns one redacted source row per known source with `status`, `freshness`, `contactCount`, `interactionCount`, `evidenceContactCount`, `sourceEventCount`, `lastSyncAt`, `warnings`, and `suggestedNextStep`.
- `source_health({ source: "telegram" })` narrows to one source and fails closed for invalid source names without echoing the unsafe input.
- `source_health({ query: "telegram defi founders" })` narrows to the canonical source filter inferred by `queryNetwork()` diagnostics, after re-validating it through the shared fail-closed source allowlist, without returning people or raw evidence.
- Empty/stale sources return honest warnings such as `not_configured`, `no_contacts`, `no_recent_sync`, or `no_query_evidence`; no fabricated readiness.
- The serialized envelope never includes emails, phones, raw message bodies, raw contact ids, OAuth/token paths, file paths outside the repo data directory, group chat ids, or group names.

## Non-goals

- Do not trigger source refreshes. This tool is read-only; it may suggest `npm run service` or `npm run memory:refresh`, but must not run them.
- Do not replace `npm run hermes:doctor`; that command remains the broader install/readiness check.
- Do not expose per-contact sample rows, raw source diagnostics, token locations, or source file paths.
- Do not add runtime LLM calls or new npm dependencies.
- Do not build a UI screen in this plan; the MCP/Hermes workflow is the wedge.

---

### Task 1: Load sync state for agent/MCP tools

**Objective:** Make the shared agent data loader return redacted-ready sync state so MCP tools can reason about source freshness without separate file reads.

**Files:**
- Modify: `scripts/agent-query.js`
- Create: `tests/unit/agent-query.test.js`

**Step 1: Write failing tests**

Create `tests/unit/agent-query.test.js` if it does not exist. If it exists, append:

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

test('[AgentQuery]: loadData loads sync state for source health tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok', tokenPath: '/secret/token.json' },
    });

    const data = loadData(dir);

    assert.equal(data.syncState.telegram.lastSyncAt, '2026-05-06T07:00:00Z');
    assert.equal(data.syncState.telegram.status, 'ok');
    assert.equal(Object.hasOwn(data.syncState.telegram, 'tokenPath'), false);
});

test('[AgentQuery]: loadData falls back to empty sync state when missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);

    assert.deepEqual(loadData(dir).syncState, {});

    fs.writeFileSync(path.join(dir, 'sync-state.json'), '{not-json');
    assert.deepEqual(loadData(dir).syncState, {});
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: FAIL if `loadData()` does not yet return `syncState`.

**Step 3: Write minimal implementation**

In `scripts/agent-query.js`, update the `loadData()` JSDoc return shape to include `syncState: object`, then update `loadData()` so it reads root-level `sync-state.json` through a sanitizer with object fallback. Preserve existing contacts/insights/interactions/source-events/hybrid-index behavior.

```js
function loadData(dataDir) {
    function fallbackFor(file, missing = false) {
        if (file === 'insights.json' || file === 'contact-evidence.json') return {};
        if (missing && (file === 'source-events.json' || file === 'hybrid-index.json')) return undefined;
        return [];
    }
    function loadJson(file) {
        const p = path.join(dataDir, 'unified', file);
        if (!fs.existsSync(p)) return fallbackFor(file, true);
        try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (file === 'insights.json' || file === 'contact-evidence.json') {
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackFor(file, false);
            } else {
                if (!Array.isArray(parsed)) return fallbackFor(file, false);
            }
            return parsed;
        } catch {
            return fallbackFor(file, false);
        }
    }
    function sanitizeSyncState(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [source, state] of Object.entries(parsed)) {
            if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
            const row = {};
            for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt', 'lastSync', 'status']) {
                if (typeof state[key] === 'string' && state[key].length <= 128) row[key] = state[key];
            }
            if (Object.keys(row).length) out[source] = row;
        }
        return out;
    }
    function loadRootSyncState(file) {
        const p = path.join(dataDir, file);
        if (!fs.existsSync(p)) return {};
        try {
            return sanitizeSyncState(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch {
            return {};
        }
    }
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        interactions: loadJson('interactions.json'),
        contactEvidence: loadJson('contact-evidence.json'),
        sourceEvents: loadJson('source-events.json'),
        hybridIndex: loadJson('hybrid-index.json'),
        syncState: loadRootSyncState('sync-state.json'),
    };
}
```

If the current branch already has `goals`/`groupMemberships` loading from another plan, keep those fields and only add `syncState`.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-query.js tests/unit/agent-query.test.js
git commit -m "feat: load sync state for agent tools"
```

---

### Task 2: Create the pure source health summarizer

**Objective:** Add `buildAgentSourceHealth()` that converts local contacts, interactions, contact evidence, source events, sync state, and optional query diagnostics into a privacy-safe source readiness envelope.

**Files:**
- Create: `crm/agent-source-health.js`
- Test: `tests/unit/agent-source-health.test.js`

**Step 1: Write failing tests**

Create `tests/unit/agent-source-health.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentSourceHealth } = require('../../crm/agent-source-health');

const NOW = '2026-05-06T08:00:00Z';

function contact(overrides = {}) {
    return {
        id: 'c_private',
        name: 'Alice Private',
        emails: ['alice@example.com'],
        phones: ['+447700900123'],
        sources: { telegram: { username: 'alice_private' } },
        activeChannels: ['telegram'],
        ...overrides,
    };
}

test('[AgentSourceHealth]: summarizes fresh evidence-bearing source without PII', () => {
    const out = buildAgentSourceHealth({
        contacts: [contact()],
        interactions: [{ contactId: 'c_private', source: 'telegram', body: 'secret defi message', timestamp: '2026-05-06T07:30:00Z' }],
        contactEvidence: { c_private: { sources: ['telegram'], topics: ['defi'], updatedAt: '2026-05-06T07:35:00Z' } },
        sourceEvents: [{ source: 'telegram', contactId: 'c_private', text: 'private source event' }],
        syncState: { telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok', tokenPath: '/secret/token.json' } },
    }, { source: 'telegram', now: NOW });

    assert.equal(out.status, 'ok');
    assert.equal(out.sources.telegram.status, 'ready');
    assert.equal(out.sources.telegram.freshness, 'fresh');
    assert.equal(out.sources.telegram.contactCount, 1);
    assert.equal(out.sources.telegram.interactionCount, 1);
    assert.equal(out.sources.telegram.evidenceContactCount, 1);
    assert.equal(out.sources.telegram.sourceEventCount, 1);
    assert.equal(out.sources.telegram.lastSyncAt, '2026-05-06T07:00:00Z');

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('+447700900123'), false);
    assert.equal(serialized.includes('secret defi message'), false);
    assert.equal(serialized.includes('private source event'), false);
    assert.equal(serialized.includes('c_private'), false);
    assert.equal(serialized.includes('/secret/token.json'), false);
});

test('[AgentSourceHealth]: reports stale and empty sources honestly', () => {
    const out = buildAgentSourceHealth({
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: { email: { lastSyncAt: '2026-04-01T00:00:00Z', status: 'ok' } },
    }, { source: 'email', now: NOW });

    assert.equal(out.status, 'warning');
    assert.equal(Object.keys(out.sources).length, 1);
    assert.equal(out.sources.email.status, 'stale');
    assert.ok(out.sources.email.warnings.includes('no_contacts'));
    assert.ok(out.sources.email.warnings.includes('no_query_evidence'));
    assert.ok(out.sources.email.warnings.includes('no_recent_sync'));
});

test('[AgentSourceHealth]: invalid source filter fails closed without echoing input', () => {
    const out = buildAgentSourceHealth({ contacts: [], interactions: [], contactEvidence: {}, syncState: {} }, {
        source: 'telegram; alice@example.com',
        now: NOW,
    });

    assert.equal(out.status, 'error');
    assert.deepEqual(out.sources, {});
    assert.deepEqual(out.invalidSourceFilters, ['invalid']);
    assert.equal(JSON.stringify(out).includes('alice@example.com'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-source-health.test.js
```

Expected: FAIL — `Cannot find module '../../crm/agent-source-health'`.

**Step 3: Write minimal implementation**

Create `crm/agent-source-health.js`:

```js
'use strict';

const { canonicalSource: canonicalEvidenceSource } = require('./contact-evidence');

const KNOWN_SOURCES = ['email', 'googleContacts', 'linkedin', 'sms', 'telegram', 'whatsapp', 'slack'];
const KNOWN_SOURCE_KEYS = new Set(KNOWN_SOURCES.map(s => s.toLowerCase()));

function canonicalSource(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key === 'gmail') return 'email';
    if (key === 'googlecontact' || key === 'googlecontacts' || key === 'google') return 'googleContacts';
    const evidenceLabel = canonicalEvidenceSource(value);
    if (evidenceLabel && evidenceLabel !== 'interaction' && KNOWN_SOURCE_KEYS.has(evidenceLabel.toLowerCase())) return evidenceLabel;
    return null;
}

function normalizeSourceFilter(value) {
    if (value == null || value === '') return { sources: [], invalid: [] };
    const raw = Array.isArray(value) ? value : [value];
    const sources = new Set();
    const invalid = new Set();
    for (const item of raw) {
        const source = canonicalSource(item);
        if (source) sources.add(source);
        else invalid.add('invalid');
    }
    return { sources: [...sources].sort(), invalid: [...invalid].sort() };
}

function parseTime(value) {
    const t = Date.parse(value || '');
    return Number.isNaN(t) ? null : t;
}

function freshness(lastSyncAt, now) {
    const last = parseTime(lastSyncAt);
    if (!last) return 'unknown';
    const ageDays = Math.floor(((parseTime(now) || Date.now()) - last) / 86400000);
    if (ageDays <= 2) return 'fresh';
    if (ageDays <= 14) return 'aging';
    return 'stale';
}

function hasPayload(value) {
    return !!(value && typeof value === 'object' && Object.values(value).some(v =>
        v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
    ));
}

function contactSources(contact) {
    const out = new Set();
    for (const [source, payload] of Object.entries((contact && contact.sources) || {})) {
        const canonical = canonicalSource(source);
        if (canonical && hasPayload(payload)) out.add(canonical);
    }
    for (const channel of (contact && contact.activeChannels) || []) {
        const canonical = canonicalSource(channel);
        if (canonical) out.add(canonical);
    }
    return out;
}

function evidenceSources(evidence) {
    const out = new Set();
    for (const source of (evidence && evidence.sources) || []) {
        const canonical = canonicalSource(source);
        if (canonical) out.add(canonical);
    }
    for (const row of (evidence && evidence.topicEvidence) || []) {
        for (const source of row.sources || []) {
            const canonical = canonicalSource(source);
            if (canonical) out.add(canonical);
        }
    }
    return out;
}

function buildAgentSourceHealth(data = {}, options = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const interactions = Array.isArray(data.interactions) ? data.interactions : [];
    const sourceEvents = Array.isArray(data.sourceEvents) ? data.sourceEvents : [];
    const contactEvidence = data.contactEvidence && typeof data.contactEvidence === 'object' && !Array.isArray(data.contactEvidence)
        ? data.contactEvidence : {};
    const syncState = data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)
        ? data.syncState : {};
    const filter = normalizeSourceFilter(options.sources !== undefined ? options.sources : options.source);
    if (filter.invalid.length) {
        return {
            status: 'error',
            sources: {},
            invalidSourceFilters: filter.invalid,
            safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true },
        };
    }

    const discovered = new Set(KNOWN_SOURCES);
    for (const source of Object.keys(syncState)) {
        const canonical = canonicalSource(source);
        if (canonical) discovered.add(canonical);
    }
    const selected = filter.sources.length ? filter.sources : [...discovered].sort();
    const rows = {};

    for (const source of selected) {
        const contactCount = contacts.filter(c => contactSources(c).has(source)).length;
        const interactionCount = interactions.filter(i => canonicalSource(i && (i.source || i.channel)) === source).length;
        const sourceEventCount = sourceEvents.filter(e => canonicalSource(e && e.source) === source).length;
        const evidenceContactCount = Object.values(contactEvidence).filter(ev => evidenceSources(ev).has(source)).length;
        const rawState = syncState[source] || syncState[source.toLowerCase()] || syncState[source === 'email' ? 'gmail' : source] || syncState[source === 'googleContacts' ? 'googlecontacts' : source] || {};
        const lastSyncAt = rawState.lastSyncAt || rawState.lastSyncedAt || rawState.updatedAt || rawState.lastSync || null;
        const fresh = freshness(lastSyncAt, options.now);
        const warnings = [];
        if (!lastSyncAt) warnings.push('not_configured');
        if (!contactCount) warnings.push('no_contacts');
        if (!evidenceContactCount && !interactionCount && !sourceEventCount) warnings.push('no_query_evidence');
        if (fresh === 'stale' || fresh === 'unknown') warnings.push('no_recent_sync');
        const ready = warnings.length === 0 && fresh === 'fresh';
        rows[source] = {
            status: ready ? 'ready' : fresh === 'stale' ? 'stale' : warnings.length ? 'limited' : 'ready',
            freshness: fresh,
            contactCount,
            interactionCount,
            evidenceContactCount,
            sourceEventCount,
            lastSyncAt,
            warnings,
            suggestedNextStep: warnings.length ? 'Run npm run service or npm run memory:refresh, then retry the source-specific query.' : 'Safe to use for source-specific retrieval.',
        };
    }

    const hasWarning = Object.values(rows).some(r => r.warnings.length || r.status !== 'ready');
    return {
        status: hasWarning ? 'warning' : 'ok',
        sources: rows,
        invalidSourceFilters: [],
        querySourceFilter: Array.isArray(options.querySourceFilter) ? options.querySourceFilter : undefined,
        safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true, tokenPathsOmitted: true },
    };
}

module.exports = { buildAgentSourceHealth, canonicalSource, normalizeSourceFilter };
```

Keep implementation small, but do not create a divergent source allowlist. Reuse `crm/contact-evidence.js`'s exported `canonicalSource` and wrap it so unknown values fail closed for source-health filters instead of falling back to `interaction`.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-source-health.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-source-health.js tests/unit/agent-source-health.test.js
git commit -m "feat: add agent source health summary"
```

---

### Task 3: Expose `source_health` through MCP

**Objective:** Add the read-only MCP tool and wire it to the pure source health summarizer.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
test('[MCP]: lists source_health tool', () => {
    const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = response.result.tools.map(t => t.name);
    assert.ok(names.includes('source_health'));
});

test('[MCP]: source_health returns redacted source readiness', () => {
    const response = handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'source_health', arguments: { source: 'telegram' } },
    }, {
        contacts: [{ id: 'c_1', name: 'Alice', emails: ['alice@example.com'], sources: { telegram: { username: 'alice' } } }],
        interactions: [{ contactId: 'c_1', source: 'telegram', body: 'private body' }],
        contactEvidence: { c_1: { sources: ['telegram'] } },
        syncState: { telegram: { lastSyncAt: '2026-05-06T07:00:00Z', tokenPath: '/secret/token' } },
    });
    const parsed = JSON.parse(response.result.content[0].text);

    assert.equal(parsed.sources.telegram.contactCount, 1);
    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('private body'), false);
    assert.equal(serialized.includes('c_1'), false);
    assert.equal(serialized.includes('/secret/token'), false);
});
```

If the test file uses `describe/it` instead of `test`, follow the existing style but keep the assertions identical.

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — tool missing.

**Step 3: Wire MCP tool**

In `scripts/minty-mcp-server.js`:

1. Import the helper:

```js
const { buildAgentSourceHealth, normalizeSourceFilter } = require('../crm/agent-source-health');
```

2. Add tool definition:

```js
{
    name: 'source_health',
    description: 'Check which Minty sources are fresh, evidence-bearing, and safe for source-specific agent queries. Read-only and redacted.',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'Optional source filter, e.g. telegram, email, linkedin, whatsapp, sms, googlecontacts, slack' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Optional list of source filters.' },
            query: { type: 'string', description: 'Optional query to infer source filters from diagnostics without returning people.' },
        },
    },
}
```

3. In `executeTool()`, make sure `syncState` is pulled from data:

```js
const syncState = (data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)) ? data.syncState : {};
```

4. Add handler before the unknown-tool fallback:

```js
if (name === 'source_health') {
    let querySourceFilter;
    let inferredSources;
    if (args.query && typeof args.query === 'string' && args.query.trim()) {
        const result = queryNetwork(args.query.trim(), {
            contacts,
            insights,
            interactions,
            contactEvidence,
            sourceEvents,
            hybridIndex,
            limit: 1,
        });
        const rawFilter = result.diagnostics && result.diagnostics.sourceFilter;
        const normalized = normalizeSourceFilter(rawFilter);
        querySourceFilter = normalized.invalid.length ? ['invalid'] : normalized.sources;
        inferredSources = normalized.invalid.length ? ['invalid'] : normalized.sources;
    }
    const envelope = buildAgentSourceHealth({ contacts, interactions, contactEvidence, sourceEvents, syncState }, {
        source: args.source,
        sources: args.sources || inferredSources,
        querySourceFilter,
        now: data.nowForTests,
    });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

Do not pass raw query text into the returned envelope. Re-normalize inferred filters through `normalizeSourceFilter()` and expose only canonical source names; if diagnostics contain anything invalid, fail closed/sanitize to `invalid` rather than echoing raw values.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/agent-source-health.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose source health over MCP"
```

---

### Task 4: Document when Hermes should use source health

**Objective:** Teach humans and Hermes to call `source_health` before source-sensitive workflows and when retrieval evidence looks weak.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`

**Step 1: Update docs**

In `docs/HERMES_INTEGRATION.md`, add `source_health` under “Available tools”:

```md
### source_health
Source readiness preflight. Input: `{ source?, sources?, query? }`.
Returns redacted source rows with freshness, counts, evidence coverage, warnings, and safe next-step commands. Use it before source-specific questions like “who did I talk to on Telegram?” and when a query returns low evidence.
```

In `hermes/minty-network-memory/SKILL.md`, add this rule under “When to use” or “Safety constraints”:

```md
- Before source-specific queries (`telegram`, `gmail/email`, `linkedin`, `whatsapp`, `sms`, `slack`) call `source_health` if freshness or coverage matters. If the source is stale/empty, say so instead of answering from vibes.
```

Add an example:

```json
{ "source": "telegram" }
```

**Step 2: Verify docs mention the tool**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: PASS. No full test suite is required for docs-only edits, but this targeted test confirms the documented tool exists.

**Step 3: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document source health MCP workflow"
```

---

### Task 5: Final verification

**Objective:** Prove the new source-health workflow is deterministic, private, and compatible with existing agent retrieval.

**Files:**
- Verify only; no edits expected.

**Step 1: Run targeted tests**

Run:

```bash
node --test tests/unit/agent-query.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 2: Run full unit suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 3: Smoke MCP tools/list**

Run:

```bash
python3 - <<'PY' | node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"source-health-smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY
```

Expected: output contains `source_health`, `search_network`, `person_context`, and `workflow_brief`.

**Step 4: Commit verification notes if needed**

No commit is needed if no files changed. If implementation notes were added to docs, commit only those docs:

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: update source health verification notes"
```

---

## Builder handoff notes

- Implement in small commits exactly as above. Do not bundle source-health implementation with intro paths, goal actions, meeting prep, or readiness doctor work.
- Use synthetic fixtures only in tests. Never commit real `data/`, `data-demo/`, `data/gbrain/`, token paths, or private source rows.
- If the current branch already exposes `goals`, `groupMemberships`, or richer citation helpers, reuse them; do not regress those fields.
- Keep the returned envelope boring and machine-readable. Hermes needs reliable source state more than pretty prose.
