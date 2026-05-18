# Group Detail Strict Privacy Envelope Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Finish the group-detail privacy contract so `/api/groups` and `GET /api/groups/:chatId` remain useful trust/debug surfaces without exposing raw group ids, sender ids, contact ids, phones, message bodies, URLs, group descriptions, or owner payloads.

**Architecture:** Keep the existing group list/detail routes and Sources/Groups UI, but add small server-side projection helpers near `handleGetGroupDetail()` in `crm/server.js`. The helpers should convert group rows, messages, pinned messages, roster entries, unresolved senders, and signal rows into a strict envelope with opaque refs, safe labels/counts, timestamps, and generic snippets only. Update the UI to consume the new safe fields and remove click paths that require raw contact ids in this slice.

**Tech Stack:** Plain Node.js CommonJS, existing `createServer()` integration-test pattern, `crm/server.js`, inline SPA in `crm/ui.html.js`, Node built-in test runner. No dependencies, no provider calls, no sync/import mutations, no runtime LLM calls.

---

## Product context

Minty has shipped strong MCP/CLI trust surfaces: `source_health`, answerability gates, citations/freshness, source attribution, GBrain export hardening, local source importers, the source-quality workbench, redacted API errors, and safe timeline metadata. The remaining weak boundary is the local browser/API group detail surface. It is a high-leverage trust/debug view because group context powers intro paths and community signals, but the current endpoint still serializes identifiers that agents and browser views should not need.

This is not CRM busywork. It keeps group/community evidence useful while preserving the same privacy posture Minty promises to Hermes/OpenClaw: enough source-backed context to trust recommendations, never raw conversations or provider identifiers by default.

## Current-state evidence

A synthetic smoke on current `main` returns `200` for `GET /api/groups/:chatId`, with these still present in serialized output: raw `@g.us` chat id, raw `@c.us` owner/sender id, raw contact id from roster/suggested contacts, and raw group description. Current `messages[]` already uses `snippet` rather than `body`, but `messages[].fromContactId`, `roster[].id`, `roster[].phones`, `suggestedContacts[].id`, top-level `chatId`, `owner`, `description`, and `signals.urls[].url` remain unsafe.

Recent partial work exists in the codebase:

- `crm/server.js:1411-1414` has `safeGroupMessageSnippet()` returning the generic text `Message content omitted for privacy`.
- `crm/server.js:1656-1762` handles `GET /api/groups/:chatId` and currently builds messages, unresolved senders, suggested contacts, pinned messages, roster, owner, description, and signals directly in the route.
- `tests/integration/api-data-resilience.test.js:242-286` has a first regression proving raw message bodies and raw sender source ids are redacted.
- `crm/ui.html.js:3743-3843` renders group messages, pinned messages, anonymous sender rows, and roster chips using fields that should be replaced or removed in the strict envelope.
- An older off-branch plan named `2026-05-16-group-detail-privacy-envelope.md` captured the original broader issue. This plan supersedes it by focusing only on the remaining gaps on current `main`.

## Acceptance criteria

- `GET /api/groups/:chatId` never serializes:
  - raw group ids such as `@g.us`;
  - raw sender ids such as `@c.us` / `@lid`;
  - raw contact ids;
  - phones, emails, source handles, profile URLs, links, message ids, group owner ids, group descriptions, message bodies, or pinned raw payload fields.
- `GET /api/groups` no longer serializes raw `chatId`, `owner`, labels, raw URL snippets, or raw last-message text. It may return opaque `groupRef`, safe display name, category, counts, timestamps, and generic `lastSnippet`.
- Detail message rows expose only: `timestamp`, `senderRef`, `fromName`, `fromKind`, optional opaque `fromContactRef`, and `snippet` with generic content such as `Message content omitted for privacy`.
- Pinned message rows use the same safe projection as regular messages.
- Roster rows expose only: `memberRef`, `name`, `position`, `company`, and `relationshipScore`. No `id`, no `phones`, no direct contact URL/openContact target.
- Suggested contacts and unresolved sender rows expose opaque refs plus counts/generic sample snippets only. If preserving assignment UX requires raw ids, defer assignment UX rather than leaking them in this slice.
- Group signals are coarsened: link rows return `detail: 'Link shared in group conversation'` and `timestamp`, not raw URL; hiring/event/intro rows return generic labels and timestamps, not body-derived snippets.
- UI remains usable: group detail can show safe names, counts, generic snippets, timestamps, and non-clickable roster chips. Raw-id clickthrough can be restored later with a separate explicit ref-resolution design.

## Non-goals

- No authentication/session model changes.
- No raw debug query flag.
- No LLM summary, OCR, attachment/link preview, or message reconstruction.
- No WhatsApp reconnect/import/sync mutation and no `lid-map` write path changes in this slice.
- No new MCP tool.
- No contact-detail navigation from group detail unless it can be done without exposing raw contact ids in the API response.

---

### Task 1: Tighten the existing group-detail privacy regression

**Objective:** Expand the current integration test so it proves the remaining group-detail leaks before code changes.

**Files:**
- Modify: `tests/integration/api-data-resilience.test.js`
- Read: `crm/server.js:1656-1762`

**Step 1: Write failing test additions**

In the existing `GET /api/groups/:chatId redacts message bodies and raw sender source IDs` test, keep the current fixture and extend it so the group has roster/owner/description/pinned/signal data. Replace the body of the test with this shape, preserving nearby helper functions already in the file:

```js
const rawContactId = 'raw-group-member-alpha';
const rawSender = 'raw-sender-5550101' + '@' + 'c.us';
const rawLid = 'raw-lid-5550102' + '@' + 'lid';
const rawEmail = 'group-detail-private' + '@' + 'example.test';
const rawPhone = '+1 415 555 0199';
const rawBody = `please email ${rawEmail} or call ${rawPhone} https://private.example/path`;
const groupId = 'synthetic-group-privacy' + '@' + 'g.us';

writeJson(path.join(dir, 'unified/contacts.json'), [
    {
        id: rawContactId,
        name: 'Synthetic Group Member',
        phones: [rawPhone],
        emails: [rawEmail],
        sources: { whatsapp: { id: rawSender } },
        relationshipScore: 42,
    },
]);
writeJson(path.join(dir, 'unified/interactions.json'), [
    { id: 'group-msg-1', source: 'whatsapp', chatId: groupId, chatName: 'Synthetic privacy group', from: rawSender, body: rawBody, timestamp: '2026-05-16T12:00:00.000Z' },
    { id: 'group-msg-2', source: 'whatsapp', chatId: groupId, chatName: 'Synthetic privacy group', from: rawLid, body: 'anonymous lid body with group-detail-lid-secret', timestamp: '2026-05-16T12:01:00.000Z' },
]);
writeJson(path.join(dir, 'unified/group-memberships.json'), {
    [groupId]: {
        name: 'Synthetic privacy group',
        size: 1,
        members: [rawContactId],
        owner: rawSender,
        description: 'private group description sentinel',
        createdAt: '2026-01-01T00:00:00.000Z',
    },
});
writeJson(path.join(dir, 'whatsapp/chats.json'), {
    SyntheticPrivacyGroup: {
        meta: {
            id: groupId,
            name: 'Synthetic privacy group',
            owner: rawSender,
            description: 'raw private description sentinel',
            pinnedMessages: [
                { id: 'raw-pinned-id', from: rawSender, author: rawLid, body: 'pinned private sentinel body', text: 'pinned private sentinel text', timestamp: '2026-05-16T12:02:00.000Z' },
            ],
        },
    },
});
```

Then assert the strict envelope:

```js
assert.match(payload.groupRef, /^group:/);
assert.equal(payload.chatId, undefined);
assert.equal(payload.owner, undefined);
assert.equal(payload.description, undefined);
assert.equal(payload.messages[0].fromContactId, undefined);
assert.match(payload.messages[0].fromContactRef || '', /^contact:/);
assert.match(payload.messages[0].senderRef, /^sender:/);
assert.equal(payload.messages[0].body, undefined);
assert.equal(payload.messages[0].snippet, 'Message content omitted for privacy');
assert.equal(payload.roster[0].id, undefined);
assert.equal(payload.roster[0].phones, undefined);
assert.match(payload.roster[0].memberRef, /^contact:/);
assert.equal(payload.pinnedMessages[0].body, undefined);
assert.equal(payload.pinnedMessages[0].text, undefined);
assert.equal(payload.pinnedMessages[0].snippet, 'Message content omitted for privacy');
assert.equal(payload.signals.urls[0].url, undefined);
assert.equal(payload.signals.urls[0].detail, 'Link shared in group conversation');

const serialized = JSON.stringify(payload);
for (const forbidden of [
    groupId,
    '@g.us',
    '@c.us',
    '@lid',
    rawContactId,
    'group-msg-1',
    'group-msg-2',
    'raw-pinned-id',
    rawSender.replace('@c.us', ''),
    rawEmail,
    rawPhone,
    'private.example/path',
    'please email',
    'group-detail-lid-secret',
    'pinned private sentinel body',
    'pinned private sentinel text',
    'private group description sentinel',
    'raw private description sentinel',
]) {
    assert.equal(serialized.includes(forbidden), false, `group detail leaked ${forbidden}`);
}
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js --test-name-pattern='GET /api/groups/:chatId'
```

Expected: FAIL because current output still includes `chatId`, `owner`, `description`, `fromContactId`, roster `id`, roster `phones`, and raw link URLs.

**Step 3: Do not commit while red**

Move directly to Task 2.

---

### Task 2: Add server-side strict group envelope helpers

**Objective:** Centralize group-list/detail redaction so future fields cannot bypass the privacy contract accidentally.

**Files:**
- Modify: `crm/server.js`
- Test: same integration test from Task 1

**Step 1: Implement helpers near `safeGroupMessageSnippet()`**

Add these helpers near `crm/server.js:1411`:

```js
function opaqueGroupRef(value) {
    if (!value) return null;
    const ref = shortOpaqueRef(value);
    return ref ? `group:${ref}` : null;
}

function opaqueSenderRef(value) {
    if (!value) return null;
    const ref = shortOpaqueRef(value);
    return ref ? `sender:${ref}` : null;
}

function opaqueContactRef(value) {
    if (!value) return null;
    const ref = shortOpaqueRef(value);
    return ref ? `contact:${ref}` : null;
}

function safeGroupDisplayName(resolved) {
    if (!resolved || resolved.kind === 'phone' || resolved.kind === 'raw') return 'Group member';
    return resolved.name || 'Group member';
}

function safeGroupSignalRows(signals) {
    const generic = detail => item => ({ timestamp: item.timestamp || null, detail });
    return {
        urls: (signals.urls || []).map(generic('Link shared in group conversation')),
        hiring: (signals.hiring || []).map(generic('Hiring signal detected')),
        events: (signals.events || []).map(generic('Event signal detected')),
        intros: (signals.intros || []).map(generic('Introduction signal detected')),
    };
}

function safeGroupRosterRow(contact) {
    if (!contact) return null;
    return {
        memberRef: opaqueContactRef(contact.id),
        name: contact.name || 'Group member',
        position: contact.sources?.linkedin?.position || contact.sources?.googleContacts?.title || null,
        company: contact.sources?.linkedin?.company || contact.sources?.googleContacts?.org || null,
        relationshipScore: contact.relationshipScore || 0,
    };
}

function safeGroupMessageRow(message, resolveFrom) {
    const resolved = resolveFrom(message.from || message.author);
    return {
        timestamp: message.timestamp || null,
        senderRef: opaqueSenderRef(message.from || message.author || message.id),
        fromName: safeGroupDisplayName(resolved),
        fromKind: resolved.kind,
        fromContactRef: opaqueContactRef(resolved.contactId),
        snippet: safeGroupMessageSnippet(message.body || message.text || message.message),
    };
}
```

Use an HMAC-backed opaque ref helper rather than a plain hash so provider IDs are not trivially guessable across installations. Reuse `MINTY_REF_SECRET || MINTY_MCP_REF_SECRET` when present, and fail closed for strict agent/API envelopes if no secret is configured rather than falling back to reversible/raw identifiers:

```js
function shortOpaqueRef(value) {
    const secret = process.env.MINTY_REF_SECRET || process.env.MINTY_MCP_REF_SECRET;
    if (!secret || !value) return null;
    return crypto.createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 12);
}
```

If the browser-only route needs a demo/dev fallback, gate it explicitly to `MINTY_DEMO` and add tests proving production/test strict mode returns omitted refs instead of raw ids when the secret is missing.

**Step 2: Replace unsafe fields in `handleGetGroupDetail()`**

Change the route to:

- compute `signals` as `safeGroupSignalRows(extractGroupSignals(sorted))`;
- build `roster` with `safeGroupRosterRow(c)`;
- build `candidateRoster` from safe roster rows only, or return `[]` if the old assignment UX needs raw ids;
- return `groupRef: opaqueGroupRef(chatId)` instead of `chatId`;
- omit `owner` and `description` entirely;
- project `messages` and `pinnedMessages` with `safeGroupMessageRow()`;
- ensure `unresolvedSenders` rows do not include `rawId`, `id`, `sample`, raw body, or contact ids.

The final response shape should look like:

```js
json(res, {
    groupRef: opaqueGroupRef(chatId),
    name,
    category,
    messageCount: msgs.length,
    lastMessageAt: sorted[0]?.timestamp || null,
    messages: sorted.slice(0, 50).map(m => safeGroupMessageRow(m, resolveFrom)),
    unresolvedSenders,
    suggestedContacts: candidateRoster,
    pinnedMessages: pinnedMessages.map(m => safeGroupMessageRow({
        timestamp: m.timestamp,
        from: m.from || m.author,
        body: m.body || m.text || m.message || '',
        id: m.id,
    }, resolveFrom)),
    rosterCount: membership?.size || 0,
    roster,
    createdAt: membership?.createdAt || rawChatEntry?.meta?.createdAt || null,
    signals,
});
```

**Step 3: Run test to verify pass**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js --test-name-pattern='GET /api/groups/:chatId'
```

Expected: PASS.

**Step 4: Commit**

```bash
git add crm/server.js tests/integration/api-data-resilience.test.js
git commit -m "fix: enforce strict group detail privacy envelope"
```

---

### Task 3: Apply the same envelope to the group list route

**Objective:** Prevent `/api/groups` from leaking raw group ids, owners, raw last-message text, or labels while still listing useful group rows.

**Files:**
- Modify: `crm/server.js`
- Test: `tests/integration/api-data-resilience.test.js`

**Step 1: Add list assertions to the same integration test**

After fetching detail, also fetch `/api/groups`:

```js
const listRes = await fetch(`${base}/api/groups`);
assert.equal(listRes.status, 200);
const listPayload = await listRes.json();
assert.equal(listPayload.groups.length, 1);
const group = listPayload.groups[0];
assert.match(group.groupRef, /^group:/);
assert.equal(group.chatId, undefined);
assert.equal(group.owner, undefined);
assert.equal(group.lastSnippet, 'Message content omitted for privacy');
const listText = JSON.stringify(listPayload);
for (const forbidden of [groupId, '@g.us', rawSender, rawEmail, rawPhone, 'private.example/path', 'please email']) {
    assert.equal(listText.includes(forbidden), false, `group list leaked ${forbidden}`);
}
```

Expected before implementation: FAIL because `/api/groups` still includes raw `chatId`, raw owner, and raw `lastSnippet` text.

**Step 2: Update `handleGetGroups()`**

In `crm/server.js:1430-1480`, build safe rows:

- store internal map by raw `chatId` only inside the function;
- response rows should use `groupRef: opaqueGroupRef(chatId)` and omit `chatId`;
- remove `owner` from the response;
- set `lastSnippet` to `safeGroupMessageSnippet(sorted[0]?.body)`;
- keep `name`, `messageCount`, `lastMessageAt`, `rosterCount`, `posterCount`, `participantCount`, `category`, and `createdAt`.

Do not include `labels` unless labels are allowlisted and proven non-private. For this slice, omit labels.

**Step 3: Run focused test**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js --test-name-pattern='GET /api/groups'
```

Expected: PASS.

**Step 4: Commit**

```bash
git add crm/server.js tests/integration/api-data-resilience.test.js
git commit -m "fix: redact group list identifiers"
```

---

### Task 4: Update the group detail UI for safe fields

**Objective:** Keep the Groups view useful after raw ids and clickthrough fields are removed.

**Files:**
- Modify: `crm/ui.html.js:3743-3843`
- Test: `tests/integration/api-data-resilience.test.js` and e2e smoke if available

**Step 1: Patch message and pinned rendering**

In `loadGroupDetail(chatId)`, change any fallback from `m.body` to generic `m.snippet` only:

```js
const safeSnippet = m.snippet || 'Message content omitted for privacy';
const clickable = `<span class="group-msg-from">${esc(display)}</span>`;
```

For pinned messages, use the same fallback:

```js
const safeSnippet = m.snippet || 'Message content omitted for privacy';
```

**Step 2: Patch signal rendering**

Support `detail` without URL:

```js
${sig.urls.map(u => `<div class="signal-item">
  ${esc(u.detail || 'Link shared in group conversation')}
  <span class="signal-date">${fmtDate(u.timestamp)}</span>
</div>`).join('')}
```

For hiring/event/intro rows use `item.detail || 'Signal detected in group conversation'`.

**Step 3: Patch unresolved sender and roster rendering**

Change unresolved sender display from `s.sample` to `s.sampleSnippet || 'content omitted'`.

Change roster chips to non-clickable chips and use `memberRef` only as a non-rendered stable key if needed:

```js
${namedMembers.slice(0, 60).map(r => `<span class="group-roster-chip">${esc(r.name)}${r.company ? ' · ' + esc(r.company) : ''}</span>`).join('')}
```

Remove `openContact(r.id)` from this view until a safe ref-resolution route exists.

**Step 4: Run checks**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js --test-name-pattern='GET /api/groups'
npm run test:e2e
```

Expected: focused integration test passes; e2e passes with no browser console errors in the existing smokes.

**Step 5: Commit**

```bash
git add crm/ui.html.js tests/integration/api-data-resilience.test.js
git commit -m "fix: render group detail from safe envelope"
```

---

### Task 5: Final privacy sweep and full verification

**Objective:** Verify the strict envelope cannot regress through obvious raw-field additions.

**Files:**
- Read: `crm/server.js`, `crm/ui.html.js`, `tests/integration/api-data-resilience.test.js`

**Step 1: Run focused and full tests**

```bash
node --test tests/integration/api-data-resilience.test.js --test-name-pattern='GET /api/groups'
npm test
npm run test:e2e
```

Expected: all pass.

**Step 2: Static leakage scan on the diff**

Run:

```bash
git diff --check HEAD~4..HEAD
git diff HEAD~4..HEAD -- crm/server.js crm/ui.html.js tests/integration/api-data-resilience.test.js | grep -E "fromContactId|chatId,|owner:|description:|phones:|\.body|\.url|openContact\(.*\.id" || true
```

Expected: no unsafe response/UI usage remains. If grep prints only test forbidden-list strings or internal raw fixture setup, inspect and confirm the production code does not serialize those fields.

**Step 3: Final commit if needed**

If any small cleanup is required:

```bash
git add crm/server.js crm/ui.html.js tests/integration/api-data-resilience.test.js
git commit -m "test: lock group detail privacy contract"
```

## Builder handoff notes

- Prefer a strict empty/generic envelope over preserving raw-id powered convenience. Losing contact clickthrough in group detail is acceptable in this slice.
- If a helper needs to hash ids, use deterministic opaque refs only; do not make them reversible and do not include provider prefixes.
- Keep the raw source data local on disk unchanged. The fix is only about API/UI projection.
- Do not add a `raw=true` flag. That needs a separate explicit opt-in design with a visible privacy warning.
