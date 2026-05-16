# Sources View Answerability Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Surface Minty's existing source-health answerability contract in the Sources view so a human can see which sources are trustworthy before asking Hermes/OpenClaw for source-specific network answers.

**Architecture:** Add a read-only `/api/source-health` endpoint in `crm/server.js` that reuses `buildAgentSourceHealth()` from `crm/agent-source-health.js` and existing local data loaders. Then render a compact readiness panel inside `crm/ui.html.js` using the same statuses/warnings/suggested next steps rather than inventing a separate UI-only model. Tests should prove the endpoint is privacy-safe and the browser code fetches/renders aggregate source readiness without changing MCP/CLI `source_health` behavior.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `createServer()` integration-test factory, existing SPA in `crm/ui.html.js`, existing `buildAgentSourceHealth()` / `buildSourceAnswerability()` helpers. No new dependencies, no provider calls, no runtime LLM calls.

---

## Product context

Issue #245 is the right next product gap after the source-depth/importer work. Minty's agent path now has `source_health`, answerability gates, citations/freshness, source attribution, meeting prep, intro paths, goal next actions, and local Discord/Slack/iMessage source depth. But the human Sources view still mostly shows connector/import status. That means a user can see “connected” while Hermes would correctly block a source-filtered answer because the source is stale, empty, has no evidence, or has a sync error.

This plan closes that trust gap without adding CRM busywork. The Sources view becomes the setup/trust/debug layer for the AI-native product: “Can Minty answer from this source right now?”

## Current-state evidence

- `crm/agent-source-health.js` already exposes `buildAgentSourceHealth()` and `buildSourceAnswerability()` with canonical source keys, freshness, counts, warnings, safety flags, and suggested next steps.
- `scripts/minty-mcp-server.js` already exposes MCP `source_health`; do not change its behavior for this UI slice.
- `crm/server.js:1938` has `handleGetSources()` for connector/import state and `ROUTES` registers `GET /api/sources` at `crm/server.js:3863`.
- `crm/server.js:3684-3697` shows the files needed for agent retrieval: contacts, interactions, `contact-evidence.json`, `source-events.json`, and `sync-state.json`.
- `crm/ui.html.js:5398-5405` currently loads only `/api/sources` and `/api/sync/status`; `makeSourceCard()` renders connected/not-connected and last-sync metadata, not answerability.
- Open GitHub issue #245 asks for a read-only Sources-view health panel backed by the existing privacy-safe source health summarizer.

## Acceptance criteria

- `GET /api/source-health` returns the same privacy-safe aggregate shape as `buildAgentSourceHealth()` for local UI use: top-level `status`, `sources`, `refresh`, and `safety`.
- The endpoint reads only local Minty JSON files and returns no raw contact IDs, names, emails, phones, source IDs/handles, message bodies, group names, local/private paths, OAuth/provider payloads, stack traces, credential-like values, or raw `sync-state.lastError` strings; expose only canonical warning codes and sanitized next steps.
- Sources view fetches `/api/source-health` alongside `/api/sources` and `/api/sync/status`.
- Each source card shows agent-relevant readiness: `Ready`, `Limited`, `Stale`, `Not configured`, or `Error`, plus aggregate counts and a safe next step when blocked/limited.
- The UI model uses existing source-health warnings/statuses; it must not create a separate readiness taxonomy that can drift from MCP.
- Existing `source_health` MCP/CLI behavior remains unchanged.
- Verification includes endpoint integration tests, existing `agent-source-health` unit tests, and e2e if UI rendering is touched.

## Non-goals

- No new MCP tool.
- No new source importer.
- No provider/OAuth changes, live API calls, scraping, webhooks, or sends.
- No source repair mutation from this panel. Buttons can remain existing reconnect/import actions; this plan only adds read-only readiness visibility.
- No raw data drilldown, message-body preview, contact-detail reveal, or private path display.
- No generic source-quality workbench yet; this is the narrow readiness/answerability slice.

---

### Task 1: Add a read-only source-health API route

**Objective:** Expose `buildAgentSourceHealth()` through the CRM server using the same local files agent retrieval already trusts.

**Files:**
- Modify: `crm/server.js`
- Test: `tests/integration/source-health-api.test.js`

**Step 1: Write failing integration test**

Create `tests/integration/source-health-api.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../../crm/server');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function request(server, urlPath) {
    const { port } = server.address();
    return fetch(`http://127.0.0.1:${port}${urlPath}`);
}

function seed(dir) {
    const unified = path.join(dir, 'unified');
    const freshSyncAt = new Date().toISOString();
    writeJson(path.join(unified, 'contacts.json'), [{
        id: 'raw_contact_private',
        name: 'Private Fixture Person',
        emails: ['fixture-person' + '@' + 'example.test'],
        phones: ['+12065550123'],
        sources: { telegram: { id: 'raw-telegram-user', handle: 'private_handle' } },
        activeChannels: ['telegram'],
        isGroup: false,
    }]);
    writeJson(path.join(unified, 'interactions.json'), [{
        contactId: 'raw_contact_private',
        source: 'telegram',
        timestamp: freshSyncAt,
        text: 'private message body should never leave endpoint',
    }]);
    writeJson(path.join(unified, 'contact-evidence.json'), {
        raw_contact_private: {
            sources: ['telegram'],
            topicEvidence: [{ topic: 'fundraising', sources: ['telegram'], count: 2, lastEvidenceAt: freshSyncAt }],
            confidence: 0.8,
        },
    });
    writeJson(path.join(unified, 'source-events.json'), [{
        source: 'telegram',
        kind: 'message',
        count: 2,
        lastEventAt: freshSyncAt,
    }]);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: { status: 'ok', lastSyncAt: freshSyncAt },
        // Raw provider errors are private diagnostics; the endpoint must expose only
        // canonical warning codes/sanitized next steps, never this string.
        linkedin: { status: 'error', lastError: 'token leaked at /private/local/path/export.json', lastSyncAt: '2026-01-01T00:00:00.000Z' },
    });
}

test('GET /api/source-health returns aggregate privacy-safe source readiness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-source-health-api-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, '/api/source-health');
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.safety.contactDetailsOmitted, true);
        assert.equal(payload.sources.telegram.status, 'ready');
        assert.equal(payload.sources.telegram.freshness, 'fresh');
        assert.equal(payload.sources.telegram.contactCount, 1);
        assert.ok(payload.sources.linkedin.warnings.includes('sync_error'));
        assert.ok(payload.sources.linkedin.suggestedNextStep);

        const serialized = JSON.stringify(payload);
        for (const forbidden of [
            'raw_contact_private',
            'Private Fixture Person',
            'fixture-person@example.test',
            '+12065550123',
            'raw-telegram-user',
            'private_handle',
            'private message body',
            '/private/local/path',
            'export.json',
            'token leaked',
        ]) {
            assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/source-health-api.test.js
```

Expected: FAIL with 404 for `/api/source-health`.

**Step 3: Implement endpoint**

In `crm/server.js`, add the import near other CRM helper imports:

```js
const { buildAgentSourceHealth } = require('./agent-source-health');
```

Add a small loader near `handleGetSources()` or near `handleNetworkQuery()`:

```js
function loadSourceHealthData(paths) {
    const unifiedDir = path.dirname(paths.contacts);
    const rawContactEvidence = readJsonIfExists(path.join(unifiedDir, 'contact-evidence.json'), {});
    const evidenceOverrides = readJsonIfExists(path.join(unifiedDir, 'evidence-overrides.json'), {});
    return {
        contacts: loadContacts(paths),
        interactions: readJsonIfExists(paths.interactions, []),
        contactEvidence: applyEvidenceOverrides({ contactEvidence: rawContactEvidence, overrides: evidenceOverrides }),
        sourceEvents: readJsonIfExists(path.join(unifiedDir, 'source-events.json'), []),
        syncState: readJsonIfExists(path.join(unifiedDir, '..', 'sync-state.json'), {}),
        memoryRefreshStatus: readJsonIfExists(path.join(unifiedDir, '..', 'memory-refresh-status.json'), {}),
    };
}

function handleGetSourceHealth(req, res, _params, paths) {
    const envelope = buildAgentSourceHealth(loadSourceHealthData(paths), { now: new Date().toISOString() });
    json(res, redactResponseStrings(envelope));
}
```

Register the route near `GET /api/sources`:

```js
['GET',  /^\/api\/source-health$/,                    handleGetSourceHealth],
```

Also update the no-data gate around `crm/server.js:4008` so this route works before contacts exist:

```js
const isSourceRoute = p.startsWith('/api/sources') || p === '/api/source-health';
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/integration/source-health-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/server.js tests/integration/source-health-api.test.js
git commit -m "feat: expose source health API"
```

---

### Task 2: Add UI state and safe rendering helpers for source answerability

**Objective:** Teach the Sources view to hold and render the source-health envelope without changing connector state behavior yet.

**Files:**
- Modify: `crm/ui.html.js`

**Step 1: Add helper tests through a minimal browser-smoke string check**

If there is no unit harness for inline SPA helpers, add assertions to the e2e task later. For this task, keep the change tiny and manually verify helper output by reloading the Sources view after Task 3.

**Step 2: Add state and helpers**

Near `sourceStatuses` / `syncStatuses` in `crm/ui.html.js`, add:

```js
let sourceHealth = { sources: {}, status: 'unknown', safety: {} };
```

Add helpers near `getSyncDotClass()`:

```js
function sourceHealthRow(key) {
  return (sourceHealth && sourceHealth.sources && sourceHealth.sources[key]) || null;
}

function sourceHealthBadge(row) {
  if (!row) return { label: 'Not checked', cls: 'idle' };
  if (row.status === 'ready') return { label: 'Ready for agents', cls: 'connected' };
  if (row.status === 'error') return { label: 'Error', cls: 'error' };
  if (row.status === 'stale') return { label: 'Stale', cls: 'pending' };
  if ((row.warnings || []).includes('not_configured')) return { label: 'Not configured', cls: 'idle' };
  return { label: 'Limited evidence', cls: 'pending' };
}

function sourceHealthDetail(row) {
  if (!row) return '';
  const parts = [];
  if (row.freshness) parts.push('freshness: ' + row.freshness);
  if (Number.isFinite(row.contactCount)) parts.push(row.contactCount.toLocaleString() + ' contacts');
  if (Number.isFinite(row.interactionCount)) parts.push(row.interactionCount.toLocaleString() + ' interactions');
  if (Number.isFinite(row.evidenceContactCount)) parts.push(row.evidenceContactCount.toLocaleString() + ' evidence-backed people');
  return parts.join(' · ');
}
```

**Step 3: Commit**

```bash
git add crm/ui.html.js
git commit -m "feat: add source health UI helpers"
```

---

### Task 3: Fetch `/api/source-health` in the Sources view

**Objective:** Load agent readiness alongside connector status, then show it inside each source card.

**Files:**
- Modify: `crm/ui.html.js`

**Step 1: Update `loadSources()`**

Change `loadSources()` from two fetches to three:

```js
async function loadSources() {
  const [sourcesData, syncData, healthData] = await Promise.all([
    fetch(BASE + '/api/sources').then(r => r.json()),
    fetch(BASE + '/api/sync/status').then(r => r.json()).catch(() => ({})),
    fetch(BASE + '/api/source-health').then(r => r.json()).catch(() => ({ sources: {}, status: 'unknown', safety: {} })),
  ]);
  sourceStatuses = sourcesData;
  syncStatuses = syncData;
  sourceHealth = healthData;
  renderSources();
  updateSyncStatusBar();
}
```

**Step 2: Render the badge and details**

In `makeSourceCard(key, meta)`, after `const syncState = syncStatuses[key] || {};`, add:

```js
const health = sourceHealthRow(key);
const healthBadge = sourceHealthBadge(health);
const healthLine = sourceHealthDetail(health);
const healthWarnings = (health?.warnings || []).slice(0, 3).map(w => w.replace(/_/g, ' ')).join(' · ');
const healthNextStep = health && health.status !== 'ready'
  ? '<div class="source-health-next">' + esc(health.suggestedNextStep || 'Refresh or reconnect this source before source-specific answers.') + '</div>'
  : '';
```

Then add this block inside the card template, after `metaLine` and before the description:

```js
    <div class="source-health-row">
      <span class="source-status ${healthBadge.cls}">${esc(healthBadge.label)}</span>
      ${healthLine ? '<span class="source-health-detail">' + esc(healthLine) + '</span>' : ''}
    </div>
    ${healthWarnings ? '<div class="source-health-warnings">' + esc(healthWarnings) + '</div>' : ''}
    ${healthNextStep}
```

**Step 3: Add minimal CSS**

Near existing Sources-view CSS, add:

```css
.source-health-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 6px; }
.source-health-detail { font-size:0.68rem; color:var(--text-muted); }
.source-health-warnings { font-size:0.68rem; color:#f59e0b; margin-bottom:6px; line-height:1.4; }
.source-health-next { font-size:0.68rem; color:var(--text-secondary); background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.16); border-radius:8px; padding:7px 9px; margin-bottom:10px; line-height:1.4; }
```

**Step 4: Manual browser verification**

Run:

```bash
npm run crm
```

Open `/` and switch to Sources. Expected: each card still renders existing connect/import controls, plus a readiness badge and aggregate counts/next-step text where applicable. Browser console should have no new JS errors.

**Step 5: Commit**

```bash
git add crm/ui.html.js
git commit -m "feat: show source answerability in Sources view"
```

---

### Task 4: Add e2e coverage for the Sources readiness panel

**Objective:** Prove the UI fetches and displays source-health answerability without leaking private fixture values.

**Files:**
- Modify or create: `tests/e2e/source-health.spec.js` or the existing Sources-view e2e smoke file if one already exists.

**Step 1: Locate existing Sources e2e smoke**

Run:

```bash
rg "Sources|source" tests/e2e
```

If an existing file opens the Sources view, extend it. Otherwise create `tests/e2e/source-health.spec.js` following existing e2e fixture/server patterns.

**Step 2: Add e2e assertion**

Use synthetic seeded data only. The test should:

1. start Minty with a temp data dir;
2. seed `unified/contacts.json`, `unified/interactions.json`, `unified/contact-evidence.json`, and `sync-state.json` for one fresh source and one stale/empty source;
3. open Sources;
4. assert visible text includes `Ready for agents` and either `Stale`, `Limited evidence`, or `Not configured`;
5. assert page text does not include raw fixture contact IDs, emails, phones, source handles, message bodies, or private paths.

**Step 3: Run focused e2e**

Run the project-specific e2e command if the repo has one for a single spec; otherwise:

```bash
npm run test:e2e
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tests/e2e/source-health.spec.js
# or the exact existing e2e file you modified
git commit -m "test: cover Sources source health panel"
```

---

### Task 5: Final verification and issue handoff

**Objective:** Ensure this remains a narrow, privacy-safe UI/API slice and document completion on issue #245.

**Files:**
- No required code files beyond previous tasks.

**Step 1: Run focused checks**

Run:

```bash
node --test tests/unit/agent-source-health.test.js tests/integration/source-health-api.test.js
npm test
npm run test:e2e
```

Expected: all pass.

**Step 2: Run privacy grep on changed UI/API/test output strings**

Run:

```bash
git diff --check main..HEAD
git diff --name-only main..HEAD
```

Manually inspect `crm/server.js`, `crm/ui.html.js`, and new tests for these forbidden classes:

- raw contact IDs in API/UI responses;
- direct names, emails, phones, or handles;
- raw message bodies;
- local/private paths;
- OAuth/provider payloads;
- stack traces or `err.message` from source providers.

**Step 3: Update issue #245 (optional handoff)**

If the implementation lands in a PR, prefer including `Refs #245` / `Closes #245` in the PR body and letting the PR discussion carry verification. If a maintainer wants an explicit issue update and GitHub mutation is allowed in that environment, comment on #245 with:

```bash
gh issue comment 245 --body "Implemented Sources-view source-health answerability panel. Verification: node --test tests/unit/agent-source-health.test.js tests/integration/source-health-api.test.js; npm test; npm run test:e2e. Privacy check: endpoint/UI return aggregate counts/status/warnings/next steps only, no raw contact/source/message details."
```

If `gh` auth is unavailable or external issue mutation is not desired, skip the command and include the same text in the PR/handoff instead.

**Step 4: Commit only if issue docs were changed locally**

No extra commit is needed unless you changed docs. The code/test commits above are sufficient.

---

## Verification checklist

- [ ] `GET /api/source-health` returns 200 with aggregate source rows.
- [ ] Endpoint output includes `safety.readOnly === true` and omits direct contact details/raw rows.
- [ ] Sources view loads successfully when `/api/source-health` fails or returns empty data.
- [ ] Sources view shows readiness badges and safe next steps for ready, limited, stale, not-configured, and error sources.
- [ ] Existing `/api/sources`, `/api/sync/status`, and MCP `source_health` behavior remain unchanged.
- [ ] `node --test tests/unit/agent-source-health.test.js tests/integration/source-health-api.test.js` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes if the UI was changed.

## Builder notes

- Reuse `buildAgentSourceHealth()` directly. If the UI needs different labels, translate labels in the browser only; do not fork source-health semantics.
- Do not show source health as “relationship health.” This is answerability/readiness: whether Minty has enough fresh evidence to answer source-specific network questions.
- Keep the primary action per source unchanged: connect, reconnect, import, or refresh. The new panel explains why that action matters for agent trust.
- If e2e setup is expensive, still land the endpoint integration test and UI helper logic with `npm test`; but run `npm run test:e2e` before merging because this touches the SPA.
