# Source Quality Workbench Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a narrow, privacy-safe Sources-view workbench that shows reviewable trust gaps before Hermes/OpenClaw answers from weak or stale relationship data.

**Architecture:** Create a pure `crm/source-quality-workbench.js` summarizer that composes existing source-health, identity-candidate, and evidence-review primitives into redacted review buckets. Expose it through a read-only `GET /api/source-quality/workbench` route in `crm/server.js`, then render a compact panel in the existing Sources view. This complements `/api/source-health` and `/api/evidence/review`; it does not add a new MCP tool or mutate sources.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `crm/agent-source-health.js`, `crm/identity-candidates.js`, `crm/evidence-review.js`, `crm/source-events.js`, `crm/server.js`, `crm/ui.html.js`, `tests/unit/`, `tests/integration/`. No new dependencies, no provider calls, no runtime LLM calls.

---

## Product context

Minty's current direction is right: agents should trust Minty as local private network memory, and the web UI should act as setup/trust/debug/edit surface rather than CRM busywork. Recent work added source-depth importers, shared importer contracts, source-health answerability, evidence review, and a Sources-view readiness plan. The remaining product gap is that these signals are scattered: Hermes can preflight with `source_health`, the Review screen can suppress bad topics, and identity review can find ambiguous duplicates, but a human cannot open one place and see “what would make agent answers less trustworthy right now?”

Issue #247 asks for that first narrow slice. This plan intentionally keeps it small: counts, safe source labels, opaque refs, warning codes, and local next steps. No raw message drilldown, no contact details, no repair buttons, no sends.

## Current-state evidence

- `crm/agent-source-health.js` already returns canonical per-source readiness rows with statuses, warnings, counts, freshness, and safe suggested next steps.
- `crm/identity-candidates.js` already computes conservative duplicate/identity review candidates. Its current output contains raw `contactIds`, so this workbench must wrap them in opaque refs and never serialize the raw IDs.
- `crm/evidence-review.js` already builds redacted topic-evidence rows for the Review surface. This workbench should reuse its shape for weak evidence summaries rather than exposing raw `contact-evidence.json` directly.
- `crm/server.js` already has route patterns for `/api/source-health` and `/api/evidence/review`; add a separate read-only route so the source-quality panel can evolve without changing MCP contracts.
- `crm/ui.html.js` Sources loading now fetches `/api/sources`, `/api/source-health`, and `/api/sync/status`; add one more read-only fetch for the workbench once the source-health Sources-view slice lands.
- `docs/plans/2026-05-16-sources-view-answerability.md` is the prerequisite UI trust slice. Implement that first; this plan is the next layer on top of it.

## Acceptance criteria

- `buildSourceQualityWorkbench()` returns a deterministic, privacy-safe envelope with:
  - `status`: `ok`, `needs_review`, or `empty`;
  - `summary`: counts for review buckets;
  - `buckets.identity`: ambiguous identity candidate rows with `pairRef`, opaque `contactRefs`, score, decision, and reason codes/details only;
  - `buckets.evidence`: weak evidence topic rows derived from existing evidence review rows, using `contactRef`, safe topic, safe source labels, count/confidence/freshness, and next local action;
  - `buckets.sources`: stale/unhealthy source rows derived from `buildAgentSourceHealth()` warning/status rows;
  - `buckets.ingestion`: missing/no-evidence/no-contact source rows derived from source-health warnings;
  - `safety`: explicit read-only/privacy guarantees.
- `GET /api/source-quality/workbench` returns that envelope using only local JSON files.
- Serialized output omits raw contact IDs, emails, phones, source IDs/handles, group names, message bodies, URLs/profile links, provider/OAuth payloads, token-shaped strings, stack traces, and local/private file paths.
- The Sources view shows a compact “Source quality workbench” panel with bucket counts and safe top rows, plus an honest “No reviewable source-quality gaps” empty state.
- Existing MCP `source_health`, agent retrieval answerability, `/api/source-health`, and `/api/evidence/review` behavior remain unchanged.
- Tests cover populated buckets, empty state, endpoint privacy, and UI helper rendering with synthetic fixtures only.

## Non-goals

- No new MCP tool or CLI command.
- No source repair mutation, import trigger, OAuth/provider action, webhook, scraping, live API call, telemetry, external send, or outreach automation.
- No raw message/contact drilldown and no contact-detail reveal.
- No broad source-quality workbench with editing workflows. This first slice is read-only visibility only.
- No change to identity merge decisions, evidence suppression decisions, or importer parsing.
- No generic plugin API.

---

### Task 1: Add pure source-quality workbench builder

**Objective:** Build a redacted summarizer that composes existing source health, evidence review, and identity candidate data into review buckets.

**Files:**
- Create: `crm/source-quality-workbench.js`
- Test: `tests/unit/source-quality-workbench.test.js`

**Step 1: Write failing tests**

Create `tests/unit/source-quality-workbench.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSourceQualityWorkbench } = require('../../crm/source-quality-workbench');

const NOW = '2026-05-16T12:00:00.000Z';

function fixture() {
    const recent = '2026-05-16T10:00:00.000Z';
    const stale = '2026-01-01T00:00:00.000Z';
    return {
        now: NOW,
        contacts: [
            {
                id: 'raw_contact_alpha',
                name: 'Ada Private',
                emails: ['ada-private' + '@' + 'example.test'],
                phones: ['+15555550123'],
                company: 'Example Labs',
                sources: { telegram: { id: 'raw_telegram_id', handle: 'private_handle' } },
                activeChannels: ['telegram'],
            },
            {
                id: 'raw_contact_alpha_duplicate',
                name: 'Ada Private',
                company: 'Example Labs',
                sources: { linkedin: { id: 'raw_linkedin_id', url: 'https://example.test/private-profile' } },
                activeChannels: ['linkedin'],
            },
            { id: 'group_private', name: 'Secret Group Name', isGroup: true, activeChannels: ['whatsapp'] },
        ],
        interactions: [
            {
                contactId: 'raw_contact_alpha',
                source: 'telegram',
                timestamp: recent,
                text: 'private message body should not leave workbench',
            },
        ],
        contactEvidence: {
            raw_contact_alpha: {
                topics: ['fundraising'],
                sources: ['telegram'],
                topicEvidence: [{ topic: 'fundraising', sources: ['telegram'], count: 1, confidence: 0.22, latestAt: recent }],
            },
        },
        sourceEvents: [{ source: 'telegram', kind: 'message', count: 1, lastEventAt: recent }],
        syncState: {
            telegram: { status: 'ok', lastSyncAt: recent },
            linkedin: { status: 'error', lastSyncAt: stale, lastError: 'Bearer secret at /private/source/token.json' },
            slack: { status: 'idle' },
        },
        memoryRefreshStatus: { status: 'warning', generatedAt: recent, warnings: ['token leaked at /private/path'] },
    };
}

test('[SourceQualityWorkbench]: builds review buckets without leaking private data', () => {
    const workbench = buildSourceQualityWorkbench(fixture());

    assert.equal(workbench.status, 'needs_review');
    assert.ok(workbench.summary.identityCount >= 1);
    assert.ok(workbench.summary.evidenceCount >= 1);
    assert.ok(workbench.summary.sourceCount >= 1);
    assert.ok(workbench.summary.ingestionCount >= 1);
    assert.equal(workbench.safety.readOnly, true);
    assert.equal(workbench.safety.contactDetailsOmitted, true);

    const identity = workbench.buckets.identity[0];
    assert.match(identity.pairRef, /^identity:/);
    assert.deepEqual(identity.contactRefs.every(ref => ref.startsWith('contact:')), true);
    assert.ok(identity.reasons.some(reason => reason.kind === 'name_similarity' || reason.kind === 'org_overlap'));

    const evidence = workbench.buckets.evidence[0];
    assert.equal(evidence.topic, 'fundraising');
    assert.deepEqual(evidence.sources, ['telegram']);
    assert.equal(evidence.nextLocalAction, 'Review or suppress this topic in the evidence review workbench.');

    const sources = workbench.buckets.sources.map(row => row.source);
    assert.ok(sources.includes('linkedin'));
    const ingestion = workbench.buckets.ingestion.map(row => row.source);
    assert.ok(ingestion.includes('slack'));

    const serialized = JSON.stringify(workbench);
    for (const forbidden of [
        'raw_contact_alpha',
        'raw_contact_alpha_duplicate',
        'Ada Private',
        'ada-private@example.test',
        '+15555550123',
        'raw_telegram_id',
        'raw_linkedin_id',
        'private_handle',
        'private-profile',
        'Secret Group Name',
        'private message body',
        'Bearer secret',
        '/private/source',
        '/private/path',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }
});

test('[SourceQualityWorkbench]: returns honest empty state when no reviewable gaps exist', () => {
    const recent = '2026-05-16T10:00:00.000Z';
    const workbench = buildSourceQualityWorkbench({
        now: NOW,
        contacts: [{ id: 'safe_contact', name: 'Safe Fixture', sources: { telegram: { label: 'present' } }, activeChannels: ['telegram'] }],
        interactions: [{ contactId: 'safe_contact', source: 'telegram', timestamp: recent }],
        contactEvidence: {
            safe_contact: { topics: ['ai'], sources: ['telegram'], topicEvidence: [{ topic: 'ai', sources: ['telegram'], count: 4, confidence: 0.9, latestAt: recent }] },
        },
        sourceEvents: [{ source: 'telegram', kind: 'message', count: 4, lastEventAt: recent }],
        syncState: { telegram: { status: 'ok', lastSyncAt: recent } },
        options: { sources: ['telegram'] },
    });

    assert.equal(workbench.status, 'empty');
    assert.equal(workbench.summary.totalCount, 0);
    assert.deepEqual(workbench.buckets.identity, []);
    assert.deepEqual(workbench.buckets.evidence, []);
    assert.deepEqual(workbench.buckets.sources, []);
    assert.deepEqual(workbench.buckets.ingestion, []);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/source-quality-workbench.test.js
```

Expected: FAIL — `Cannot find module '../../crm/source-quality-workbench'`.

**Step 3: Write minimal implementation**

Create `crm/source-quality-workbench.js`:

```js
'use strict';

const crypto = require('node:crypto');
const { buildAgentSourceHealth } = require('./agent-source-health');
const { buildEvidenceReviewRows } = require('./evidence-review');
const { proposeIdentityCandidates } = require('./identity-candidates');
const { safeContactRef, canonicalSafeSource } = require('./source-events');
const { redactDirectContactDetails } = require('./privacy-envelope');

const WEAK_EVIDENCE_COUNT = 2;
const WEAK_CONFIDENCE = 0.35;

function pairRef(contactIds) {
    const digest = crypto.createHash('sha256')
        .update((contactIds || []).slice().sort().join('\u0000'))
        .digest('hex')
        .slice(0, 16);
    return `identity:${digest}`;
}

function safeReason(reason) {
    return {
        kind: String(reason && reason.kind || 'unknown').replace(/[^a-z0-9_:-]+/gi, '_').slice(0, 64),
        detail: redactDirectContactDetails(String(reason && reason.detail || 'Review suggested by local identity heuristics.')).slice(0, 160),
    };
}

function identityBucket(contacts) {
    return proposeIdentityCandidates(contacts)
        .filter(row => row && row.requiresReview)
        .slice(0, 20)
        .map(row => ({
            pairRef: pairRef(row.contactIds),
            contactRefs: (row.contactIds || []).map(safeContactRef).sort(),
            score: Number.isFinite(row.score) ? row.score : 0,
            decision: row.decision === 'possible' ? 'needs_review' : 'review',
            reasons: (Array.isArray(row.reasons) ? row.reasons : []).map(safeReason).slice(0, 3),
            nextLocalAction: 'Open identity review and decide whether these records are the same person.',
        }));
}

function evidenceBucket(data) {
    const review = buildEvidenceReviewRows({
        contacts: data.contacts,
        contactEvidence: data.contactEvidence,
        overrides: data.evidenceOverrides || data.overrides || {},
        limit: 200,
    });
    return (review.rows || [])
        .filter(row => row.decision !== 'suppressed')
        .filter(row => Number(row.evidenceCount || 0) <= WEAK_EVIDENCE_COUNT || Number(row.confidence || 0) < WEAK_CONFIDENCE)
        .slice(0, 20)
        .map(row => ({
            contactRef: row.contactRef,
            topic: row.topic,
            sources: (row.sources || []).map(canonicalSafeSource).filter(Boolean).sort(),
            evidenceCount: Number(row.evidenceCount || 0),
            confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
            latestAt: row.latestAt || null,
            nextLocalAction: 'Review or suppress this topic in the evidence review workbench.',
        }));
}

function sourceBuckets(data) {
    const health = buildAgentSourceHealth(data, { now: data.now, ...(data.options || {}) });
    const rows = Object.entries(health.sources || {}).map(([source, row]) => ({ source, ...row }));
    const unhealthy = [];
    const ingestion = [];
    for (const row of rows) {
        const warnings = Array.isArray(row.warnings) ? row.warnings.slice().sort() : [];
        const safeRow = {
            source: canonicalSafeSource(row.source),
            status: row.status || 'unknown',
            freshness: row.freshness || 'unknown',
            warnings,
            contactCount: Number(row.contactCount || 0),
            evidenceContactCount: Number(row.evidenceContactCount || 0),
            interactionCount: Number(row.interactionCount || 0),
            sourceEventCount: Number(row.sourceEventCount || 0),
            suggestedNextStep: row.suggestedNextStep || 'Refresh or reconnect this local source before trusting source-specific answers.',
        };
        if (row.status && row.status !== 'ready') unhealthy.push(safeRow);
        if (warnings.some(w => ['not_configured', 'no_contacts', 'no_query_evidence', 'no_recent_sync', 'sync_error'].includes(w))) {
            ingestion.push({
                ...safeRow,
                nextLocalAction: 'Check the local import/sync path for this source, then rerun source health.',
            });
        }
    }
    return { unhealthy: unhealthy.slice(0, 20), ingestion: ingestion.slice(0, 20) };
}

function buildSourceQualityWorkbench(data = {}) {
    const identity = identityBucket(Array.isArray(data.contacts) ? data.contacts : []);
    const evidence = evidenceBucket(data);
    const { unhealthy, ingestion } = sourceBuckets(data);
    const summary = {
        identityCount: identity.length,
        evidenceCount: evidence.length,
        sourceCount: unhealthy.length,
        ingestionCount: ingestion.length,
    };
    summary.totalCount = summary.identityCount + summary.evidenceCount + summary.sourceCount + summary.ingestionCount;
    return {
        status: summary.totalCount ? 'needs_review' : 'empty',
        summary,
        buckets: { identity, evidence, sources: unhealthy, ingestion },
        generatedAt: data.now || new Date().toISOString(),
        safety: {
            readOnly: true,
            contactDetailsOmitted: true,
            rawContactIdsOmitted: true,
            rawMessagesOmitted: true,
            rawProviderPayloadsOmitted: true,
            localPathsOmitted: true,
        },
    };
}

module.exports = { buildSourceQualityWorkbench, pairRef };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/source-quality-workbench.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/source-quality-workbench.js tests/unit/source-quality-workbench.test.js
git commit -m "feat: add source quality workbench builder"
```

---

### Task 2: Expose a read-only source-quality API route

**Objective:** Serve the workbench envelope from local Minty JSON artifacts without changing agent/MCP contracts.

**Files:**
- Modify: `crm/server.js`
- Test: `tests/integration/source-quality-workbench-api.test.js`

**Step 1: Write failing integration test**

Create `tests/integration/source-quality-workbench-api.test.js`:

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
    const now = '2026-05-16T10:00:00.000Z';
    writeJson(path.join(unified, 'contacts.json'), [
        {
            id: 'raw_workbench_contact',
            name: 'Workbench Private',
            emails: ['workbench-private' + '@' + 'example.test'],
            sources: { telegram: { id: 'raw-workbench-source-id', handle: 'private_handle' } },
            activeChannels: ['telegram'],
        },
        {
            id: 'raw_workbench_dupe',
            name: 'Workbench Private',
            company: 'Example Labs',
            sources: { linkedin: { id: 'raw-workbench-linkedin-id' } },
            activeChannels: ['linkedin'],
        },
    ]);
    writeJson(path.join(unified, 'interactions.json'), [{
        contactId: 'raw_workbench_contact',
        source: 'telegram',
        timestamp: now,
        text: 'raw workbench message body',
    }]);
    writeJson(path.join(unified, 'contact-evidence.json'), {
        raw_workbench_contact: {
            topics: ['fundraising'],
            sources: ['telegram'],
            topicEvidence: [{ topic: 'fundraising', sources: ['telegram'], count: 1, confidence: 0.2, latestAt: now }],
        },
    });
    writeJson(path.join(unified, 'source-events.json'), [{ source: 'telegram', kind: 'message', count: 1, lastEventAt: now }]);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: { status: 'ok', lastSyncAt: now },
        linkedin: { status: 'error', lastError: 'token at /private/workbench/path.json', lastSyncAt: '2026-01-01T00:00:00.000Z' },
    });
}

test('GET /api/source-quality/workbench returns privacy-safe review buckets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-source-quality-api-'));
    seed(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, '/api/source-quality/workbench?now=2026-05-16T12%3A00%3A00.000Z');
        assert.equal(res.status, 200);
        const payload = await res.json();
        assert.equal(payload.safety.readOnly, true);
        assert.equal(payload.status, 'needs_review');
        assert.ok(payload.summary.totalCount > 0);
        assert.ok(Array.isArray(payload.buckets.evidence));
        assert.ok(Array.isArray(payload.buckets.sources));

        const serialized = JSON.stringify(payload);
        for (const forbidden of [
            'raw_workbench_contact',
            'raw_workbench_dupe',
            'Workbench Private',
            'workbench-private@example.test',
            'raw-workbench-source-id',
            'raw-workbench-linkedin-id',
            'private_handle',
            'raw workbench message body',
            '/private/workbench',
            'path.json',
            'token at',
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
node --test tests/integration/source-quality-workbench-api.test.js
```

Expected: FAIL with 404 or missing handler for `/api/source-quality/workbench`.

**Step 3: Implement route and local data loader**

In `crm/server.js`, import the builder near other agent/trust helpers:

```js
const { buildSourceQualityWorkbench } = require('./source-quality-workbench');
```

Add a loader near `loadSourceHealthData()` / evidence-review helpers:

```js
function loadSourceQualityWorkbenchData(paths, now) {
    const unifiedDir = path.dirname(paths.contacts);
    const rawContactEvidence = readJsonIfExists(path.join(unifiedDir, 'contact-evidence.json'), {});
    const evidenceOverrides = readJsonIfExists(path.join(unifiedDir, 'evidence-overrides.json'), {});
    return {
        now,
        contacts: loadContacts(paths),
        interactions: readJsonIfExists(paths.interactions, []),
        contactEvidence: applyEvidenceOverrides({ contactEvidence: rawContactEvidence, overrides: evidenceOverrides }),
        evidenceOverrides,
        sourceEvents: readJsonIfExists(path.join(unifiedDir, 'source-events.json'), []),
        syncState: readJsonIfExists(path.join(unifiedDir, '..', 'sync-state.json'), {}),
        memoryRefreshStatus: readJsonIfExists(path.join(unifiedDir, '..', 'memory-refresh-status.json'), {}),
    };
}

function safeNowFromUrl(req) {
    try {
        const url = new URL(req.url, 'http://localhost');
        const raw = url.searchParams.get('now');
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw || '') ? raw : new Date().toISOString();
    } catch {
        return new Date().toISOString();
    }
}

function handleSourceQualityWorkbench(req, res, _params, paths) {
    const envelope = buildSourceQualityWorkbench(loadSourceQualityWorkbenchData(paths, safeNowFromUrl(req)));
    json(res, redactResponseStrings(envelope));
}
```

Register the route near `/api/source-health`:

```js
['GET',  /^\/api\/source-quality\/workbench$/,        handleSourceQualityWorkbench],
```

If the server has a no-data gate that allows `/api/source-health`, extend it so `/api/source-quality/workbench` still returns an empty workbench when contacts are missing.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/integration/source-quality-workbench-api.test.js
```

Expected: PASS.

**Step 5: Run regression tests**

Run:

```bash
node --test tests/unit/source-quality-workbench.test.js tests/integration/source-quality-workbench-api.test.js tests/integration/source-health-api.test.js tests/integration/evidence-review-api.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crm/server.js tests/integration/source-quality-workbench-api.test.js
git commit -m "feat: expose source quality workbench API"
```

---

### Task 3: Render the compact Sources-view panel

**Objective:** Show the workbench buckets in the Sources view without adding a new primary navigation surface.

**Files:**
- Modify: `crm/ui.html.js`
- Test: `tests/unit/source-quality-workbench.test.js` or create `tests/unit/source-quality-ui.test.js` if UI helpers are exportable/testable in this repo branch

**Step 1: Add a small UI-shape test for display helpers**

If `crm/ui.html.js` helper extraction is acceptable on the implementation branch, create `crm/source-quality-ui.js` and test it. Otherwise keep this as a DOM/e2e-only verification in Task 4.

Preferred small pure helper file:

```js
'use strict';

function bucketLabel(key) {
    return {
        identity: 'Identity review',
        evidence: 'Weak evidence',
        sources: 'Source readiness',
        ingestion: 'Ingestion gaps',
    }[key] || 'Source quality';
}

function summarizeSourceQualityWorkbench(payload = {}) {
    const summary = payload.summary || {};
    const total = Number(summary.totalCount || 0);
    if (!total) return { status: 'empty', headline: 'No reviewable source-quality gaps', rows: [] };
    return {
        status: 'needs_review',
        headline: `${total} source-quality ${total === 1 ? 'gap' : 'gaps'} to review`,
        rows: ['identity', 'evidence', 'sources', 'ingestion']
            .map(key => ({ key, label: bucketLabel(key), count: Number(summary[`${key === 'sources' ? 'source' : key}Count`] || 0) }))
            .filter(row => row.count > 0),
    };
}

module.exports = { summarizeSourceQualityWorkbench, bucketLabel };
```

Test:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSourceQualityWorkbench } = require('../../crm/source-quality-ui');

test('[SourceQualityUI]: summarizes empty and populated workbench payloads', () => {
    assert.equal(summarizeSourceQualityWorkbench({ summary: { totalCount: 0 } }).headline, 'No reviewable source-quality gaps');
    const summary = summarizeSourceQualityWorkbench({ summary: { totalCount: 3, identityCount: 1, evidenceCount: 2 } });
    assert.equal(summary.status, 'needs_review');
    assert.deepEqual(summary.rows.map(row => row.key), ['identity', 'evidence']);
});
```

Run:

```bash
node --test tests/unit/source-quality-ui.test.js
```

Expected: PASS if helper was created; otherwise skip this focused command and cover rendering in Task 4 e2e.

**Step 2: Fetch the workbench with other Sources data**

In `crm/ui.html.js`, add state near existing source state:

```js
let sourceQualityWorkbench = { status: 'empty', summary: { totalCount: 0 }, buckets: {} };
```

In `loadSources()`, fetch the new endpoint alongside source health:

```js
const loadSourceQualityWorkbench = () => fetch(BASE + '/api/source-quality/workbench')
  .then(r => r.ok ? r.json() : { status: 'empty', summary: { totalCount: 0 }, buckets: {} })
  .catch(() => ({ status: 'empty', summary: { totalCount: 0 }, buckets: {} }));

const [sourcesData, sourceHealthData, sourceQualityData, syncData] = await Promise.all([
  fetch(BASE + '/api/sources').then(r => r.json()),
  loadSourceHealth(),
  loadSourceQualityWorkbench(),
  fetch(BASE + '/api/sync/status').then(r => r.json()).catch(() => ({})),
]);
sourceQualityWorkbench = sourceQualityData;
```

**Step 3: Render a compact panel above the source grid**

Add a helper in `crm/ui.html.js` near `renderSourceReadiness()`:

```js
function renderSourceQualityWorkbench() {
  const el = document.getElementById('source-quality-workbench');
  if (!el) return;
  const payload = sourceQualityWorkbench || {};
  const summary = payload.summary || {};
  const total = Number(summary.totalCount || 0);
  if (!total) {
    el.innerHTML = `<div class="source-quality-panel empty"><strong>No reviewable source-quality gaps</strong><span>Minty has no obvious weak evidence, source readiness, ingestion, or identity-review items from local data.</span></div>`;
    return;
  }
  const rows = [
    ['identity', 'Identity review', summary.identityCount],
    ['evidence', 'Weak evidence', summary.evidenceCount],
    ['sources', 'Source readiness', summary.sourceCount],
    ['ingestion', 'Ingestion gaps', summary.ingestionCount],
  ].filter(row => Number(row[2] || 0) > 0);
  el.innerHTML = `<div class="source-quality-panel">
    <div class="source-quality-head"><strong>${total} source-quality ${total === 1 ? 'gap' : 'gaps'} to review</strong><span>Local, read-only trust checks for agent answers.</span></div>
    <div class="source-quality-grid">${rows.map(([key, label, count]) => `<div class="source-quality-chip" data-quality-bucket="${esc(key)}"><b>${Number(count).toLocaleString()}</b><span>${esc(label)}</span></div>`).join('')}</div>
  </div>`;
}
```

Call it from `renderSources()` before rendering cards:

```js
renderSourceQualityWorkbench();
```

Add a placeholder div in the Sources view template above `sources-grid`:

```html
<div id="source-quality-workbench"></div>
```

Add minimal CSS near source-card CSS:

```css
.source-quality-panel{border:1px solid var(--border);background:var(--bg-card);border-radius:14px;padding:14px 16px;margin-bottom:18px}
.source-quality-panel.empty{border-color:rgba(34,197,94,.25);background:rgba(34,197,94,.06)}
.source-quality-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.source-quality-head strong{font-size:.86rem;color:var(--text-primary)}
.source-quality-head span,.source-quality-panel.empty span{font-size:.72rem;color:var(--text-secondary)}
.source-quality-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.source-quality-chip{border:1px solid rgba(99,102,241,.18);background:rgba(99,102,241,.06);border-radius:10px;padding:10px}
.source-quality-chip b{display:block;color:var(--text-primary);font-size:1rem;margin-bottom:3px}
.source-quality-chip span{font-size:.68rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em}
```

**Step 4: Run focused UI/static checks**

Run:

```bash
node --test tests/unit/source-quality-workbench.test.js
npm run test:e2e
```

Expected: PASS. If Playwright is missing locally, run `npx playwright install chromium` once and rerun.

**Step 5: Commit**

```bash
git add crm/ui.html.js crm/source-quality-ui.js tests/unit/source-quality-ui.test.js
# omit crm/source-quality-ui.js/tests if implementation kept helpers inline
git commit -m "feat: show source quality workbench in Sources"
```

---

### Task 4: Update docs and run final verification

**Objective:** Document the new trust/debug layer and verify no trust-contract regression.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `README.md` only if it already describes Sources/source-health UI

**Step 1: Add a short docs note**

In `docs/HERMES_INTEGRATION.md`, add a section near “Evidence review workbench”:

```md
## Source quality workbench

The Sources view includes a local read-only source-quality workbench backed by
`GET /api/source-quality/workbench`. It summarizes reviewable trust gaps for
agent answers: ambiguous identity candidates, weak evidence topics, stale or
unhealthy sources, and ingestion gaps.

The workbench is a setup/trust/debug layer. It never exposes raw contact ids,
emails, phones, source handles, message bodies, provider payloads, URLs, or
local file paths, and it does not trigger imports, repairs, or outreach.
```

**Step 2: Run targeted and full verification**

Run:

```bash
node --test tests/unit/source-quality-workbench.test.js tests/integration/source-quality-workbench-api.test.js tests/integration/source-health-api.test.js tests/integration/evidence-review-api.test.js
npm test
npm run test:e2e
```

Expected: all PASS.

**Step 3: Manual privacy smoke**

Run this local smoke against the synthetic integration fixture or a demo server:

```bash
node - <<'NODE'
const { buildSourceQualityWorkbench } = require('./crm/source-quality-workbench');
const payload = buildSourceQualityWorkbench({
  now: '2026-05-16T12:00:00.000Z',
  contacts: [{ id: 'raw_private', name: 'Private Name', emails: ['private' + '@' + 'example.test'] }],
  interactions: [],
  contactEvidence: {},
  sourceEvents: [],
  syncState: {},
});
const serialized = JSON.stringify(payload);
for (const forbidden of ['raw_private', 'Private Name', 'private@example.test']) {
  if (serialized.includes(forbidden)) throw new Error('leaked ' + forbidden);
}
console.log('source-quality workbench privacy smoke passed');
NODE
```

Expected: prints `source-quality workbench privacy smoke passed`.

**Step 4: Commit docs**

```bash
git add docs/HERMES_INTEGRATION.md README.md
git commit -m "docs: document source quality workbench"
```

---

## Final implementation checklist

- [ ] `node --test tests/unit/source-quality-workbench.test.js` passes.
- [ ] `node --test tests/integration/source-quality-workbench-api.test.js` passes.
- [ ] `node --test tests/integration/source-health-api.test.js tests/integration/evidence-review-api.test.js` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes because the Sources UI changed.
- [ ] Serialized workbench output contains no raw contact IDs, emails, phones, handles, message bodies, URLs, provider payloads, token strings, stack traces, or local/private paths.
- [ ] Existing MCP `source_health` output and `/api/evidence/review` behavior are unchanged.
- [ ] No source repair, import trigger, provider action, send, telemetry, or runtime LLM call was added.
