# Evidence Review Workbench Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a small trust/debug/edit workbench where Sree can inspect and suppress weak agent-retrieval evidence topics without exposing raw messages or turning Minty into CRM busywork.

**Architecture:** Keep the agent/MCP loop primary and make the web UI the trust layer. Add a pure `crm/evidence-review.js` module that reads `contacts.json`, `contact-evidence.json`, `source-events.json`, and optional `evidence-overrides.json`, then returns redacted review rows. Add two local API routes in `crm/server.js`: `GET /api/evidence/review` and `POST /api/evidence/review/:contactRef/topic`. Apply suppressions in the existing evidence/index build path so Hermes stops using user-rejected topics. No raw messages, emails, phones, group names, contact ids, or outreach actions are returned.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `crm/evidence-patches.js`, `crm/source-events.js`, `crm/contact-evidence.js`, `crm/hybrid-index.js`, `scripts/build-hybrid-index.js`, `crm/server.js`, `crm/ui.html.js`, `tests/unit/`, `tests/integration/`.

---

## Product framing

Minty's recent direction is correct: Hermes/OpenClaw/MCP agents get source-backed private network memory, not another CRM dashboard. But the current trust contract is one-way: Minty can tell Hermes “Alice matches DeFi because local evidence says so,” while the user has no focused place to audit whether that evidence is trustworthy or to say “stop using this topic for this person.”

That matters because the repo is now adding source filters, contact evidence, hybrid indexes, source health, citations, meeting prep, and goal next-actions. Those are only useful if false positives can be found and corrected locally. The web UI should become the trust/debug/edit layer for agent memory — not a daily relationship-maintenance surface.

This complements, not duplicates, existing plans:

- `2026-05-02-agent-retrieval-citations.md` makes agent answers cite evidence.
- `2026-05-06-agent-source-health-mcp.md` tells Hermes whether sources are fresh enough to trust.
- This plan lets the human review the evidence layer itself and suppress bad topic claims before they affect MCP retrieval.

Success criteria:

- `GET /api/evidence/review` returns redacted rows grouped by contact/topic with confidence, source labels, counts, latest timestamp, and opaque `contactRef` only.
- Rows never include raw contact ids, emails, phones, raw message bodies, raw source event ids, group IDs, group names, URLs, token paths, or arbitrary raw labels.
- `POST /api/evidence/review/:contactRef/topic` supports `{ decision: "suppress" | "restore" }` and writes only to `data/unified/evidence-overrides.json`.
- Suppressed topics are removed from `contact-evidence.json` consumption and `hybrid-index.json` generation, so agent retrieval stops using them.
- Review UI is tucked into the existing Review/Sources area as a trust workbench, not a new primary nav surface.

## Non-goals

- Do not show raw messages or source snippets.
- Do not add arbitrary user-authored topics in this plan; only suppress/restore existing deterministic topics.
- Do not send messages, create follow-up tasks, or mutate contacts.
- Do not add runtime LLM calls, embeddings, new npm dependencies, or cloud services.
- Do not replace citation/source-health MCP work; this is the human correction layer.

---

### Task 1: Add pure evidence review row builder

**Objective:** Create a deterministic redacted builder that converts local contact evidence into review rows keyed by opaque refs.

**Files:**
- Create: `crm/evidence-review.js`
- Test: `tests/unit/evidence-review.test.js`

**Step 1: Write failing test**

Create `tests/unit/evidence-review.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEvidenceReviewRows } = require('../../crm/evidence-review');
const { safeContactRef } = require('../../crm/source-events');

test('[EvidenceReview]: builds redacted topic review rows', () => {
    const rows = buildEvidenceReviewRows({
        contacts: [{
            id: 'c_private',
            name: 'Alice Private',
            emails: ['alice@example.com'],
            phones: ['+15555550123'],
            sources: { telegram: { id: 'secret-chat-id', name: 'Secret Group' } },
        }],
        contactEvidence: {
            c_private: {
                topics: ['defi'],
                sources: ['telegram'],
                evidenceCount: 3,
                latestAt: '2026-05-06T10:00:00.000Z',
                confidence: 0.8,
                topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 3, confidence: 0.8, latestAt: '2026-05-06T10:00:00.000Z' }],
            },
        },
    });

    assert.equal(rows.status, 'ok');
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].contactRef, safeContactRef('c_private'));
    assert.equal(rows.rows[0].contactName, 'Alice Private');
    assert.equal(rows.rows[0].topic, 'defi');
    assert.deepEqual(rows.rows[0].sources, ['telegram']);
    assert.equal(rows.rows[0].evidenceCount, 3);
    assert.equal(rows.rows[0].decision, 'active');

    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes('c_private'), false);
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('+15555550123'), false);
    assert.equal(serialized.includes('secret-chat-id'), false);
    assert.equal(serialized.includes('Secret Group'), false);
});

test('[EvidenceReview]: marks suppressed rows and omits group contacts', () => {
    const contactRef = safeContactRef('c1');
    const rows = buildEvidenceReviewRows({
        contacts: [{ id: 'c1', name: 'Bob' }, { id: 'g1', name: 'Group Chat', isGroup: true }],
        contactEvidence: {
            c1: { topics: ['ai'], sources: ['email'], topicEvidence: [{ topic: 'ai', sources: ['email'], count: 1 }] },
            g1: { topics: ['ai'], sources: ['whatsapp'], topicEvidence: [{ topic: 'ai', sources: ['whatsapp'], count: 9 }] },
        },
        overrides: { suppressions: [{ contactRef, topic: 'ai', decision: 'suppress', reviewedAt: '2026-05-06T11:00:00.000Z' }] },
    });

    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].decision, 'suppressed');
    assert.equal(rows.rows[0].reviewedAt, '2026-05-06T11:00:00.000Z');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/evidence-review.test.js
```

Expected: FAIL — `Cannot find module '../../crm/evidence-review'`.

**Step 3: Write minimal implementation**

Create `crm/evidence-review.js`:

```js
'use strict';

const { safeContactRef, canonicalSafeSource, parseSafeTimestamp } = require('./source-events');
const { extractAllowedTopics } = require('./evidence-patches');

function normalizeOverrides(overrides = {}) {
    const map = new Map();
    for (const row of Array.isArray(overrides.suppressions) ? overrides.suppressions : []) {
        if (!row || typeof row !== 'object') continue;
        const topic = extractAllowedTopics(row.topic)[0];
        const ref = typeof row.contactRef === 'string' ? row.contactRef : '';
        if (!ref || !topic) continue;
        map.set(`${ref}:${topic}`, {
            decision: row.decision === 'suppress' ? 'suppressed' : 'active',
            reviewedAt: parseSafeTimestamp(row.reviewedAt),
        });
    }
    return map;
}

function topicRowsForContact(contact, evidence, overrideMap) {
    const ref = safeContactRef(contact.id);
    const topicEvidence = Array.isArray(evidence && evidence.topicEvidence) ? evidence.topicEvidence : [];
    const rows = [];
    const fallbackTopics = topicEvidence.length ? [] : (Array.isArray(evidence && evidence.topics) ? evidence.topics : []);
    const sourceFallback = Array.isArray(evidence && evidence.sources) ? evidence.sources.map(canonicalSafeSource).sort() : [];

    for (const row of topicEvidence) {
        const topic = extractAllowedTopics(row && row.topic)[0];
        if (!topic) continue;
        const override = overrideMap.get(`${ref}:${topic}`) || {};
        rows.push({
            contactRef: ref,
            contactName: contact.name || 'Unknown person',
            topic,
            sources: [...new Set((Array.isArray(row.sources) ? row.sources : sourceFallback).map(canonicalSafeSource))].sort(),
            evidenceCount: Math.max(0, Number(row.count || 0)),
            confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
            latestAt: parseSafeTimestamp(row.latestAt || evidence.latestAt),
            decision: override.decision || 'active',
            reviewedAt: override.reviewedAt || null,
        });
    }

    for (const rawTopic of fallbackTopics) {
        const topic = extractAllowedTopics(rawTopic)[0];
        if (!topic || rows.some(r => r.topic === topic)) continue;
        const override = overrideMap.get(`${ref}:${topic}`) || {};
        rows.push({
            contactRef: ref,
            contactName: contact.name || 'Unknown person',
            topic,
            sources: sourceFallback,
            evidenceCount: Math.max(0, Number(evidence.evidenceCount || 0)),
            confidence: Number.isFinite(Number(evidence.confidence)) ? Number(evidence.confidence) : null,
            latestAt: parseSafeTimestamp(evidence.latestAt),
            decision: override.decision || 'active',
            reviewedAt: override.reviewedAt || null,
        });
    }
    return rows;
}

function buildEvidenceReviewRows({ contacts = [], contactEvidence = {}, overrides = {}, limit = 100 } = {}) {
    const overrideMap = normalizeOverrides(overrides);
    const rows = [];
    for (const contact of Array.isArray(contacts) ? contacts : []) {
        if (!contact || !contact.id || contact.isGroup) continue;
        const ref = safeContactRef(contact.id);
        const evidence = contactEvidence[contact.id] || contactEvidence[ref];
        if (!evidence || typeof evidence !== 'object') continue;
        rows.push(...topicRowsForContact(contact, evidence, overrideMap));
    }
    rows.sort((a, b) =>
        (b.decision === 'active') - (a.decision === 'active') ||
        Number(b.evidenceCount || 0) - Number(a.evidenceCount || 0) ||
        String(b.latestAt || '').localeCompare(String(a.latestAt || '')) ||
        a.contactName.localeCompare(b.contactName)
    );
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    return {
        status: rows.length ? 'ok' : 'empty',
        rows: rows.slice(0, safeLimit),
        safety: {
            contactDetailsOmitted: true,
            rawMessagesOmitted: true,
            rawContactIdsOmitted: true,
            readOnly: true,
        },
    };
}

module.exports = { buildEvidenceReviewRows, normalizeOverrides };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/evidence-review.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/evidence-review.js tests/unit/evidence-review.test.js
git commit -m "feat: add evidence review row builder"
```

---

### Task 2: Apply evidence suppressions before indexing and retrieval

**Objective:** Add a pure filter so suppressed topics are removed from contact evidence before hybrid index generation or agent retrieval uses it.

**Files:**
- Modify: `crm/evidence-review.js`
- Modify: `scripts/build-hybrid-index.js`
- Modify: `scripts/agent-query.js`
- Test: `tests/unit/evidence-review.test.js`
- Test: `tests/unit/hybrid-index.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/evidence-review.test.js`:

```js
test('[EvidenceReview]: applyEvidenceOverrides removes suppressed topics only', () => {
    const { applyEvidenceOverrides } = require('../../crm/evidence-review');
    const contactRef = safeContactRef('c1');
    const out = applyEvidenceOverrides({
        contactEvidence: {
            c1: {
                topics: ['ai', 'defi'],
                sources: ['email', 'telegram'],
                evidenceCount: 4,
                topicEvidence: [
                    { topic: 'ai', sources: ['email'], count: 1 },
                    { topic: 'defi', sources: ['telegram'], count: 3 },
                ],
            },
        },
        overrides: { suppressions: [{ contactRef, topic: 'ai', decision: 'suppress' }] },
    });

    assert.deepEqual(out.c1.topics, ['defi']);
    assert.deepEqual(out.c1.topicEvidence.map(r => r.topic), ['defi']);
    assert.deepEqual(out.c1.sources, ['telegram']);
});
```

Append to `tests/unit/hybrid-index.test.js`:

```js
test('[HybridIndex]: suppressed evidence topics are not indexed', () => {
    const { buildHybridIndex, queryHybridIndex } = require('../../crm/hybrid-index');
    const { applyEvidenceOverrides } = require('../../crm/evidence-review');
    const { safeContactRef } = require('../../crm/source-events');
    const contacts = [{ id: 'c1', name: 'Alice', relationshipScore: 80 }];
    const filtered = applyEvidenceOverrides({
        contactEvidence: { c1: { topics: ['ai'], sources: ['email'], topicEvidence: [{ topic: 'ai', sources: ['email'], count: 1 }] } },
        overrides: { suppressions: [{ contactRef: safeContactRef('c1'), topic: 'ai', decision: 'suppress' }] },
    });
    const index = buildHybridIndex({ contacts, contactEvidence: filtered, sourceEvents: [] });
    assert.deepEqual(queryHybridIndex('ai', { index }), []);
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/unit/evidence-review.test.js tests/unit/hybrid-index.test.js
```

Expected: FAIL — `applyEvidenceOverrides` is not exported or suppressions are ignored.

**Step 3: Write minimal implementation**

Append to `crm/evidence-review.js` before `module.exports`, then update the export:

```js
function applyEvidenceOverrides({ contactEvidence = {}, overrides = {} } = {}) {
    const overrideMap = normalizeOverrides(overrides);
    const out = Object.create(null);
    for (const [key, evidence] of Object.entries(contactEvidence && typeof contactEvidence === 'object' ? contactEvidence : {})) {
        if (!evidence || typeof evidence !== 'object') continue;
        const ref = key.startsWith('contact:') ? key : safeContactRef(key);
        const topicRows = Array.isArray(evidence.topicEvidence) ? evidence.topicEvidence : [];
        const keptTopicRows = topicRows.filter(row => {
            const topic = extractAllowedTopics(row && row.topic)[0];
            return topic && (overrideMap.get(`${ref}:${topic}`)?.decision !== 'suppressed');
        });
        const fallbackTopics = Array.isArray(evidence.topics) ? evidence.topics : [];
        const keptTopics = [...new Set([
            ...keptTopicRows.map(r => extractAllowedTopics(r.topic)[0]).filter(Boolean),
            ...fallbackTopics.map(t => extractAllowedTopics(t)[0]).filter(Boolean)
                .filter(topic => overrideMap.get(`${ref}:${topic}`)?.decision !== 'suppressed'),
        ])].sort();
        if (!keptTopics.length) continue;
        const sources = [...new Set(keptTopicRows.flatMap(r => Array.isArray(r.sources) ? r.sources : [])
            .concat(Array.isArray(evidence.sources) ? evidence.sources : [])
            .map(canonicalSafeSource))].sort();
        out[key] = {
            ...evidence,
            topics: keptTopics,
            topicEvidence: keptTopicRows,
            sources,
        };
    }
    return out;
}

module.exports = { buildEvidenceReviewRows, normalizeOverrides, applyEvidenceOverrides };
```

Update `scripts/build-hybrid-index.js` to load and apply overrides:

```js
const { applyEvidenceOverrides } = require('../crm/evidence-review');
// ...inside main(), after contactEvidence load:
const evidenceOverrides = readJson(path.join(unified, 'evidence-overrides.json'), {});
const filteredContactEvidence = applyEvidenceOverrides({ contactEvidence, overrides: evidenceOverrides });
const hybridIndex = buildHybridIndex({ contacts, contactEvidence: filteredContactEvidence, sourceEvents });
```

Update `scripts/agent-query.js` to load `evidence-overrides.json` and pass filtered `contactEvidence` to callers. Preserve existing fields and fallbacks.

**Step 4: Run tests to verify pass**

Run:

```bash
node --test tests/unit/evidence-review.test.js tests/unit/hybrid-index.test.js tests/unit/agent-retrieval.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/evidence-review.js scripts/build-hybrid-index.js scripts/agent-query.js tests/unit/evidence-review.test.js tests/unit/hybrid-index.test.js
git commit -m "feat: apply evidence suppressions to agent index"
```

---

### Task 3: Add local evidence review API routes

**Objective:** Expose read and suppress/restore routes for the trust workbench without returning private raw data.

**Files:**
- Modify: `crm/server.js`
- Test: `tests/integration/evidence-review-api.test.js`

**Step 1: Write failing integration tests**

Create `tests/integration/evidence-review-api.test.js` using the same `withServer()` pattern as `tests/integration/api-data-resilience.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { safeContactRef } = require('../../crm/source-events');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'crm/server.js');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seed(dir) {
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [{ id: 'c_private', name: 'Alice Private', emails: ['alice@example.com'], phones: ['+15555550123'] }]);
    writeJson(path.join(unified, 'interactions.json'), []);
    writeJson(path.join(unified, 'insights.json'), {});
    writeJson(path.join(unified, 'contact-evidence.json'), {
        c_private: { topics: ['defi'], sources: ['telegram'], topicEvidence: [{ topic: 'defi', sources: ['telegram'], count: 2, confidence: 0.7 }] },
    });
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function withServer(dataDir, fn) {
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER], {
        cwd: ROOT,
        env: { ...process.env, CRM_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
        child.stdout.on('data', b => { if (String(b).includes('Minty is running')) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', b => { if (String(b).includes('Minty is running')) { clearTimeout(timer); resolve(); } });
    });
    try { await fn(`http://127.0.0.1:${port}`); }
    finally { child.kill('SIGTERM'); }
}

test('evidence review API returns redacted rows and persists suppression', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-evidence-review-'));
    seed(dir);
    const contactRef = safeContactRef('c_private');

    await withServer(dir, async (base) => {
        const listRes = await fetch(`${base}/api/evidence/review`);
        assert.equal(listRes.status, 200);
        const list = await listRes.json();
        assert.equal(list.rows[0].contactRef, contactRef);
        assert.equal(JSON.stringify(list).includes('c_private'), false);
        assert.equal(JSON.stringify(list).includes('alice@example.com'), false);
        assert.equal(JSON.stringify(list).includes('+15555550123'), false);

        const postRes = await fetch(`${base}/api/evidence/review/${encodeURIComponent(contactRef)}/defi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'suppress' }),
        });
        assert.equal(postRes.status, 200);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'unified', 'evidence-overrides.json'), 'utf8'));
        assert.equal(saved.suppressions[0].contactRef, contactRef);
        assert.equal(saved.suppressions[0].topic, 'defi');
        assert.equal(saved.suppressions[0].decision, 'suppress');
    });
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/evidence-review-api.test.js
```

Expected: FAIL — routes do not exist.

**Step 3: Write minimal implementation**

In `crm/server.js`, require helpers near other local helpers:

```js
const { buildEvidenceReviewRows, applyEvidenceOverrides } = require('./evidence-review');
const { extractAllowedTopics } = require('./evidence-patches');
```

Add small file helpers near existing JSON helpers if not already present:

```js
function evidenceOverridesPath() {
    return path.join(DATA_DIR, 'unified', 'evidence-overrides.json');
}
function loadEvidenceOverrides() {
    return readJson(evidenceOverridesPath(), { suppressions: [] });
}
function saveEvidenceOverrides(overrides) {
    fs.mkdirSync(path.dirname(evidenceOverridesPath()), { recursive: true });
    fs.writeFileSync(evidenceOverridesPath(), JSON.stringify(overrides, null, 2) + '\n');
}
```

Add routes before the fallback static handler:

```js
if (req.method === 'GET' && url.pathname === '/api/evidence/review') {
    const contacts = loadContacts();
    const contactEvidence = readJson(path.join(DATA_DIR, 'unified', 'contact-evidence.json'), {});
    const overrides = loadEvidenceOverrides();
    return sendJson(res, buildEvidenceReviewRows({ contacts, contactEvidence, overrides }));
}

const evidenceMatch = url.pathname.match(/^\/api\/evidence\/review\/([^/]+)\/([^/]+)$/);
if (req.method === 'POST' && evidenceMatch) {
    const contactRef = decodeURIComponent(evidenceMatch[1]);
    const topic = extractAllowedTopics(decodeURIComponent(evidenceMatch[2]))[0];
    const body = await readJsonBody(req);
    const decision = body && body.decision === 'restore' ? 'restore' : body && body.decision === 'suppress' ? 'suppress' : null;
    if (!contactRef.startsWith('contact:') || !topic || !decision) return sendJson(res, { error: 'Invalid evidence review decision' }, 400);
    const overrides = loadEvidenceOverrides();
    const rows = Array.isArray(overrides.suppressions) ? overrides.suppressions : [];
    const filtered = rows.filter(r => !(r && r.contactRef === contactRef && r.topic === topic));
    if (decision === 'suppress') filtered.push({ contactRef, topic, decision: 'suppress', reviewedAt: new Date().toISOString() });
    overrides.suppressions = filtered;
    saveEvidenceOverrides(overrides);
    return sendJson(res, { ok: true, contactRef, topic, decision });
}
```

Use the repo's existing `sendJson`, `readJsonBody`, `readJson`, and `DATA_DIR` names. If any helper has a different name, adapt to current `crm/server.js` conventions rather than duplicating body parsing.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/integration/evidence-review-api.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/server.js tests/integration/evidence-review-api.test.js
git commit -m "feat: add evidence review API"
```

---

### Task 4: Add a compact Evidence tab inside the existing Review view

**Objective:** Let Sree audit and suppress/restore evidence topics from the UI without adding another CRM-y dashboard.

**Files:**
- Modify: `crm/ui.html.js`
- Test: `tests/unit/ui-js-syntax.test.js`

**Step 1: Write failing UI syntax guard**

No new test file is needed. Before editing, run the existing syntax guard to confirm baseline:

```bash
node --test tests/unit/ui-js-syntax.test.js
```

Expected: PASS before changes.

**Step 2: Add minimal markup/styles/scripts**

In `crm/ui.html.js`, inside the existing Review view section, add a secondary switch with two tabs: identity matches and evidence topics. Keep identity review as default.

Add CSS near the Review view styles:

```css
.review-tabs { display:flex; gap:8px; align-items:center; }
.review-tab { border:1px solid var(--border); background:transparent; color:var(--text-secondary); border-radius:999px; padding:6px 10px; font-size:12px; cursor:pointer; }
.review-tab.active { color:var(--text-primary); background:rgba(99,102,241,0.14); border-color:rgba(99,102,241,0.45); }
.evidence-row { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:12px 14px; display:flex; justify-content:space-between; gap:12px; margin-bottom:10px; }
.evidence-topic { font-size:13px; color:var(--text-primary); font-weight:600; }
.evidence-meta { font-size:11px; color:var(--text-muted); margin-top:4px; }
.evidence-decision { font-size:11px; color:var(--text-secondary); }
```

Add JS near the existing review functions:

```js
let evidenceRows = [];
let reviewMode = 'identity';

async function showEvidenceReview() {
    reviewMode = 'evidence';
    document.querySelectorAll('.review-tab').forEach(b => b.classList.toggle('active', b.dataset.reviewTab === 'evidence'));
    const el = document.getElementById('review-list');
    if (!el) return;
    el.innerHTML = '<div class="review-empty">Loading evidence topics…</div>';
    try {
        const res = await fetch(api('/api/evidence/review'));
        const payload = await res.json();
        evidenceRows = Array.isArray(payload.rows) ? payload.rows : [];
        renderEvidenceRows();
    } catch (err) {
        el.innerHTML = '<div class="review-empty">Could not load evidence review.</div>';
    }
}

function renderEvidenceRows() {
    const el = document.getElementById('review-list');
    if (!el) return;
    if (!evidenceRows.length) {
        el.innerHTML = '<div class="review-empty"><h2>No evidence topics to review</h2><p>Minty has not built contact evidence yet.</p></div>';
        return;
    }
    el.innerHTML = evidenceRows.map(row => `
        <div class="evidence-row">
          <div>
            <div class="evidence-topic">${escapeHtml(row.contactName || 'Unknown person')} · ${escapeHtml(row.topic)}</div>
            <div class="evidence-meta">${(row.sources || []).map(escapeHtml).join(', ') || 'unknown source'} · ${row.evidenceCount || 0} signals · ${row.latestAt ? timeAgo(row.latestAt) : 'no timestamp'}</div>
            <div class="evidence-decision">${row.decision === 'suppressed' ? 'Suppressed from agent retrieval' : 'Active in agent retrieval'}</div>
          </div>
          <button class="source-btn secondary" onclick="setEvidenceDecision('${row.contactRef}', '${row.topic}', '${row.decision === 'suppressed' ? 'restore' : 'suppress'}')">
            ${row.decision === 'suppressed' ? 'Restore' : 'Suppress'}
          </button>
        </div>
    `).join('');
}

async function setEvidenceDecision(contactRef, topic, decision) {
    await fetch(api('/api/evidence/review/' + encodeURIComponent(contactRef) + '/' + encodeURIComponent(topic)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
    });
    await showEvidenceReview();
}
```

If this file uses a different helper than `api()`, `escapeHtml()`, or `timeAgo()`, reuse the existing helper names. Do not introduce a new global dependency.

**Step 3: Run syntax guard**

Run:

```bash
node --test tests/unit/ui-js-syntax.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add crm/ui.html.js
git commit -m "feat: add evidence review workbench UI"
```

---

### Task 5: Wire docs and final verification

**Objective:** Document the trust workbench and verify that the suppress/restore loop does not leak private data.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `README.md` if it already mentions the Review UI or agent evidence
- Verify only: no source code edits expected beyond docs

**Step 1: Update docs**

Add a short section to `docs/HERMES_INTEGRATION.md` after the privacy model:

```md
## Human evidence review

Minty's MCP tools are read-only and source-backed, but local evidence can still be wrong. Use the web UI's Review → Evidence tab to inspect deterministic topic claims such as “Alice matches DeFi” and suppress bad topics. Suppressions stay local in `data/unified/evidence-overrides.json`; they remove the topic from future hybrid index generation and agent retrieval without deleting the underlying contact or source data.

The review envelope is privacy-safe by design: it shows opaque contact refs, display names, allowlisted topics, source labels, counts, confidence, and timestamps only. It does not show emails, phones, raw contact ids, raw messages, group names, group chat ids, URLs, or token paths.
```

**Step 2: Run targeted verification**

Run:

```bash
node --test tests/unit/evidence-review.test.js tests/unit/hybrid-index.test.js tests/unit/ui-js-syntax.test.js tests/integration/evidence-review-api.test.js
```

Expected: PASS.

Then run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 3: Optional full verification**

If the worktree is clean except this feature and time allows, run:

```bash
npm test
npm run test:e2e
```

Expected: all tests pass. If unrelated dirty work exists, prefer the targeted verification above and explicitly note why full verification was deferred.

**Step 4: Commit docs**

```bash
git add docs/HERMES_INTEGRATION.md README.md
git commit -m "docs: document evidence review workbench"
```

---

## Privacy checklist for implementer

Before opening a PR, run this mental and automated checklist:

- [ ] `JSON.stringify(buildEvidenceReviewRows(...))` does not include fixture emails, phones, raw contact IDs, source IDs, group names, URLs, or message bodies.
- [ ] Suppression writes only opaque `contactRef`, allowlisted `topic`, `decision`, and `reviewedAt`.
- [ ] API route rejects arbitrary topics via `extractAllowedTopics()`.
- [ ] UI does not display raw evidence snippets.
- [ ] `scripts/build-hybrid-index.js` applies overrides before indexing.
- [ ] `scripts/agent-query.js` applies overrides before `queryNetwork()`.
- [ ] No outreach automation, no contact mutation, no runtime LLM calls.

## Handoff notes

This is intentionally a trust/debug/edit layer, not a new daily destination. Keep the UI quiet and small. The product win is that Hermes can be more aggressive about using local network memory because Sree has a local, private way to correct bad evidence when it appears.
