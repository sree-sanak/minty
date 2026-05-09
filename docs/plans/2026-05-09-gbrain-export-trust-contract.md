# GBrain Export Trust Contract Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Harden `npm run gbrain:export` so private-brain relationship-memory exports use the same privacy, citation, freshness, and confidence contract as Minty's MCP agent tools.

**Architecture:** Keep the export deterministic and local. Refactor `scripts/export-gbrain-memory.js` to reuse existing privacy/source helpers (`crm/privacy-envelope.js`, `crm/source-events.js`, `crm/evidence-patches.js`) instead of maintaining a weaker export-only sanitizer. Export opaque `contactRef` values, safe source labels, sanitized topic tokens, source-event freshness counts, evidence citations, and an explicit safety envelope. Do not export raw contact ids, emails, phones, source handles, message bodies, raw insight prose, private paths, group names, or outreach actions.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `scripts/export-gbrain-memory.js`, `scripts/agent-query.js`, `crm/privacy-envelope.js`, `crm/source-events.js`, `crm/evidence-patches.js`, `tests/unit/gbrain-export.test.js`, `docs/HERMES_INTEGRATION.md`, `docs/SERVICE.md`.

---

## Product framing

Minty is the live relationship layer; GBrain is the durable private memory layer. The current export already omits emails and phones, but it is behind the newer MCP trust contract:

- it emits raw `contact.id` as `id`;
- it uses raw source keys from `contact.sources` rather than canonical safe source labels;
- it can promote `insights.topics` directly into GBrain, even though MCP now strips raw insight-topic details because they can contain conversation-derived sensitive text;
- it does not include machine-readable citation refs or freshness counts;
- its safety marker says contact details are omitted, but not that contact ids, source handles, message bodies, and raw insight prose are omitted.

That gap matters because GBrain export is the bridge from Minty's live graph into Hermes long-term memory. If the export is looser than MCP, the product can be privacy-safe in live agent calls but leak sensitive details into durable memory. This plan makes `gbrain:export` a first-class trust surface, not an afterthought.

This complements, not duplicates, existing plans:

- `2026-05-02-agent-retrieval-citations.md` covers live retrieval citations.
- `2026-05-06-agent-source-health-mcp.md` covers source readiness preflight.
- `2026-05-07-memory-refresh-diagnostics.md` covers refresh/export step diagnostics.
- This plan hardens the durable GBrain export payload itself.

## Success criteria

- Relationship-memory JSONL uses `contactRef: contact:<opaque>` and no raw `id` field.
- Group contacts (`isGroup === true`) are excluded from relationship-memory export rows entirely; group names/ids never become `person`, evidence, source metadata, JSONL, or Markdown.
- Serialized JSONL and Markdown never include raw contact ids, emails, phones, source account handles, group ids/names, URLs, token/private paths, raw message bodies, or known fixture sentinel phrases.
- Topics exported to GBrain are sanitized allowlisted tokens/phrases from `extractAllowedTopics()`, not arbitrary insight prose.
- Evidence rows include machine-readable `citationRef`, safe source label, evidence kind, count/timestamp where available, and redacted human label.
- `sourceMetadata` includes safe source labels, latest safe timestamp, event/profile counts, confidence, and freshness without source paths or direct identifiers.
- Export output keeps `safeToUseInAgentContext: true`, `readOnly: true`, `noOutreachTriggered: true`, `contactIdsOmitted: true`, `rawMessagesOmitted: true`, and `noLlmCalls: true`.
- Docs explain that GBrain export is durable, privacy-safe, opt-in/local, and less live than MCP/source-health.

## Non-goals

- Do not import into GBrain automatically in this plan; `memory:refresh` / service mode already orchestrate that.
- Do not add runtime LLM calls, embeddings, paid APIs, or network calls.
- Do not export raw messages, snippets, emails, phones, exact source ids, group names, URLs, token paths, or full contact records.
- Do not add a new MCP tool.
- Do not modify cron jobs or production/provider state.

---

### Task 1: Lock down export envelope privacy with failing tests

**Objective:** Prove the current GBrain export leaks raw contact ids / arbitrary insight topic prose and define the stronger target contract.

**Files:**
- Modify: `tests/unit/gbrain-export.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/gbrain-export.test.js`:

```js
test('buildRelationshipMemoryEnvelope: uses opaque contactRef and omits raw contact ids', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        id: 'raw_contact_id_private_123',
        name: 'Ada Lovelace',
    }, INSIGHTS);

    assert.equal(envelope.id, undefined, 'raw id must not be exported');
    assert.match(envelope.contactRef, /^contact:[a-p]{16}$/);
    assert.equal(JSON.stringify(envelope).includes('raw_contact_id_private_123'), false);
    assert.equal(envelope.safety.contactIdsOmitted, true);
});

test('buildRelationshipMemoryEnvelope: strips arbitrary raw insight prose from durable topics', () => {
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, {
        c_ada: {
            topics: [
                'confidential acquisition targets and private cap table dispute',
                'agent infra',
            ],
        },
    });
    const serialized = JSON.stringify(envelope);

    assert.equal(serialized.includes('confidential acquisition targets'), false);
    assert.equal(serialized.includes('private cap table dispute'), false);
    assert.ok(envelope.topics.includes('agent infra'));
    assert.ok(envelope.evidence.every(e => e.detail !== 'confidential acquisition targets and private cap table dispute'));
});

test('buildRelationshipMemoryEnvelope: canonicalizes unsafe source keys and source handles', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        id: 'c_source_secret',
        sources: {
            email: { id: 'alice@example.com', threadId: 'private-thread-id' },
            'email:alice@example.com': { id: 'bad-source-key' },
            telegram: { id: 'secret-chat-id', name: 'Secret Group' },
        },
    }, {});
    const serialized = JSON.stringify(envelope);

    assert.deepEqual(envelope.sourceMetadata.sources, ['email', 'interaction', 'telegram']);
    // The malformed key canonicalizes to the sanitized sentinel `interaction`, never to the raw key or handle.
    assert.equal(serialized.includes('alice@example.com'), false);
    assert.equal(serialized.includes('private-thread-id'), false);
    assert.equal(serialized.includes('secret-chat-id'), false);
    assert.equal(serialized.includes('Secret Group'), false);
});

test('buildRelationshipMemoryEnvelope: returns null for group contacts', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        id: 'group_secret_id',
        name: 'Secret Investor Group',
        isGroup: true,
    }, {});
    assert.equal(envelope, null);
});

test('exportGbrainMemory: excludes group contacts entirely', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-gbrain-groups-'));
    try {
        const dataDir = path.join(tmp, 'data');
        const outDir = path.join(tmp, 'out');
        fs.mkdirSync(path.join(dataDir, 'unified'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'unified', 'contacts.json'), JSON.stringify([
            CONTACT,
            { ...CONTACT, id: 'group_secret_id', name: 'Secret Investor Group', isGroup: true },
        ]));
        fs.writeFileSync(path.join(dataDir, 'unified', 'insights.json'), JSON.stringify({}));

        const result = exportGbrainMemory({ dataDir, outDir, now: '2026-05-09T00:00:00.000Z' });
        const serialized = fs.readFileSync(result.jsonlPath, 'utf8') + fs.readFileSync(result.markdownPath, 'utf8');

        assert.equal(serialized.includes('Secret Investor Group'), false);
        assert.equal(serialized.includes('group_secret_id'), false);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('buildRelationshipMemoryEnvelope: strips URLs, source handles, and private paths from profile metadata', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        title: 'Founder https://private.example/token/abc123',
        company: 'Handle @secret-source /Users/sree/private/export.json',
        location: 'token_path=/tmp/private-token-file',
    }, {});
    const serialized = JSON.stringify(envelope);

    assert.equal(serialized.includes('https://private.example'), false);
    assert.equal(serialized.includes('@secret-source'), false);
    assert.equal(serialized.includes('/Users/sree/private'), false);
    assert.equal(serialized.includes('private-token-file'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: FAIL because the current envelope has raw `id`, accepts raw topic prose, and does not expose `contactIdsOmitted`.

**Step 3: Commit**

Do not commit the failing tests separately unless your workflow requires an explicit RED commit. If committing RED, use:

```bash
git add tests/unit/gbrain-export.test.js
git commit -m "test: define GBrain export privacy contract"
```

---

### Task 2: Reuse shared privacy/source helpers in the exporter

**Objective:** Replace export-local sanitization and raw ids with the same safe primitives used by MCP/source events.

**Files:**
- Modify: `scripts/export-gbrain-memory.js`
- Test: `tests/unit/gbrain-export.test.js`

**Step 1: Update imports**

At the top of `scripts/export-gbrain-memory.js`, replace the local regex-only privacy approach with shared helpers:

```js
const { warmthLabel } = require('../crm/agent-retrieval');
const { redactDirectContactDetails, stripDirectContactDetails, agentSafetyEnvelope } = require('../crm/privacy-envelope');
const { canonicalSafeSource, safeContactRef, parseSafeTimestamp } = require('../crm/source-events');
const { extractAllowedTopics } = require('../crm/evidence-patches');
```

Keep `EMAIL_RE` / `PHONE_RE` only if still used by `safeText`; otherwise delete them.

**Step 2: Replace `safeText` with shared redaction and profile-boundary scrubbing**

Replace `safeText()` with a final-boundary scrubber that removes direct contact details plus URLs, handle-like source labels, and obvious private/token paths before any value is written to JSONL or Markdown. Reuse the existing local `text()` helper already defined near the top of `scripts/export-gbrain-memory.js`; do not add a new import for it unless that helper is later moved/exported deliberately:

```js
function safeText(value, fallback = '') {
    const cleaned = stripDirectContactDetails(text(value))
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\b(?:token|secret|credential|session|cookie)[_-]?(?:path|file)?\s*[:=]\s*\S+/gi, '')
        .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/root\/|\/tmp\/|\.\/|\.\.\/)[^\s]+/g, ' ')
        .replace(/(^|\s)@[A-Za-z0-9_.-]{2,}/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}
```

Use `safeText()` for `person`, title, company, location, evidence labels/details, and Markdown line values; never write raw profile metadata directly.

**Step 3: Add safe topic and source helpers**

Add below `uniq()`:

```js
function safeTopics(values, limit = 20) {
    const out = [];
    for (const value of values.flat()) {
        for (const topic of extractAllowedTopics(value)) {
            if (!out.includes(topic)) out.push(topic);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function safeSourceNames(contact) {
    const names = Object.keys((contact && contact.sources) || {})
        .map(canonicalSafeSource)
        .filter(Boolean)
        .sort();
    return [...new Set(names)];
}

function safeCitationRef(contactRef, kind, index) {
    return `${contactRef}:gbrain:${kind}:${index}`;
}
```

Replace all calls to `sourceNames(contact)` with `safeSourceNames(contact)` and remove `sourceNames()`.

**Step 4: Run test to verify partial failure**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: still FAIL until the envelope shape is updated in Task 3.

---

### Task 3: Add contactRef, citations, freshness, and stronger safety envelope

**Objective:** Make each exported relationship-memory row durable, source-backed, and privacy-contract-compatible with MCP.

**Files:**
- Modify: `scripts/export-gbrain-memory.js`
- Test: `tests/unit/gbrain-export.test.js`

**Step 1: Replace `buildRelationshipMemoryEnvelope()` body**

Use this implementation skeleton, preserving existing title/company/location helpers:

```js
function buildRelationshipMemoryEnvelope(contact, insights = {}, opts = {}) {
    if (!contact || contact.isGroup === true) return null;
    const contactRef = safeContactRef(contact.id);
    const contactInsights = insights[contact.id] || insights[contactRef] || {};
    const rawTitle = contactTitle(contact);
    const rawCompany = contactCompany(contact);
    const rawLocation = contactLocation(contact);
    const title = safeText(rawTitle);
    const company = safeText(rawCompany);
    const location = safeText(rawLocation);
    const sources = safeSourceNames(contact);
    const latestAt = parseSafeTimestamp(contact.lastSyncedAt || contact.updatedAt || contact.lastContactedAt);
    const topics = safeTopics([
        ...(Array.isArray(contact.tags) ? contact.tags : []),
        ...(Array.isArray(contactInsights.keywords) ? contactInsights.keywords : []),
        // Keep legacy safe topics only when allowlisted; arbitrary prose is dropped by extractAllowedTopics().
        ...(Array.isArray(contactInsights.topics) ? contactInsights.topics : []),
        title,
        company,
        location,
    ]);

    const evidence = [];
    sources.forEach((source, index) => {
        evidence.push({
            citationRef: safeCitationRef(contactRef, 'source', index),
            kind: 'source_presence',
            source,
            label: safeText(`Present in ${source} source data`),
            detail: source === 'googlecontacts'
                ? safeText('Synced from Google Contacts metadata; direct contact details omitted.')
                : safeText('Derived from local Minty source data; direct contact details omitted.'),
            latestAt,
            count: 1,
        });
    });
    [
        ['role', 'Role/title evidence', title],
        ['company', 'Company evidence', company],
        ['location', 'Location evidence', location],
    ].forEach(([kind, label, detail], index) => {
        if (!detail) return;
        evidence.push({
            citationRef: safeCitationRef(contactRef, kind, index),
            kind,
            source: 'minty',
            label: safeText(label),
            detail: safeText(detail),
            latestAt,
            count: 1,
        });
    });
    topics.slice(0, 8).forEach((topic, index) => {
        evidence.push({
            citationRef: safeCitationRef(contactRef, 'topic', index),
            kind: 'topic',
            source: 'minty',
            label: safeText('Allowed topic evidence'),
            detail: safeText(topic),
            latestAt,
            count: 1,
        });
    });

    const confidence = evidence.length >= 4 && sources.length > 0 ? 'medium' : 'low';
    return {
        type: 'relationship_memory',
        schemaVersion: 2,
        contactRef,
        person: safeText(contact.name || contact.displayName, 'Unknown person'),
        headline: [title, company].filter(Boolean).join(' at ') || title || company || null,
        title,
        company,
        location,
        topics,
        relationship: {
            score: contact.relationshipScore || 0,
            warmth: warmthLabel(contact.relationshipScore || 0),
            interactionCount: contact.interactionCount || 0,
            daysSinceContact: contact.daysSinceContact ?? null,
            activeChannels: Array.isArray(contact.activeChannels)
                ? [...new Set(contact.activeChannels.map(canonicalSafeSource).filter(Boolean))].sort()
                : [],
        },
        evidence,
        sourceMetadata: {
            sources,
            latestAt,
            profileSourceCount: sources.length,
            evidenceCount: evidence.length,
            confidence,
            freshness: latestAt ? 'source_synced' : 'unknown',
        },
        safety: {
            ...agentSafetyEnvelope({ omittedFields: ['messageBodies', 'groupNames', 'groupIds', 'sourceHandles', 'privatePaths', 'rawInsightText'] }),
            readOnly: true,
            noLlmCalls: true,
            contactIdsOmitted: true,
            directContactDetailsOmitted: true,
            rawMessagesOmitted: true,
            rawInsightTextOmitted: true,
            noOutreachTriggered: true,
            safeToUseInAgentContext: true,
        },
    };
}
```

**Step 2: Update existing test expectations**

In `tests/unit/gbrain-export.test.js`, update expectations:

- `schemaVersion` should be `2`.
- `envelope.id` should be `undefined`.
- `envelope.contactRef` should match `/^contact:[a-p]{16}$/`.
- Google Contacts source label should be `googlecontacts`, not `googleContacts`.
- Safety assertions should include `contactIdsOmitted`, `rawMessagesOmitted`, `rawInsightTextOmitted`, `noLlmCalls`, and `noOutreachTriggered`.

**Step 3: Run test to verify pass**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: PASS.

**Step 4: Exclude group contacts before envelope construction**

In `exportGbrainMemory()`, filter contacts before mapping:

```js
const exportableContacts = contacts.filter(c => c && c.isGroup !== true);
const envelopes = exportableContacts
    .map(c => buildRelationshipMemoryEnvelope(c, insights))
    .filter(Boolean);
```

Do not emit a placeholder row for groups; omitting them is safer than carrying group names/ids into durable memory.

**Step 5: Commit**

```bash
git add scripts/export-gbrain-memory.js tests/unit/gbrain-export.test.js
git commit -m "fix: harden GBrain export trust contract"
```

---

### Task 4: Make Markdown output preserve citation/safety metadata

**Objective:** Ensure the Markdown private-brain artifact remains useful without reintroducing raw details.

**Files:**
- Modify: `scripts/export-gbrain-memory.js`
- Modify: `tests/unit/gbrain-export.test.js`

**Step 1: Write failing Markdown assertions**

Append to the existing Markdown tests:

```js
test('envelopeToMarkdown: renders citation refs and trust metadata without raw ids', () => {
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, INSIGHTS);
    const md = envelopeToMarkdown(envelope);

    assert.match(md, /- Contact ref: contact:[a-p]{16}/);
    assert.match(md, /- Confidence: medium|low/);
    assert.match(md, /citation: contact:[a-p]{16}:gbrain:/);
    assert.match(md, /- Safety: direct contact details, contact ids, raw messages, and raw insight text omitted/);
    assert.equal(md.includes(CONTACT.id), false);
    assert.equal(md.includes('ada@example.com'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: FAIL because Markdown does not yet render contact ref/confidence/citations.

**Step 3: Update `envelopeToMarkdown()`**

Replace the top metadata lines in `envelopeToMarkdown()` with:

```js
lines.push(`## ${safeText(envelope.person, 'Unknown person')}`);
lines.push(`- Contact ref: ${envelope.contactRef || 'unknown'}`);
if (envelope.headline) lines.push(`- Headline: ${safeText(envelope.headline)}`);
if (envelope.location) lines.push(`- Location: ${safeText(envelope.location)}`);
lines.push(`- Relationship: ${safeText(envelope.relationship.warmth)}, score ${Number(envelope.relationship.score) || 0}`);
lines.push(`- Sources: ${envelope.sourceMetadata.sources.join(', ') || 'unknown'}`);
lines.push(`- Confidence: ${safeText(envelope.sourceMetadata.confidence || 'low')}`);
if (envelope.sourceMetadata.latestAt) lines.push(`- Latest safe timestamp: ${envelope.sourceMetadata.latestAt}`);
if (envelope.topics.length) lines.push(`- Topics: ${envelope.topics.map(t => safeText(t)).filter(Boolean).join(', ')}`);
lines.push('- Safety: direct contact details, contact ids, raw messages, and raw insight text omitted; read-only relationship memory.');
```

Update evidence rendering to include citations:

```js
for (const e of envelope.evidence.slice(0, 12)) {
    const citation = e.citationRef ? ` (citation: ${e.citationRef})` : '';
    const label = safeText(e.label, 'Evidence');
    const detail = safeText(e.detail);
    lines.push(`  - ${label}${detail ? `: ${detail}` : ''}${citation}`);
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/export-gbrain-memory.js tests/unit/gbrain-export.test.js
git commit -m "fix: preserve GBrain export citations in markdown"
```

---

### Task 5: Load source events for stronger freshness when available

**Objective:** Use existing `source-events.json` to give exports better freshness/count metadata without raw events.

**Files:**
- Modify: `scripts/export-gbrain-memory.js`
- Modify: `tests/unit/gbrain-export.test.js`

**Step 1: Write failing test**

Append:

```js
test('buildRelationshipMemoryEnvelope: summarizes source events by contactRef when provided', () => {
    const contactRef = require('../../crm/source-events').safeContactRef(CONTACT.id);
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, INSIGHTS, {
        sourceEvents: [
            { contactRef, source: 'email', type: 'message', timestamp: '2026-05-01T10:00:00.000Z', attributed: true },
            { contactRef, source: 'telegram', type: 'message', timestamp: '2026-05-02T10:00:00.000Z', attributed: true },
            { contactRef: CONTACT.id, source: 'email', type: 'message', timestamp: '2026-05-04T10:00:00.000Z', attributed: true }, // ignored: raw ids are not safe refs
            { contactRef: 'contact:other', source: 'email', type: 'message', timestamp: '2026-05-03T10:00:00.000Z', attributed: true },
        ],
    });

    assert.equal(envelope.sourceMetadata.eventCount, 2);
    assert.equal(envelope.sourceMetadata.latestAt, '2026-05-02T10:00:00.000Z');
    assert.ok(envelope.evidence.some(e => e.kind === 'source_event_summary' && e.count === 2));
    assert.equal(JSON.stringify(envelope).includes(CONTACT.id), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: FAIL because `sourceEvents` are not used.

**Step 3: Add source-event summarizer**

Add helper:

```js
function summarizeEventsForContact(contactRef, sourceEvents = []) {
    const safeRefRe = /^contact:[a-p]{16}$/;
    if (!safeRefRe.test(contactRef)) return { count: 0, sources: [], latestAt: null };
    const rows = (Array.isArray(sourceEvents) ? sourceEvents : [])
        .filter(e => e && e.contactRef === contactRef && safeRefRe.test(e.contactRef) && e.attributed !== false);
    const sources = [...new Set(rows.map(e => canonicalSafeSource(e.source)).filter(Boolean))].sort();
    const timestamps = rows.map(e => parseSafeTimestamp(e.timestamp)).filter(Boolean).sort();
    return {
        count: rows.length,
        sources,
        latestAt: timestamps.length ? timestamps[timestamps.length - 1] : null,
    };
}
```

In `buildRelationshipMemoryEnvelope()`, compute the event summary and final `latestAt` immediately after `contactRef` and before constructing any evidence so every evidence row receives the same final safe timestamp:

```js
const eventSummary = summarizeEventsForContact(contactRef, opts.sourceEvents);
const latestAt = eventSummary.latestAt || parseSafeTimestamp(contact.lastSyncedAt || contact.updatedAt || contact.lastContactedAt);
```

Remove the earlier Task 3 `const latestAt = ...` line so there is only one `latestAt` definition.

Add evidence when events exist:

```js
if (eventSummary.count > 0) {
    evidence.push({
        citationRef: safeCitationRef(contactRef, 'source-events', 0),
        kind: 'source_event_summary',
        source: 'minty',
        label: 'Attributed source events available',
        detail: `${eventSummary.count} redacted events across ${eventSummary.sources.join(', ') || 'unknown sources'}`,
        latestAt: eventSummary.latestAt,
        count: eventSummary.count,
    });
}
```

Include in `sourceMetadata`:

```js
eventCount: eventSummary.count,
eventSources: eventSummary.sources,
```

**Step 4: Teach `loadData()` to read source events, then pass them from `exportGbrainMemory()`**

In `loadData(dataDir)`, add optional loading for the deterministic source-event cache. Missing files should return an empty array, not fail the export:

```js
const sourceEventsPath = path.join(dataDir, 'unified', 'source-events.json');
const sourceEvents = fs.existsSync(sourceEventsPath) ? readJson(sourceEventsPath, []) : [];
return { contacts, insights, sourceEvents };
```

Then change data loading:

```js
const { contacts, insights, sourceEvents } = loadData(dataDir);
```

Change the export map from Task 3 to preserve the group-contact filter while passing source events:

```js
const exportableContacts = contacts.filter(c => c && c.isGroup !== true);
const envelopes = exportableContacts
    .map(c => buildRelationshipMemoryEnvelope(c, insights, { sourceEvents }))
    .filter(Boolean);
```

**Step 5: Run test to verify pass**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/export-gbrain-memory.js tests/unit/gbrain-export.test.js
git commit -m "feat: include safe source freshness in GBrain export"
```

---

### Task 6: Update docs and run focused verification

**Objective:** Document the new durable-memory boundary and verify the exporter end-to-end with synthetic data.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `docs/SERVICE.md`
- Modify: `hermes/minty-network-memory/SKILL.md`

**Step 1: Update `docs/HERMES_INTEGRATION.md`**

Replace the paragraph about `npm run gbrain:export` with:

```md
`npm run gbrain:export` writes durable relationship-memory JSONL and Markdown under `data/gbrain/` for private-brain ingestion. The export is privacy-safe and read-only: it uses opaque `contactRef` values, canonical source labels, redacted citations, freshness/count metadata, and explicit safety flags. It intentionally omits raw contact ids, emails, phones, source handles, group names/ids, raw message bodies, private paths, and raw insight prose. Use MCP `search_network` / `source_health` for live freshness-sensitive answers; use GBrain export for durable private memory.
```

**Step 2: Update `docs/SERVICE.md`**

In the GBrain export section, add:

```md
Service-mode GBrain export is durable memory, not a live query path. It should be treated as a privacy-safe summary snapshot. For source-specific or freshness-critical questions, agents should call Minty's MCP `source_health` and `search_network` tools directly.
```

**Step 3: Update `hermes/minty-network-memory/SKILL.md`**

Add a short rule near the GBrain export instructions:

```md
When using GBrain export results, treat `contactRef`/citation refs as opaque. Do not ask Minty or GBrain to recover raw emails, phones, source ids, group names, or message bodies from those refs. If live freshness matters, call Minty MCP `source_health` first.
```

**Step 4: Run focused verification**

Run:

```bash
node --test tests/unit/gbrain-export.test.js
npm run seed:demo
npm run gbrain:export -- --data-dir data-demo --out-dir /tmp/minty-gbrain-export-check
node - <<'NODE'
const fs = require('node:fs');
const path = '/tmp/minty-gbrain-export-check/relationship-memory.jsonl';
const rows = fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
if (!rows.length) throw new Error('expected exported rows');
for (const row of rows) {
  if (row.id) throw new Error('raw id leaked');
  if (!/^contact:[a-p]{16}$/.test(row.contactRef)) throw new Error('missing opaque contactRef');
  const text = JSON.stringify(row);
  for (const forbidden of ['emails','phones','rawContact']) {
    if (Object.prototype.hasOwnProperty.call(row, forbidden)) throw new Error(`forbidden field: ${forbidden}`);
  }
  if (/@example\.com/.test(text)) throw new Error('fixture email leaked');
}
console.log(`checked ${rows.length} rows`);
NODE
```

Expected: all commands pass and the final script prints `checked N rows`.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md docs/SERVICE.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: clarify GBrain export trust boundary"
```

---

## Final verification

Run the focused and product-contract checks:

```bash
node --test tests/unit/gbrain-export.test.js
npm run network:evaluate
npm test
```

Expected:

- `tests/unit/gbrain-export.test.js` passes.
- `npm run network:evaluate` passes with synthetic fixtures only.
- `npm test` passes.

Then inspect the diff before opening a PR:

```bash
git diff --check
git status --short --branch
git log --oneline -5
```

## Builder notes

- Preserve the Minty/GBrain boundary: Minty owns live freshness and source provenance; GBrain receives durable privacy-safe snapshots.
- If any test fixture uses realistic emails/phones/source ids, keep them synthetic sentinels and assert they do not appear in serialized output.
- If `extractAllowedTopics()` is too strict for useful durable topics, widen that helper in a separate tiny PR with tests. Do not bypass it in the exporter.
- This export is private local data, but durable memory should still be treated as stricter than transient MCP output because leaks persist across sessions.
