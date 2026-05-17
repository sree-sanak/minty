# Safe Timeline Metadata Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Expose privacy-safe attachment/link/reaction cues in contact timelines without leaking raw provider payloads.

**Architecture:** Add a tiny pure metadata normalizer in `crm/schema.js`, call it from `createInteraction()`, preserve existing raw data locally, and return only safe booleans/counts through existing interaction APIs and the contact timeline UI. Start with LinkedIn `hasAttachment`, then support generic link-preview/reaction counts only when already present in local source artifacts.

**Tech Stack:** Plain Node.js CommonJS, existing merge pipeline, existing `GET /api/contacts/:id/interactions`, inline SPA in `crm/ui.html.js`, Node built-in test runner. No new dependencies, provider calls, scraping, sends, uploads, or runtime LLM calls.

---

## Product context

Issue #257 is the right next activation/trust gap after the source-quality work. Minty already has strong agent trust surfaces (`source_health`, answerability, citations, GBrain export hardening, local Discord/Slack/iMessage importers, source-quality workbench, source-quality CLI), but the human contact timeline still collapses useful source context into plain message rows. LinkedIn already detects `hasAttachment` in `sources/linkedin/parse-messages.js` and importer/fetch paths, yet that cue is buried in `raw` and invisible to users.

This is not CRM busywork. It helps a founder or agent operator understand why a relationship has usable evidence: “there was an attachment/link/reaction here” without exposing the attachment name, URL, provider ID, local path, profile URL, or raw message payload.

## Current code anchors

- `crm/schema.js:42-55` creates every unified interaction and currently stores only `id`, `source`, `timestamp`, `from`, `to`, `body`, `subject`, `chatId`, `chatName`, `type`, and `raw`.
- `crm/merge.js:438-448` creates LinkedIn interactions from `data/linkedin/messages.json`; `m.hasAttachment` is already available from import/fetch paths.
- `sources/linkedin/parse-messages.js` and `tests/unit/linkedin-parse-messages.test.js` already prove `hasAttachment` becomes the CSV/export `ATTACHMENTS` flag.
- `crm/server.js:320-361` returns raw unified interaction objects from `getContactInteractions()`, which means any new top-level safe `metadata` field automatically reaches `GET /api/contacts/:id/interactions`.
- `crm/server.js:764-803` serves `GET /api/contacts/:id/interactions` and `GET /api/contacts/:id/timeline`; the timeline endpoint should keep relationship arc/monthly counts unchanged while interaction rows gain metadata.
- `crm/ui.html.js:3458-3515` renders contact interactions and can show compact badges beside each message row.
- `tests/unit/schema.test.js` already exists and imports `createContact` / `createInteraction`; extend it instead of replacing the file.
- `tests/integration/api-data-resilience.test.js` already seeds `interactions.json` and exercises `/api/contacts/:id/interactions` and `/api/contacts/:id/timeline` privacy/error behavior.

## Acceptance criteria

- `createInteraction()` adds a top-level `metadata` object with only safe fields:
  - `hasAttachment: true` when the source artifact has an attachment-presence signal;
  - `linkPreviewCount: N` when the source artifact already has a countable link-preview collection/count;
  - `reactionCount: N` when the source artifact already has a countable reaction collection/count.
- The `metadata` object never includes raw URLs, attachment names, file names, provider IDs, local paths, profile URLs, emails, phones, source handles, message IDs, group names, or message bodies.
- Existing `raw` preservation remains unchanged for local/server-side reference, but the UI and tests consume `interaction.metadata`, not `interaction.raw`.
- `/api/contacts/:id/interactions` returns the safe metadata for matched interactions and does not serialize private raw metadata values in the new top-level field.
- Contact interaction rows show compact badges such as `Attachment`, `2 links`, `3 reactions` only when metadata is present.
- Existing relationship timeline counts, interaction sorting, source labels, and body/snippet rendering stay unchanged.

## Non-goals

- No attachment download, preview, upload, thumbnail, OCR, or file browser.
- No provider/API/OAuth changes and no live source sync changes.
- No exposure of raw `raw.ATTACHMENTS`, file names, URLs, sender profile URLs, local paths, provider IDs, channel IDs, or message bodies beyond the already-rendered snippet path.
- No new MCP tool or agent envelope field in this slice; this is UI/API timeline context only.
- No broad “rich media” model. Keep the first slice to booleans/counts.

---

### Task 1: Add a pure safe interaction metadata normalizer

**Objective:** Create a deterministic normalizer that extracts only safe booleans/counts from raw source records.

**Files:**
- Modify: `crm/schema.js`
- Test: `tests/unit/schema.test.js`

**Step 1: Write failing tests**

Extend `tests/unit/schema.test.js`. Keep the existing `createContact` tests and update the import line from:

```js
const { createContact, createInteraction } = require('../../crm/schema');
```

to:

```js
const { createContact, createInteraction, safeInteractionMetadata } = require('../../crm/schema');
```

Then append:

```js
test('[InteractionMetadata]: extracts only safe booleans and counts', () => {
    const metadata = safeInteractionMetadata({
        hasAttachment: true,
        linkPreviews: [
            { url: 'https://' + 'private.example/link-one', title: 'Private title' },
            { url: 'https://' + 'private.example/link-two' },
        ],
        reactions: [{ emoji: '🔥', userId: 'raw_user_1' }, { emoji: '✅', userId: 'raw_user_2' }],
        attachmentName: 'private' + '-deck.pdf',
        fileUrl: 'https://' + 'private.example/file.pdf',
        senderProfileUrl: 'https://' + 'private.example/profile',
        email: 'person' + '@' + 'example.test',
        phone: '+155****0123',
    });

    assert.deepEqual(metadata, {
        hasAttachment: true,
        linkPreviewCount: 2,
        reactionCount: 2,
    });
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes('private-deck'), false);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes('person@example.test'), false);
    assert.equal(serialized.includes('+155'), false);
    assert.equal(serialized.includes('raw_user'), false);
});

test('[InteractionMetadata]: omits empty metadata', () => {
    assert.deepEqual(safeInteractionMetadata({}), {});
    assert.deepEqual(safeInteractionMetadata({ hasAttachment: false, linkPreviews: [], reactions: [] }), {});
});

test('[InteractionMetadata]: createInteraction attaches safe metadata and preserves raw locally', () => {
    const interaction = createInteraction('linkedin', {
        id: 'synthetic-message-1',
        timestamp: '2026-05-17T10:00:00.000Z',
        body: 'synthetic body',
        hasAttachment: true,
        attachmentName: 'private' + '-deck.pdf',
    });

    assert.deepEqual(interaction.metadata, { hasAttachment: true });
    assert.equal(interaction.raw.attachmentName, 'private-deck.pdf');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/schema.test.js
```

Expected: FAIL because `safeInteractionMetadata` is not exported and `createInteraction()` does not attach `metadata`.

**Step 3: Implement the minimal normalizer**

Modify `crm/schema.js`:

```js
function toNonNegativeCount(value) {
    if (Array.isArray(value)) return value.length;
    if (Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    return 0;
}

function safeInteractionMetadata(raw = {}) {
    const metadata = {};

    const attachmentSignal = raw.hasAttachment === true
        || raw.hasAttachments === true
        || raw.attachment === true
        || raw.attachmentCount > 0
        || toNonNegativeCount(raw.attachments) > 0
        || (typeof raw.ATTACHMENTS === 'string' && raw.ATTACHMENTS.trim() !== '');
    if (attachmentSignal) metadata.hasAttachment = true;

    const linkPreviewCount = toNonNegativeCount(raw.linkPreviewCount)
        || toNonNegativeCount(raw.linkPreviews)
        || toNonNegativeCount(raw.links);
    if (linkPreviewCount > 0) metadata.linkPreviewCount = linkPreviewCount;

    const reactionCount = toNonNegativeCount(raw.reactionCount)
        || toNonNegativeCount(raw.reactions);
    if (reactionCount > 0) metadata.reactionCount = reactionCount;

    return metadata;
}

function createInteraction(source, raw) {
    const metadata = safeInteractionMetadata(raw || {});
    return {
        id: raw.id || null,
        source,
        timestamp: raw.timestamp || raw.date || null,
        from: raw.from || null,
        to: raw.to || null,
        body: raw.body || raw.text || raw.content || null,
        subject: raw.subject || null,
        chatId: raw.chatId || raw.conversationId || null,
        chatName: raw.chatName || null,
        type: raw.type || 'message',
        metadata,
        raw,
    };
}

module.exports = { createContact, createInteraction, safeInteractionMetadata };
```

Keep `metadata` as `{}` instead of `null`; it is stable for UI checks and cheap to serialize.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/schema.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/schema.js tests/unit/schema.test.js
git commit -m "feat: add safe interaction metadata"
```

---

### Task 2: Prove LinkedIn attachment signals survive merge safely

**Objective:** Ensure existing LinkedIn attachment evidence becomes top-level safe metadata in unified interactions without adding source-specific UI reads.

**Files:**
- Modify: `tests/unit/schema.test.js`
- Optional inspect only: `tests/unit/linkedin-parse-messages.test.js`

**Step 1: Write failing test**

Add a focused LinkedIn-shape test near the Task 1 metadata tests in `tests/unit/schema.test.js`:

```js
test('[InteractionMetadata]: LinkedIn attachment presence becomes safe interaction metadata', () => {
    const interaction = createInteraction('linkedin', {
        id: 'linkedin-message-with-attachment',
        timestamp: '2026-05-17T10:00:00.000Z',
        from: 'Synthetic Sender',
        body: 'synthetic message body',
        hasAttachment: true,
        senderProfileUrl: 'https://' + 'private.example/profile',
        attachmentName: 'private' + '-deck.pdf',
    });

    assert.deepEqual(interaction.metadata, { hasAttachment: true });
    assert.equal(JSON.stringify(interaction.metadata).includes('https://'), false);
    assert.equal(JSON.stringify(interaction.metadata).includes('private-deck'), false);
});
```

**Step 2: Run test to verify pass**

Run:

```bash
node --test tests/unit/schema.test.js tests/unit/linkedin-parse-messages.test.js
```

Expected: PASS after Task 1. `linkedin-parse-messages.test.js` should still pass because the LinkedIn parser already emits the attachment presence flag; this task only proves `createInteraction('linkedin', ...)` makes it safe and visible.

**Step 3: Commit**

```bash
git add tests/unit/schema.test.js
git commit -m "test: cover linkedin interaction metadata"
```

---

### Task 3: Add focused API privacy coverage for timeline metadata

**Objective:** Verify `/api/contacts/:id/interactions` exposes safe metadata while omitting sensitive raw metadata values from the new field.

**Files:**
- Modify: `tests/integration/api-data-resilience.test.js`

**Step 1: Write failing integration test**

Add a test near the existing contact-interactions API tests:

```js
test('/api/contacts/:id/interactions returns safe metadata badges without raw attachment data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-timeline-metadata-'));
    const unified = path.join(dir, 'unified');
    writeJson(path.join(unified, 'contacts.json'), [{
        id: 'li_person_safe_metadata',
        name: 'Synthetic Timeline Person',
        emails: [],
        phones: [],
        sources: { linkedin: { name: 'Synthetic Timeline Person' } },
        activeChannels: ['linkedin'],
    }]);
    writeJson(path.join(unified, 'interactions.json'), [{
        id: 'li_interaction_metadata_1',
        source: 'linkedin',
        timestamp: '2026-05-17T10:00:00.000Z',
        from: 'Synthetic Timeline Person',
        body: 'synthetic snippet',
        chatName: 'Synthetic Timeline Person, Sree',
        metadata: { hasAttachment: true, linkPreviewCount: 1, reactionCount: 2 },
        raw: {
            attachmentName: 'private' + '-deck.pdf',
            fileUrl: 'https://' + 'private.example/file.pdf',
            senderProfileUrl: 'https://' + 'private.example/profile',
            senderEmail: 'timeline-person' + '@' + 'example.test',
        },
    }]);

    const server = createServer({ dataDir: dir });
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/li_person_safe_metadata/interactions`);
        assert.equal(response.status, 200);
        const rows = await response.json();
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].metadata, { hasAttachment: true, linkPreviewCount: 1, reactionCount: 2 });
        const serializedMetadata = JSON.stringify(rows[0].metadata);
        assert.equal(serializedMetadata.includes('private-deck'), false);
        assert.equal(serializedMetadata.includes('https://'), false);
        assert.equal(serializedMetadata.includes('timeline-person@example.test'), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
```

Important: this test intentionally checks the new top-level `metadata` field. Do not assert that `raw` disappears from this endpoint unless the builder deliberately chooses a broader API sanitization refactor; that is out of scope for this slice.

**Step 2: Run test to verify pass**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: PASS after Task 1.

**Step 3: Commit**

```bash
git add tests/integration/api-data-resilience.test.js
git commit -m "test: cover interaction metadata API privacy"
```

---

### Task 4: Render compact safe metadata badges in contact interactions

**Objective:** Show useful attachment/link/reaction cues in the contact interaction list without exposing raw fields.

**Files:**
- Modify: `crm/ui.html.js:3458-3515`
- Test: `tests/e2e/` only if an existing contact detail smoke can be extended cheaply; otherwise rely on unit/integration tests plus manual browser verification.

**Step 1: Add tiny UI helpers near `loadInteractions()`**

Modify `crm/ui.html.js` before `async function loadInteractions(contactId)`:

```js
function interactionMetadataBadges(metadata) {
  const m = metadata || {};
  const badges = [];
  if (m.hasAttachment) badges.push('Attachment');
  if (Number.isFinite(m.linkPreviewCount) && m.linkPreviewCount > 0) badges.push(m.linkPreviewCount === 1 ? '1 link' : m.linkPreviewCount + ' links');
  if (Number.isFinite(m.reactionCount) && m.reactionCount > 0) badges.push(m.reactionCount === 1 ? '1 reaction' : m.reactionCount + ' reactions');
  return badges;
}

function renderInteractionMetadataBadges(metadata) {
  const badges = interactionMetadataBadges(metadata);
  if (!badges.length) return '';
  return '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:3px">' + badges.map(label =>
    '<span style="font-size:0.62rem;color:var(--text-muted);border:1px solid var(--border);border-radius:999px;padding:1px 6px;background:rgba(99,102,241,0.08)">' + esc(label) + '</span>'
  ).join('') + '</div>';
}
```

Then inside the row renderer, after `const chat = ...`, add:

```js
const metadataBadges = renderInteractionMetadataBadges(i.metadata);
```

And render after the body line:

```js
${metadataBadges}
```

**Step 2: Verify no raw fields are used**

Inspect the edited block and ensure it reads only `i.metadata`, never `i.raw`, `i.raw.ATTACHMENTS`, `i.raw.fileUrl`, `i.raw.senderProfileUrl`, or provider-specific attachment fields.

**Step 3: Run focused checks**

Run:

```bash
node --test tests/unit/schema.test.js tests/integration/api-data-resilience.test.js
npm test
```

Expected: all tests pass.

If an e2e contact-detail smoke exists and can be extended with synthetic metadata in under 10 minutes, run:

```bash
npm run test:e2e
```

Expected: pass. If not extended, manually verify with a local synthetic contact that the row shows `Attachment` and does not show raw file/link strings.

**Step 4: Commit**

```bash
git add crm/ui.html.js tests/integration/api-data-resilience.test.js crm/schema.js tests/unit/schema.test.js
git commit -m "feat: show safe timeline metadata badges"
```

---

### Task 5: Final privacy and regression verification

**Objective:** Prove the shipped slice is narrow, safe, and does not regress source trust surfaces.

**Files:**
- No new files unless fixing a failing check.

**Step 1: Run targeted tests**

```bash
node --test tests/unit/schema.test.js
node --test tests/unit/linkedin-parse-messages.test.js
node --test tests/integration/api-data-resilience.test.js
```

Expected: PASS.

**Step 2: Run full project tests**

```bash
npm test
```

Expected: PASS.

**Step 3: Run e2e if UI changed**

```bash
npm run test:e2e
```

Expected: PASS. If Playwright browser setup is missing, run `npx playwright install chromium` once and rerun.

**Step 4: Privacy scan the diff**

```bash
git diff --check HEAD~3..HEAD
git diff HEAD~3..HEAD -- crm/schema.js crm/ui.html.js tests/unit/schema.test.js tests/integration/api-data-resilience.test.js | grep -E "(private-deck|https://private|timeline-person@example|senderProfileUrl|fileUrl|attachmentName)" || true
```

Expected: only split synthetic test literals or raw-fixture setup lines appear; no UI rendering code consumes those raw fields. If raw fields appear in `crm/ui.html.js` or `metadata` output assertions, fix before merging.

**Step 5: Commit any verification fixes**

```bash
git add <fixed-files>
git commit -m "fix: keep timeline metadata privacy-safe"
```

## Builder notes

- Keep the implementation boring. A tiny `metadata` object beats a generic media model.
- Do not remove `raw`; too many local flows may rely on it. This plan only introduces safe top-level cues.
- Do not parse message bodies for links. Only count explicit structured fields already present in local artifacts.
- If the endpoint currently returns `raw`, do not broaden this into an API-sanitization migration. That needs a separate plan because the UI may rely on existing interaction shape.
- If tests reveal the contact matching path misses LinkedIn interactions unless `chatName` includes the contact's LinkedIn name, fix the fixture, not production matching.
