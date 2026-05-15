# Memory Refresh Status in Source Health Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Finish the partially shipped memory-refresh diagnostics work by making `source_health` expose the latest privacy-safe refresh run summary, so Hermes can tell when network answers are blocked by a failed or stale refresh pipeline instead of guessing from source rows alone.

**Architecture:** The core refresh-status builder, CLI writer, and `npm run memory:refresh` shell integration already exist. The remaining work is narrow: load and sanitize `data/unified/memory-refresh-status.json` in `scripts/agent-query.js`, thread it into `crm/agent-source-health.js`, and expose the same redacted summary through the MCP `source_health` tool. No new MCP tool, no raw logs, no source rows, no token paths, and no private-brain paths.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, `scripts/agent-query.js`, `crm/agent-source-health.js`, `scripts/minty-mcp-server.js`, `tests/unit/agent-query.test.js`, `tests/unit/agent-source-health.test.js`, `tests/unit/minty-mcp-server.test.js`, and `docs/HERMES_INTEGRATION.md`.

---

## Current state evidence

Shipped since the original plan:

- `crm/memory-refresh-diagnostics.js` builds a redacted refresh report.
- `scripts/memory-refresh-diagnostics.js` writes `data/unified/memory-refresh-status.json`.
- `scripts/refresh-hermes-memory.sh` records refresh steps and writes diagnostics on exit.
- `tests/unit/memory-refresh-diagnostics.test.js` and `tests/unit/memory-refresh-diagnostics-cli.test.js` cover the core report/CLI behavior.
- Recent source-quality work shipped: `source_health`, source answerability gates, source attribution, GBrain export hardening, meeting prep, goal next actions, intro paths, and Gmail malformed-header resilience.

Verified remaining gap on current `main` (`27a939d`): a synthetic `data/unified/memory-refresh-status.json` is ignored by `loadData()`, and `buildAgentSourceHealth()` returns no `refresh` summary:

```json
{
  "hasRefreshStatus": false,
  "healthHasRefresh": false,
  "healthKeys": ["status", "sources", "invalidSourceFilters", "querySourceFilter", "safety"]
}
```

That matters because `source_health` can currently say a source has stale/no evidence, but it cannot tell Hermes whether the upstream refresh run itself failed at `google_contacts`, `telegram_live`, `merge`, `gbrain_export`, or `mcp_smoke`.

## Acceptance criteria

- `loadData(dataDir)` returns `memoryRefreshStatus` from `data/unified/memory-refresh-status.json` when present and valid.
- Malformed, missing, or unsafe refresh-status files degrade to `null`/`undefined` without throwing.
- `source_health` includes a top-level `refresh` object with only safe metadata:
  - `status`: `ok | warning | failed | unknown`
  - `failedStep`: safe step id or `null`
  - `generatedAt`: valid ISO string or `null`
  - `warnings`: bounded safe strings
  - `nextActions`: bounded safe strings
- If refresh status is `failed`, `source_health.status` becomes `warning` even when individual source rows look ready, and source rows get a `refresh_failed` warning only when useful for agent branching.
- MCP `source_health` preserves the same `refresh` object and never emits direct emails, phones, raw contact ids, source ids, token paths, private paths, raw messages, group ids/names, stack traces, or environment variable values.
- `docs/HERMES_INTEGRATION.md` tells Hermes to inspect `source_health.refresh` before answering source-specific questions after a failed refresh.

## Non-goals

- Do not add another MCP tool.
- Do not rerun sync/import commands from `source_health`; it remains read-only.
- Do not expose raw step logs, shell commands with user paths, source row samples, message bodies, private GBrain paths, OAuth token paths, emails, phones, or raw contact ids.
- Do not change ranking or source answerability semantics outside the refresh-status warning surface.
- Do not modify cron jobs or deployment configuration.

---

### Task 1: Load sanitized refresh status in `agent-query`

**Objective:** Make the existing agent data loader return a safe `memoryRefreshStatus` value.

**Files:**
- Modify: `scripts/agent-query.js`
- Test: `tests/unit/agent-query.test.js`

**Step 1: Write failing tests**

Add to `tests/unit/agent-query.test.js`:

```js
test('[AgentQuery]: loadData loads redacted memory refresh status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-refresh-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unified/contacts.json'), '[]');
    fs.writeFileSync(path.join(dir, 'unified/interactions.json'), '[]');
    fs.writeFileSync(path.join(dir, 'unified/memory-refresh-status.json'), JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-05-15T12:00:00.000Z',
        status: 'failed',
        failedStep: 'google_contacts',
        warnings: ['contacts_missing', 'unsafe-extra-warning-that-should-still-be-bounded'],
        nextActions: ['Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.'],
        safety: { redacted: true, privatePathsOmitted: true, directContactDetailsOmitted: true },
        rawPath: '/' + 'root/.hermes/private/brain/secret',
    }));

    const data = loadData(dir);

    assert.deepEqual(data.memoryRefreshStatus, {
        status: 'failed',
        failedStep: 'google_contacts',
        generatedAt: '2026-05-15T12:00:00.000Z',
        warnings: ['contacts_missing', 'unsafe-extra-warning-that-should-still-be-bounded'],
        nextActions: ['Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.'],
    });
    const serialized = JSON.stringify(data.memoryRefreshStatus);
    assert.equal(serialized.includes('/' + 'root/.hermes'), false);
    assert.equal(serialized.includes('rawPath'), false);
});

test('[AgentQuery]: loadData ignores malformed or unredacted refresh status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-refresh-bad-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unified/contacts.json'), '[]');
    fs.writeFileSync(path.join(dir, 'unified/interactions.json'), '[]');
    fs.writeFileSync(path.join(dir, 'unified/memory-refresh-status.json'), JSON.stringify({
        status: 'failed',
        failedStep: 'google_contacts',
        generatedAt: '2026-05-15T12:00:00.000Z',
        warnings: ['contacts_missing'],
        nextActions: ['Fix token at /' + 'root/.hermes/' + 'google_' + 'token.json'],
        safety: { redacted: false },
    }));

    const data = loadData(dir);

    assert.equal(data.memoryRefreshStatus, null);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: FAIL because `loadData()` does not return `memoryRefreshStatus`.

**Step 3: Implement the loader**

In `scripts/agent-query.js`, add helpers near `loadRootSyncState()`:

```js
const SAFE_REFRESH_STATUSES = new Set(['ok', 'warning', 'failed', 'unknown']);
const SAFE_REFRESH_STEPS = new Set([
    'google_contacts', 'telegram_live', 'telegram', 'merge', 'contact_evidence',
    'source_events', 'hybrid_index', 'query_index', 'gbrain_export', 'gbrain_import', 'mcp_smoke',
]);

function safeRefreshString(value, max = 220) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > max) return null;
    const privatePathPattern = "(?:/" + "root|/home/[^/\\s\"']+|/Users/[^/\\s\"']+)[^\\s\"']*";
    const tokenPathPattern = 'google_' + 'token';
    const secretNamePattern = '(?:TO' + 'KEN|SE' + 'CRET|PASS' + 'WORD|API[_-]?KEY|SES' + 'SION)';
    const forbidden = [
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
        /\+?\d[\d*\s().-]{6,}\d/,
        new RegExp(privatePathPattern),
        new RegExp(tokenPathPattern, 'i'),
        new RegExp(secretNamePattern, 'i'),
        /raw message/i,
        /group chat/i,
    ];
    return forbidden.some(re => re.test(text)) ? null : text;
}

function safeRefreshIso(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    const expectedMs = (match[7] || '').padEnd(3, '0');
    if (parsed.getUTCFullYear() !== Number(match[1])) return null;
    if (parsed.getUTCMonth() + 1 !== Number(match[2])) return null;
    if (parsed.getUTCDate() !== Number(match[3])) return null;
    if (parsed.getUTCHours() !== Number(match[4])) return null;
    if (parsed.getUTCMinutes() !== Number(match[5])) return null;
    if (parsed.getUTCSeconds() !== Number(match[6])) return null;
    if (String(parsed.getUTCMilliseconds()).padStart(3, '0') !== expectedMs) return null;
    return parsed.toISOString();
}

function sanitizeMemoryRefreshStatus(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const safety = parsed.safety && typeof parsed.safety === 'object' ? parsed.safety : {};
    if (safety.redacted !== true || safety.privatePathsOmitted !== true || safety.directContactDetailsOmitted !== true) return null;
    const status = SAFE_REFRESH_STATUSES.has(parsed.status) ? parsed.status : 'unknown';
    const failedStep = SAFE_REFRESH_STEPS.has(parsed.failedStep) ? parsed.failedStep : null;
    const warnings = Array.isArray(parsed.warnings)
        ? parsed.warnings.map(w => safeRefreshString(w, 120)).filter(Boolean).slice(0, 20)
        : [];
    const nextActions = Array.isArray(parsed.nextActions)
        ? parsed.nextActions.map(a => safeRefreshString(a, 220)).filter(Boolean).slice(0, 5)
        : [];
    return { status, failedStep, generatedAt: safeRefreshIso(parsed.generatedAt), warnings, nextActions };
}

function loadMemoryRefreshStatus() {
    const p = path.join(dataDir, 'unified', 'memory-refresh-status.json');
    if (!fs.existsSync(p)) return null;
    try {
        return sanitizeMemoryRefreshStatus(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
        return null;
    }
}
```

Then add to the returned object:

```js
memoryRefreshStatus: loadMemoryRefreshStatus(),
```

Update the JSDoc return shape to include `memoryRefreshStatus: object|null`.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-query.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/agent-query.js tests/unit/agent-query.test.js
git commit -m "feat: load memory refresh status for agents"
```

---

### Task 2: Add refresh summary to source health

**Objective:** Thread `memoryRefreshStatus` into `buildAgentSourceHealth()` as a safe top-level `refresh` summary.

**Files:**
- Modify: `crm/agent-source-health.js`
- Test: `tests/unit/agent-source-health.test.js`

**Step 1: Write failing tests**

Add to `tests/unit/agent-source-health.test.js`:

```js
test('[AgentSourceHealth]: includes failed refresh summary without private diagnostics', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c1', sources: { email: { label: 'safe' } } }],
        interactions: [{ source: 'email', contactId: 'c1' }],
        sourceEvents: [{ source: 'email', timestamp: '2026-05-15T10:00:00.000Z' }],
        contactEvidence: { c1: { sources: ['email'] } },
        syncState: { gmail: { lastSyncAt: '2026-05-15T09:00:00.000Z' } },
        memoryRefreshStatus: {
            status: 'failed',
            failedStep: 'google_contacts',
            generatedAt: '2026-05-15T12:00:00.000Z',
            warnings: ['contacts_missing'],
            nextActions: ['Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.'],
        },
    }, { source: 'email', now: '2026-05-15T12:30:00.000Z' });

    assert.equal(health.status, 'warning');
    assert.deepEqual(health.refresh, {
        status: 'failed',
        failedStep: 'google_contacts',
        generatedAt: '2026-05-15T12:00:00.000Z',
        warnings: ['contacts_missing'],
        nextActions: ['Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.'],
    });
    assert.ok(health.sources.email.warnings.includes('refresh_failed'));
    const serialized = JSON.stringify(health);
    assert.equal(serialized.includes('/' + 'root/.hermes'), false);
    assert.equal(serialized.includes('@'), false);
});

test('[AgentSourceHealth]: missing refresh status reports unknown without blocking ready source rows', () => {
    const health = buildAgentSourceHealth({
        contacts: [{ id: 'c1', sources: { email: { label: 'safe' } } }],
        interactions: [{ source: 'email', contactId: 'c1' }],
        sourceEvents: [{ source: 'email', timestamp: '2026-05-15T10:00:00.000Z' }],
        contactEvidence: { c1: { sources: ['email'] } },
        syncState: { gmail: { lastSyncAt: '2026-05-15T09:00:00.000Z' } },
    }, { source: 'email', now: '2026-05-15T12:30:00.000Z' });

    assert.equal(health.status, 'ok');
    assert.deepEqual(health.refresh, { status: 'unknown', failedStep: null, generatedAt: null, warnings: [], nextActions: [] });
    assert.equal(health.sources.email.warnings.includes('refresh_failed'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-source-health.test.js
```

Expected: FAIL because `refresh` is missing.

**Step 3: Implement source-health refresh summary**

Prefer exporting/reusing the refresh-summary sanitizer from the existing `crm/memory-refresh-diagnostics.js` (or a tiny shared helper owned by that module) so `agent-query`, `agent-source-health`, and MCP do not drift. The code below shows the required behavior; do not create weaker duplicate sanitizer variants.

In `crm/agent-source-health.js`, add or import:

```js
function safeRefreshString(value, max = 220) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text || text.length > max) return null;
    const forbidden = [
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
        /\+?\d[\d*\s().-]{6,}\d/,
        new RegExp("(?:/" + "root|/home/[^/\\s\\\"']+|/Users/[^/\\s\\\"']+)[^\\s\\\"']*"),
        new RegExp('google_' + 'token', 'i'),
        new RegExp('(?:TO' + 'KEN|SE' + 'CRET|PASS' + 'WORD|API[_-]?KEY|SES' + 'SION)', 'i'),
        /raw message/i,
        /group chat/i,
    ];
    return forbidden.some(re => re.test(text)) ? null : text;
}

function safeRefreshIso(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    const expectedMs = (match[7] || '').padEnd(3, '0');
    return parsed.getUTCFullYear() === Number(match[1])
        && parsed.getUTCMonth() + 1 === Number(match[2])
        && parsed.getUTCDate() === Number(match[3])
        && parsed.getUTCHours() === Number(match[4])
        && parsed.getUTCMinutes() === Number(match[5])
        && parsed.getUTCSeconds() === Number(match[6])
        && String(parsed.getUTCMilliseconds()).padStart(3, '0') === expectedMs
        ? parsed.toISOString()
        : null;
}

function safeRefreshSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { status: 'unknown', failedStep: null, generatedAt: null, warnings: [], nextActions: [] };
    }
    const status = ['ok', 'warning', 'failed', 'unknown'].includes(value.status) ? value.status : 'unknown';
    const failedStep = ['google_contacts', 'telegram_live', 'telegram', 'merge', 'contact_evidence', 'source_events', 'hybrid_index', 'query_index', 'gbrain_export', 'gbrain_import', 'mcp_smoke'].includes(value.failedStep) ? value.failedStep : null;
    const generatedAt = safeRefreshIso(value.generatedAt);
    const warnings = Array.isArray(value.warnings) ? value.warnings.map(w => safeRefreshString(w, 120)).filter(Boolean).slice(0, 20) : [];
    const nextActions = Array.isArray(value.nextActions) ? value.nextActions.map(a => safeRefreshString(a, 220)).filter(Boolean).slice(0, 5) : [];
    return { status, failedStep, generatedAt, warnings, nextActions };
}
```

Inside `buildAgentSourceHealth()`, after `syncState` is defined:

```js
const refresh = safeRefreshSummary(data.memoryRefreshStatus);
const refreshFailed = refresh.status === 'failed';
```

When building each source row, after the existing warnings are populated:

```js
if (refreshFailed) warnings.push('refresh_failed');
```

When returning the envelope, include `refresh` and make the top-level status warning when refresh failed:

```js
const hasWarning = Object.values(rows).some(r => r.warnings.length || r.status !== 'ready');
return {
    status: hasWarning || refreshFailed ? 'warning' : 'ok',
    sources: rows,
    invalidSourceFilters: [],
    querySourceFilter: Array.isArray(options.querySourceFilter) ? options.querySourceFilter : undefined,
    refresh,
    safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true, tokenPathsOmitted: true },
};
```

Export `safeRefreshSummary` only if tests need direct coverage; otherwise keep it private.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-source-health.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-source-health.js tests/unit/agent-source-health.test.js
git commit -m "feat: surface refresh status in source health"
```

---

### Task 3: Preserve refresh summary through MCP `source_health`

**Objective:** Ensure Hermes/OpenClaw receive the same `refresh` summary at the MCP boundary.

**Files:**
- Modify: `scripts/minty-mcp-server.js`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing test**

Add to the `source_health` describe block in `tests/unit/minty-mcp-server.test.js`:

```js
it('[MCP]: source_health includes redacted refresh status summary', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0',
        id: 1501,
        method: 'tools/call',
        params: { name: 'source_health', arguments: { source: 'email' } },
    }, {
        contacts: [{ id: 'raw_contact_id', name: 'Safe Person', emails: ['safe-person@example.com'], sources: { email: { label: 'safe' } } }],
        interactions: [{ source: 'email', contactId: 'raw_contact_id', body: 'raw message sentinel' }],
        contactEvidence: { raw_contact_id: { sources: ['email'] } },
        sourceEvents: [{ id: 'raw_event_id', source: 'email', timestamp: '2026-05-15T10:00:00.000Z' }],
        syncState: { gmail: { lastSyncAt: '2026-05-15T09:00:00.000Z' } },
        memoryRefreshStatus: {
            status: 'failed',
            failedStep: 'google_contacts',
            generatedAt: '2026-05-15T12:00:00.000Z',
            warnings: ['contacts_missing'],
            nextActions: ['Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.'],
        },
        nowForTests: '2026-05-15T12:30:00.000Z',
    });

    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.refresh.status, 'failed');
    assert.equal(parsed.refresh.failedStep, 'google_contacts');
    assert.ok(parsed.sources.email.warnings.includes('refresh_failed'));
    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes('safe-person@example.com'), false);
    assert.equal(serialized.includes('raw_contact_id'), false);
    assert.equal(serialized.includes('raw_event_id'), false);
    assert.equal(serialized.includes('raw message sentinel'), false);
    assert.equal(serialized.includes('/' + 'root/.hermes'), false);
});
```

If the existing MCP handler does not already forward `nowForTests`/`now` from the provided data/options into `buildAgentSourceHealth()`, add that wiring in the same tiny change; the test should fail only on missing refresh propagation, not on wall-clock freshness drift.

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL until `executeTool()` passes `memoryRefreshStatus` into `buildAgentSourceHealth()`.

**Step 3: Implement MCP threading**

In `scripts/minty-mcp-server.js`, update the destructuring at the top of `executeTool()` to include `memoryRefreshStatus` from `data`, then pass it into `buildAgentSourceHealth()`:

```js
const { contacts = [], insights = {}, interactions = [], contactEvidence = {}, sourceEvents = [], hybridIndex, syncState = {}, goals = [], groupMemberships = {}, memoryRefreshStatus = null } = data;
```

Change the source-health call from:

```js
{ contacts, interactions, contactEvidence, sourceEvents, syncState },
```

to:

```js
{ contacts, interactions, contactEvidence, sourceEvents, syncState, memoryRefreshStatus },
```

No extra MCP sanitizer should be necessary if Task 1 and Task 2 keep the object safe and bounded; the test above is the guardrail.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: preserve refresh diagnostics in MCP source health"
```

---

### Task 4: Document the Hermes operating rule

**Objective:** Make the agent-facing docs explicit that refresh status is part of the source-health trust contract.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Write failing docs contract test**

In `tests/unit/agent-surface-docs.test.js`, add or extend a test:

```js
test('[AgentSurfaceDocs]: source health docs mention refresh status', () => {
    const docs = fs.readFileSync(path.join(ROOT, 'docs/HERMES_INTEGRATION.md'), 'utf8');
    const skill = fs.readFileSync(path.join(ROOT, 'hermes/minty-network-memory/SKILL.md'), 'utf8');
    for (const text of [docs, skill]) {
        assert.match(text, /source_health/);
        assert.match(text, /refresh\.status|refresh status|memory refresh/i);
        assert.match(text, /npm run memory:refresh/);
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: FAIL until docs mention the new refresh summary rule.

**Step 3: Update docs and skill**

In `docs/HERMES_INTEGRATION.md`, update the `source_health` section:

```md
Returns redacted source rows with freshness, counts, evidence coverage, warnings, memory refresh status, and safe next-step commands. Use `refresh.status` before source-specific answers: if it is `failed`, explain the failed safe step and refresh/repair before trusting stale local data.
```

In `hermes/minty-network-memory/SKILL.md`, add to the operating rules:

```md
When `source_health.refresh.status` is `failed`, treat source-specific answers as blocked or stale until the listed safe next action has been run. Report the safe failed step (`failedStep`) and never infer from raw logs or private paths.
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: document refresh status source health contract"
```

---

### Task 5: Run focused verification

**Objective:** Prove the completed handoff preserves the agent trust contract without requiring real private data.

**Files:**
- No new files expected unless a previous task needs a small fix.

**Step 1: Run focused unit tests**

Run:

```bash
node --test \
  tests/unit/agent-query.test.js \
  tests/unit/agent-source-health.test.js \
  tests/unit/minty-mcp-server.test.js \
  tests/unit/agent-surface-docs.test.js \
  tests/unit/memory-refresh-diagnostics.test.js \
  tests/unit/memory-refresh-diagnostics-cli.test.js
```

Expected: PASS.

**Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

**Step 3: Commit verification-only fixes if needed**

Only if the verification uncovered a small bug in the previous tasks:

```bash
git add <exact files fixed>
git commit -m "fix: tighten refresh status source health contract"
```

---

## Privacy checklist for implementer

Before opening a PR, run:

```bash
git diff --check main..HEAD
node --test tests/unit/minty-mcp-server.test.js
node --test tests/unit/agent-source-health.test.js
```

Then inspect serialized MCP output from the new test and confirm it does **not** contain:

- raw contact ids or source event ids
- emails or phones
- token names, token paths, private paths, or private brain paths
- raw message bodies
- group ids or group names
- shell environment values
- stack traces or raw parser errors

## Builder note

This plan intentionally replaces the original broad memory-refresh diagnostics plan. Most of that plan is already shipped. Do not recreate the report builder or refresh shell integration; implement only the remaining handoff from `memory-refresh-status.json` into `source_health` and the MCP boundary.
