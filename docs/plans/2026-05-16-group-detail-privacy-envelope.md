# Group Detail Privacy Envelope Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix issue #248 by making `GET /api/groups/:chatId` a privacy-safe debug/trust surface instead of a raw WhatsApp message dump.

**Architecture:** Keep the existing group-detail route and UI shape, but introduce a small server-side privacy envelope for group messages, unresolved senders, pinned messages, and roster rows. The endpoint should preserve useful context for source-quality debugging — sender display name/kind, opaque sender refs, counts, timestamps, and redacted snippets — while omitting raw WhatsApp sender ids, raw contact ids, phones, full message bodies, raw pinned payloads, group owner ids, and group descriptions.

**Tech Stack:** Plain Node.js CommonJS, `node:test`, existing `crm/server.js` route handlers, existing `createServer()` integration-test pattern.

---

## Why this matters

Minty's agent trust work is now strong at the MCP/CLI boundary, but issue #248 shows a weaker browser/API boundary: group detail currently returns raw WhatsApp sender identifiers and raw message bodies. That undercuts the product promise that Minty can expose source-backed relationship memory without leaking direct/source identifiers or private conversations.

This is not CRM polish. It is a trust-contract fix: local-first does not mean every local JSON API may bypass the privacy envelope.

## Current code anchors

- Route: `crm/server.js:1623` `handleGetGroupDetail(req, res, [chatId], paths, uuid)`.
- Current leaking fields:
  - `messages[].from = m.from`
  - `messages[].fromContactId = r.contactId`
  - `messages[].body = m.body || ''`
  - `unresolvedSenders[].id = m.from`
  - `unresolvedSenders[].sample = m.body.slice(0, 80)`
  - `pinnedMessages` spreads raw pinned message objects.
  - `roster[].id` exposes internal contact ids and `roster[].phones` exposes phone numbers.
- Test pattern to reuse: `tests/integration/source-health-api.test.js` starts `createServer({ dataDir: dir, port: 0 })`, seeds temp data, calls `fetch()`, and asserts serialized output excludes private sentinels.

## Acceptance criteria

- `GET /api/groups/:chatId` no longer serializes raw WhatsApp ids such as `@c.us`, `@lid`, `@g.us` values from message senders, participants, owners, or pinned payloads.
- The endpoint no longer serializes raw contact ids, raw phone numbers, or full message bodies.
- Message rows expose only safe fields: `timestamp`, `senderRef`, `fromName`, `fromKind`, optional opaque `fromContactRef`, and a short redacted `snippet`.
- Unresolved sender rows expose only `senderRef`, `count`, `sampleSnippet`, `kind`, and display `name`; no raw sender id.
- Roster rows expose opaque `memberRef`, `name`, role/company, and relationship score; no internal `id` and no `phones`.
- Pinned messages are sanitized to the same contract as normal messages; raw pinned objects are never spread into output.
- Group-level `owner` and `description` are either omitted by default or returned only as sanitized metadata. Prefer omission for this fix; keep `createdAt`, `rosterCount`, `messageCount`, `signals`, and category.
- UI remains usable with the renamed safe fields.
- Tests use synthetic temp data only and prove the serialized API response excludes sentinel source ids, message text, phone/email-like strings, raw contact ids, raw pinned payload fields, and raw owner/description values.

## Non-goals

- Do not add authentication or change the local server security model.
- Do not add an LLM summarizer for group messages.
- Do not remove the group detail page.
- Do not mutate source data, send messages, reconnect WhatsApp, or re-run imports.
- Do not expose raw message bodies behind a query flag in this PR; a future explicit opt-in raw-debug mode needs a separate safety design.

---

### Task 1: Add a failing privacy regression for group detail

**Objective:** Prove the current endpoint leaks raw group sender ids, contact ids, phone-like values, raw bodies, pinned payload fields, owner ids, and description text.

**Files:**
- Create: `tests/integration/group-detail-privacy.test.js`
- Read: `crm/server.js:1623-1722`

**Step 1: Write failing test**

Create `tests/integration/group-detail-privacy.test.js`:

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

function request(server, urlPath, options = {}) {
    const { port } = server.address();
    return fetch(`http://127.0.0.1:${port}${urlPath}`, options);
}

function seedGroupDetailFixture(dir) {
    const chatId = 'private_group_' + '@g.us';
    const senderId = 'private_sender_' + '@c.us';
    const lidId = 'private_lid_' + '@lid';
    const bodyEmail = 'private.group' + '@example.test';
    const privatePhone = '+44 ' + '7700 ' + '900123';

    writeJson(path.join(dir, 'unified', 'contacts.json'), [
        {
            id: 'raw-contact-group-alpha',
            name: 'Synthetic Group Member',
            phones: [privatePhone],
            emails: [bodyEmail],
            sources: { whatsapp: { id: senderId } },
            relationshipScore: 42,
        },
        {
            id: 'raw-group-contact',
            name: 'Private Group Name',
            isGroup: true,
            sources: { whatsapp: { id: chatId } },
        },
    ]);
    writeJson(path.join(dir, 'unified', 'interactions.json'), [
        {
            id: 'raw-message-1',
            contactId: 'raw-group-contact',
            chatId,
            chatName: 'Private Group Name',
            source: 'whatsapp',
            timestamp: '2026-05-16T09:00:00Z',
            from: senderId,
            body: `Full private body with ${bodyEmail} and ${privatePhone}`,
        },
        {
            id: 'raw-message-2',
            contactId: 'raw-group-contact',
            chatId,
            chatName: 'Private Group Name',
            source: 'whatsapp',
            timestamp: '2026-05-16T09:05:00Z',
            from: lidId,
            body: 'Unresolved lid private sample body',
        },
    ]);
    writeJson(path.join(dir, 'unified', 'group-memberships.json'), {
        [chatId]: {
            name: 'Private Group Name',
            size: 1,
            owner: senderId,
            createdAt: '2026-05-01T00:00:00Z',
            description: 'private group description sentinel',
            members: ['raw-contact-group-alpha'],
        },
    });
    writeJson(path.join(dir, 'whatsapp', 'chats.json'), {
        'Private Group Name': {
            meta: {
                id: chatId,
                name: 'Private Group Name',
                owner: senderId,
                description: 'private raw chat description sentinel',
                createdAt: '2026-05-01T00:00:00Z',
                pinnedMessages: [{
                    id: 'raw-pinned-id',
                    from: senderId,
                    author: lidId,
                    body: 'private pinned raw body',
                    text: 'private pinned raw text',
                }],
            },
        },
    });
    return { chatId, senderId, lidId, bodyEmail, privatePhone };
}

test('GET /api/groups/:chatId returns privacy-safe group detail envelope', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-group-detail-privacy-'));
    const fixture = seedGroupDetailFixture(dir);
    const server = await createServer({ dataDir: dir, port: 0 });
    try {
        const res = await request(server, `/api/groups/${encodeURIComponent(fixture.chatId)}`);
        assert.equal(res.status, 200);
        const payload = await res.json();

        assert.equal(payload.messageCount, 2);
        assert.ok(Array.isArray(payload.messages));
        assert.ok(payload.messages.length > 0);
        assert.equal(payload.messages[0].from, undefined);
        assert.equal(payload.messages[0].body, undefined);
        assert.ok(payload.messages[0].senderRef);
        assert.ok(payload.messages[0].snippet);
        assert.match(payload.messages[0].senderRef, /^sender_/);

        assert.ok(Array.isArray(payload.unresolvedSenders));
        assert.equal(payload.unresolvedSenders[0].id, undefined);
        assert.ok(payload.unresolvedSenders[0].senderRef);
        assert.equal(payload.unresolvedSenders[0].sample, undefined);
        assert.ok(payload.unresolvedSenders[0].sampleSnippet);

        assert.ok(Array.isArray(payload.roster));
        assert.equal(payload.roster[0].id, undefined);
        assert.equal(payload.roster[0].phones, undefined);
        assert.ok(payload.roster[0].memberRef);

        const serialized = JSON.stringify(payload);
        for (const forbidden of [
            fixture.chatId,
            fixture.senderId,
            fixture.lidId,
            'raw-contact-group-alpha',
            'raw-group-contact',
            'raw-message-1',
            'raw-message-2',
            fixture.bodyEmail,
            fixture.privatePhone,
            'Full private body',
            'Unresolved lid private sample body',
            'raw-pinned-id',
            'private pinned raw body',
            'private pinned raw text',
            'private group description sentinel',
            'private raw chat description sentinel',
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
node --test tests/integration/group-detail-privacy.test.js
```

Expected: FAIL. Current `handleGetGroupDetail()` returns `messages[].from`, `messages[].body`, `unresolvedSenders[].id`, raw roster ids/phones, raw pinned messages, owner, and description.

**Step 3: Commit failing test?**

Do not commit while red. Move to Task 2.

---

### Task 2: Add pure group-detail privacy helpers

**Objective:** Create tiny deterministic helpers that can sanitize sender refs, contact refs, text snippets, roster rows, and message rows before the route serializes JSON.

**Files:**
- Modify: `crm/server.js` near `handleGetGroupDetail()` helpers
- Test: `tests/integration/group-detail-privacy.test.js`

**Step 1: Write minimal helper code**

Add these helpers above `handleGetGroupDetail()` in `crm/server.js`:

```js
function opaqueGroupDetailRef(prefix, value, index = 0) {
    const crypto = require('node:crypto');
    const input = value == null ? `${prefix}:${index}` : `${prefix}:${String(value)}:${index}`;
    return `${prefix}_${crypto.createHash('sha256').update(input).digest('hex').slice(0, 12)}`;
}

function redactGroupDetailText(value, maxLen = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
        .slice(0, maxLen);
}

function safeGroupSenderEnvelope(rawFrom, resolved, index = 0) {
    return {
        senderRef: opaqueGroupDetailRef('sender', rawFrom || resolved?.name || 'unknown', index),
        fromName: resolved?.name || null,
        fromKind: resolved?.kind || 'unknown',
        ...(resolved?.contactId ? { fromContactRef: opaqueGroupDetailRef('contact', resolved.contactId, index) } : {}),
    };
}

function safeGroupMessageEnvelope(message, resolved, index = 0) {
    return {
        timestamp: message.timestamp || null,
        ...safeGroupSenderEnvelope(message.from, resolved, index),
        snippet: redactGroupDetailText(message.body || message.text || ''),
    };
}

function safeGroupRosterMember(member, index = 0) {
    return {
        memberRef: opaqueGroupDetailRef('member', member.id || member.name || 'unknown', index),
        name: member.name || '(unknown)',
        position: member.position || null,
        company: member.company || null,
        relationshipScore: member.relationshipScore || 0,
    };
}
```

Keep these helpers local to `server.js` for now; YAGNI on a new module unless another endpoint needs them.

**Step 2: Run targeted test**

Run:

```bash
node --test tests/integration/group-detail-privacy.test.js
```

Expected: still FAIL until the route uses the helpers.

---

### Task 3: Apply the privacy envelope in `handleGetGroupDetail()`

**Objective:** Replace raw fields in the route response with safe fields while preserving UI-useful group context.

**Files:**
- Modify: `crm/server.js:1655-1722`
- Test: `tests/integration/group-detail-privacy.test.js`

**Step 1: Sanitize roster rows**

Replace the current roster row shape:

```js
return {
    id: c.id,
    name: c.name || formatPhoneFallback(c) || '(unknown)',
    phones: c.phones || [],
    position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
    company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
    relationshipScore: c.relationshipScore || 0,
};
```

with:

```js
const roster = (membership?.members || []).map((cid, index) => {
    const c = byContactId.get(cid);
    if (!c) return null;
    return safeGroupRosterMember({
        id: c.id,
        name: c.name || '(unknown)',
        position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
        company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        relationshipScore: c.relationshipScore || 0,
    }, index);
}).filter(Boolean);
```

**Step 2: Sanitize unresolved sender stats**

Change `senderStats` construction from raw ids/samples:

```js
if (!senderStats[m.from]) senderStats[m.from] = { id: m.from, count: 0, sample: '', kind: null };
...
if (!senderStats[m.from].sample && m.body) senderStats[m.from].sample = m.body.slice(0, 80);
```

to retain raw ids only internally:

```js
if (!senderStats[m.from]) senderStats[m.from] = { rawFrom: m.from, count: 0, sampleSnippet: '', kind: null };
...
if (!senderStats[m.from].sampleSnippet && m.body) senderStats[m.from].sampleSnippet = redactGroupDetailText(m.body, 80);
```

Then, after resolving kind/name, before returning `unresolvedSenders`, map each row to a safe envelope:

```js
const unresolvedSenders = Object.values(senderStats)
    .filter(s => s.kind === 'anon-lid' || (s.kind === 'phone' && s.rawFrom && s.rawFrom.endsWith('@lid')))
    .sort((a, b) => b.count - a.count)
    .map((s, index) => ({
        senderRef: opaqueGroupDetailRef('sender', s.rawFrom, index),
        count: s.count,
        sampleSnippet: s.sampleSnippet,
        kind: s.kind,
        name: s.name || 'Group member',
    }));
```

Update `seenContactIds` logic to use `s.rawFrom` instead of `s.id` if needed.

**Step 3: Sanitize normal messages**

Replace:

```js
messages: sorted.slice(0, 50).map(m => {
    const r = resolveFrom(m.from);
    return {
        timestamp: m.timestamp,
        from: m.from,
        fromName: r.name,
        fromContactId: r.contactId,
        fromKind: r.kind,
        body: m.body || '',
    };
}),
```

with:

```js
messages: sorted.slice(0, 50).map((m, index) => {
    const r = resolveFrom(m.from);
    return safeGroupMessageEnvelope(m, r, index);
}),
```

**Step 4: Sanitize pinned messages and group metadata**

Replace:

```js
pinnedMessages: pinnedMessages.map(m => {
    const r = resolveFrom(m.from || m.author);
    return { ...m, fromName: r.name, fromContactId: r.contactId, fromKind: r.kind };
}),
...
owner: membership?.owner || rawChatEntry?.meta?.owner || null,
description: membership?.description || rawChatEntry?.meta?.description || null,
```

with:

```js
pinnedMessages: pinnedMessages.map((m, index) => {
    const rawFrom = m.from || m.author;
    const r = resolveFrom(rawFrom);
    return {
        ...safeGroupSenderEnvelope(rawFrom, r, index),
        snippet: redactGroupDetailText(m.body || m.text || ''),
    };
}),
...
// Intentionally omit owner and description from this privacy-safe endpoint.
```

Do not include the `owner` and `description` properties in the JSON response for this fix.

**Step 5: Run targeted test to verify pass**

Run:

```bash
node --test tests/integration/group-detail-privacy.test.js
```

Expected: PASS.

---

### Task 4: Update the UI to consume safe field names

**Objective:** Keep the group detail page usable after `messages[].body/from/fromContactId`, `unresolvedSenders[].id/sample`, and `roster[].id/phones` are removed.

**Files:**
- Modify: `crm/ui.html.js` around group-detail rendering (`fetch(BASE + '/api/groups')`, `loadGroupDetail`, unresolved sender UI, roster UI)
- Test: `tests/unit/ui-js-syntax.test.js`
- Optional smoke: `npm run test:e2e` if group pages are covered or easy to smoke

**Step 1: Locate current field consumers**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
text = Path('crm/ui.html.js').read_text()
for needle in ['fromContactId', '.body', 'unresolvedSenders', 'suggestedContacts', 'roster']:
    print('\n---', needle)
    for i, line in enumerate(text.splitlines(), 1):
        if needle in line:
            print(f'{i}: {line[:160]}')
PY
```

Expected: output shows the exact UI lines to patch.

**Step 2: Patch message rendering**

Where group messages render `m.body`, switch to `m.snippet || ''`.

Where sender identity compares or links via `fromContactId`, switch to the opaque `fromContactRef` only for display/debug labels. Do not attempt to post `fromContactRef` to `/api/whatsapp/lid-map`; that endpoint still needs raw ids and should not be driven from the redacted detail payload.

**Step 3: Patch unresolved sender display**

Display `s.sampleSnippet` instead of `s.sample` and `s.senderRef` instead of `s.id`.

If the UI currently needs raw `@lid` values to save a mapping, disable that action from the redacted detail response and show copy like:

```js
const canAssign = false;
const helper = 'Sender labels are privacy-redacted in this view. Use the dedicated source-quality workbench for safe identity review.';
```

Do not reintroduce raw ids just to preserve the old assignment affordance. If keeping assignment is important, add a separate later plan for an approval-gated identity workbench endpoint.

**Step 4: Patch roster display**

Use `memberRef` as the stable client key and remove phone rendering. Keep display name, position/company, and score.

**Step 5: Run syntax test**

Run:

```bash
node --test tests/unit/ui-js-syntax.test.js
```

Expected: PASS.

---

### Task 5: Add a compatibility assertion for useful group context

**Objective:** Prevent the privacy fix from making group detail useless by pinning the safe replacement fields.

**Files:**
- Modify: `tests/integration/group-detail-privacy.test.js`

**Step 1: Extend the test with positive assertions**

Add these assertions after parsing the payload:

```js
assert.equal(payload.category, 'other');
assert.equal(payload.rosterCount, 1);
assert.equal(payload.createdAt, '2026-05-01T00:00:00Z');
assert.equal(payload.roster[0].name, 'Synthetic Group Member');
assert.equal(payload.messages[0].fromName, 'Group member');
assert.ok(['named', 'anon-lid', 'phone', 'unknown'].includes(payload.messages[0].fromKind));
assert.ok(payload.pinnedMessages[0].senderRef);
assert.ok(payload.pinnedMessages[0].snippet);
assert.equal(payload.safety.readOnly, true);
assert.equal(payload.safety.rawMessageBodiesOmitted, true);
assert.equal(payload.safety.rawSourceIdsOmitted, true);
```

**Step 2: Add a safety marker to the route**

In the `json(res, { ... })` payload, add:

```js
safety: {
    readOnly: true,
    rawMessageBodiesOmitted: true,
    rawSourceIdsOmitted: true,
    contactDetailsOmitted: true,
},
```

**Step 3: Run targeted integration test**

Run:

```bash
node --test tests/integration/group-detail-privacy.test.js
```

Expected: PASS.

---

### Task 6: Run final verification and commit

**Objective:** Verify the narrow privacy fix and commit it as one coherent PR-ready change.

**Files:**
- `crm/server.js`
- `crm/ui.html.js`
- `tests/integration/group-detail-privacy.test.js`

**Step 1: Run targeted tests**

Run:

```bash
node --test tests/integration/group-detail-privacy.test.js
node --test tests/unit/ui-js-syntax.test.js
```

Expected: PASS.

**Step 2: Run full unit/integration suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 3: Run e2e if UI changed materially**

Run:

```bash
npm run test:e2e
```

Expected: PASS. If Playwright browser setup is missing, run `npx playwright install chromium` once and rerun.

**Step 4: Check for whitespace and unintended leaks**

Run:

```bash
git diff --check
python3 - <<'PY'
from pathlib import Path
changed = ''.join(Path(p).read_text(errors='ignore') for p in [
    'tests/integration/group-detail-privacy.test.js',
])
forbidden = [
    'private.group' + '@example.test',
    '+44 ' + '7700 ' + '900123',
]
for forbidden in forbidden:
    assert forbidden not in changed, f'plan/test contains whole private sentinel: {forbidden}'
print('sentinel literals split safely')
PY
```

Expected: no whitespace errors; sentinel literal check prints `sentinel literals split safely`.

**Step 5: Commit**

Run:

```bash
git add crm/server.js crm/ui.html.js tests/integration/group-detail-privacy.test.js
git commit -m "fix: redact group detail privacy envelope"
```

Expected: commit succeeds.

## Builder handoff note

This is a good next builder task because it is small, testable, and directly closes the remaining trust gap identified in issue #248. The uncomfortable truth: Minty cannot credibly advertise privacy-safe agent memory while a nearby local API returns raw group sender ids and message bodies. Fixing this keeps UI/debug tooling aligned with the same trust contract already enforced for MCP and source-health surfaces.
