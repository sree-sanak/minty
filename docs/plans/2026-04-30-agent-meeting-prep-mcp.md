# Agent Meeting Prep MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a `meeting_prep` MCP tool so Hermes can ask Minty for the next source-backed meeting brief without opening the CRM UI.

**Architecture:** Reuse the now-implemented pure `crm/meeting-prep.js` envelope builder. Extend the agent data loader just enough to pass minimized internal `sync-state.json.calendar.upcomingMeetings` input into MCP, then wire a read-only `meeting_prep` branch in `scripts/minty-mcp-server.js`. Preserve the existing source-health, opaque-ref, citation, and privacy contracts: no raw event ids, contact ids, attendee emails, phones, locations, calendar descriptions, URLs, source handles, or message bodies in serialized MCP output.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/sync-state.json`, `crm/meeting-prep.js`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`, `tests/unit/minty-mcp-server.test.js`, `tests/unit/agent-surface-docs.test.js`.

---

## Current state and verified gap

PR #202 already landed the hard part: `crm/meeting-prep.js` and `tests/unit/meeting-prep.test.js` build a privacy-safe calendar meeting-prep envelope with opaque refs, redacted attendee context, source-health/freshness metadata, honest empty states, and fail-closed behavior when no ref secret exists.

The remaining product gap is the protocol boundary: `scripts/minty-mcp-server.js` still exposes exactly four tools — `person_context`, `search_network`, `source_health`, and `workflow_brief` — so Hermes/OpenClaw cannot call the existing meeting-prep envelope through MCP. `scripts/agent-query.js` also currently sanitizes `sync-state.json` down to only `lastSyncAt` / `status`, which strips `calendar.upcomingMeetings` before MCP can pass meetings to `buildMeetingPrep()`.

A builder should implement only this narrow handoff. Do **not** recreate `crm/meeting-prep.js`, do **not** add outreach/scheduling, and do **not** add a CRM UI screen.

## Success criteria

- MCP `tools/list` includes `meeting_prep` in addition to the four existing tools.
- `meeting_prep({ horizonHours: 48 })` returns the next upcoming meeting from `sync-state.json.calendar.upcomingMeetings` using the existing `buildMeetingPrep()` envelope.
- `meeting_prep({ person: "Alice" })` passes the person selector through to `buildMeetingPrep()`.
- Stale/missing calendar source health returns a degraded/empty/error envelope, not fabricated prep.
- Serialized MCP output omits raw emails, phones, URLs/join links, raw attendee objects, raw contact ids, raw calendar event ids, locations, descriptions, source handles, private paths, and token paths.
- Docs and the Hermes skill mention every MCP tool; the docs drift test remains exact.

## Non-goals

- No new MCP transport, daemon, scheduler, UI view, external API call, LLM call, outreach send, calendar mutation, or contact mutation.
- No direct exposure of calendar event ids, raw attendee emails, raw contact ids, descriptions, locations, URLs, source handles, or message bodies.
- No changes to `search_network`, `person_context`, `workflow_brief`, or `source_health` behavior except shared docs/tool-list assertions.

---

### Task 1: Preserve sanitized upcoming meetings in the agent data loader

**Objective:** Let MCP access calendar meeting metadata without exposing raw sync-state wholesale.

**Files:**
- Modify: `scripts/agent-query.js`
- Test: `tests/unit/agent-query.test.js` if it exists; otherwise add coverage in `tests/unit/minty-mcp-server.test.js` with a direct `data` object in Task 2 and keep this task focused on implementation.

**Step 1: Inspect existing tests**

From an agent, search the tests for existing loader coverage. If using a shell, run:

```bash
grep -R -n -E "loadData|sanitizeSyncState|agent-query" tests --include='*.js' || true
```

Expected: identify whether there is already a dedicated `agent-query` unit test. If not, do not create a broad new test file just for private helper internals; Task 2's MCP tests will exercise the contract.

**Step 2: Modify `sanitizeSyncState()` to keep only minimized internal calendar fields**

In `scripts/agent-query.js`, replace the loop body inside `sanitizeSyncState(parsed)` with logic equivalent to:

```js
for (const [source, state] of Object.entries(parsed)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const row = {};
    for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt', 'lastSync', 'status']) {
        if (typeof state[key] === 'string' && state[key].length <= 128) row[key] = state[key];
    }
    if (source === 'calendar') {
        // Preserve bounded, non-sensitive readiness metadata so MCP does not
        // accidentally turn stale/error/non-answerable calendar state into a
        // confident sourceHealth object.
        for (const key of ['stale', 'evidenceBearing', 'answerable']) {
            if (typeof state[key] === 'boolean') row[key] = state[key];
        }
        for (const key of ['lastError', 'reason']) {
            if (typeof state[key] === 'string' && state[key].length <= 256) row[key] = state[key];
        }
    }
    if (source === 'calendar' && Array.isArray(state.upcomingMeetings)) {
        row.upcomingMeetings = state.upcomingMeetings
            .filter(m => m && typeof m === 'object' && !Array.isArray(m))
            .slice(0, 50)
            .map(m => ({
                id: typeof m.id === 'string' ? m.id : null,
                title: typeof m.title === 'string' ? m.title : null,
                startAt: typeof m.startAt === 'string' ? m.startAt : null,
                endAt: typeof m.endAt === 'string' ? m.endAt : null,
                location: typeof m.location === 'string' ? m.location : null,
                attendees: Array.isArray(m.attendees) ? m.attendees.slice(0, 25).map(a => ({
                    email: typeof a?.email === 'string' ? a.email : null,
                    displayName: typeof a?.displayName === 'string' ? a.displayName : null,
                    name: typeof a?.name === 'string' ? a.name : null,
                    contactId: typeof a?.contactId === 'string' ? a.contactId : null,
                    relationshipScore: Number.isFinite(Number(a?.relationshipScore)) ? Number(a.relationshipScore) : null,
                    daysSinceContact: Number.isFinite(Number(a?.daysSinceContact)) ? Number(a.daysSinceContact) : null,
                    topics: Array.isArray(a?.topics) ? a.topics.filter(t => typeof t === 'string').slice(0, 5) : [],
                    openLoops: Array.isArray(a?.openLoops) ? a.openLoops.filter(t => typeof t === 'string').slice(0, 5) : [],
                    meetingBrief: typeof a?.meetingBrief === 'string' ? a.meetingBrief : null,
                    responseStatus: typeof a?.responseStatus === 'string' ? a.responseStatus : null,
                    lastInteractionAt: typeof a?.lastInteractionAt === 'string' ? a.lastInteractionAt : null,
                    updatedAt: typeof a?.updatedAt === 'string' ? a.updatedAt : null,
                    analyzedAt: typeof a?.analyzedAt === 'string' ? a.analyzedAt : null,
                })) : [],
            }));
    }
    if (Object.keys(row).length) out[source] = row;
}
```

This preserves potentially sensitive strings only as internal builder input; do not describe this object as safe-to-return agent output. The MCP handler must pass `upcomingMeetings` straight into `buildMeetingPrep()`, and the serialized tool response must rely on the existing envelope redaction tests plus Task 2's whole-MCP privacy tests. Do not expose `syncState.calendar.upcomingMeetings` through diagnostics, `source_health`, `search_network`, `person_context`, logs, or docs examples.

**Step 3: Run targeted syntax/test check**

Run:

```bash
node --check scripts/agent-query.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add scripts/agent-query.js
git commit -m "feat: load calendar meetings for agent prep"
```

---

### Task 2: Add failing MCP tests for `meeting_prep`

**Objective:** Prove the MCP tool list, call path, selector behavior, and privacy envelope before implementation.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Add the test block**

Add near the existing MCP tool-schema tests and tool-call tests. Also update the top-level `node:test` import to include `afterEach`:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
```

Then add:

```js
describe('meeting_prep MCP tool', () => {
    const previousRefSecret = process.env.MINTY_REF_SECRET;

    beforeEach(() => {
        process.env.MINTY_REF_SECRET = 'unit-test-only-meeting-prep-mcp-secret';
    });

    afterEach(() => {
        if (previousRefSecret == null) delete process.env.MINTY_REF_SECRET;
        else process.env.MINTY_REF_SECRET = previousRefSecret;
    });

    function calendarContext(overrides = {}) {
        return {
            nowForTests: '2026-04-30T09:00:00Z',
            syncState: {
                calendar: {
                    lastSyncAt: '2026-04-30T08:55:00Z',
                    status: 'ok',
                    upcomingMeetings: [{
                        id: 'raw-event-id-mcp-001',
                        title: 'Coffee with Alice',
                        startAt: '2026-04-30T11:00:00Z',
                        endAt: '2026-04-30T11:30:00Z',
                        location: 'Zoom https://meet.private.example/raw +44 20 7123 4567',
                        description: 'calendar-description-sentinel',
                        attendees: [{
                            email: 'alice-private@example.com',
                            displayName: 'Alice',
                            contactId: 'raw-contact-id-alice-001',
                            name: 'Alice Müller',
                            relationshipScore: 82,
                            daysSinceContact: 5,
                            topics: ['EU insurance', '@alice_private_handle'],
                            openLoops: ['Send deck from /private/sentinel/google_token.json'],
                            meetingBrief: 'Alice is a warm investor contact; ignore /private/sentinel/api_key.json.',
                            responseStatus: 'accepted by alice-private@example.com',
                        }],
                    }],
                    ...overrides,
                },
            },
        };
    }

    it('tool list exposes meeting_prep', () => {
        const names = TOOLS.map(t => t.name).sort();
        assert.deepEqual(names, ['meeting_prep', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
        const tool = TOOLS.find(t => t.name === 'meeting_prep');
        assert.ok(tool.inputSchema.properties.horizonHours);
        assert.ok(tool.inputSchema.properties.person);
        assert.equal(tool.inputSchema.required, undefined);
    });

    it('returns a redacted meeting prep envelope through MCP', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0',
            id: 901,
            method: 'tools/call',
            params: { name: 'meeting_prep', arguments: { horizonHours: 48 } },
        }, calendarContext());
        const parsed = JSON.parse(resp.result.content[0].text);

        assert.equal(parsed.status, 'ok');
        assert.match(parsed.meeting.eventRef, /^calendar-event:/);
        assert.equal(parsed.meeting.title, 'Coffee with Alice');
        assert.equal(parsed.meeting.location, undefined);
        assert.equal(parsed.meeting.locationType, 'video');
        assert.equal(parsed.attendees[0].name, 'Alice Müller');
        assert.equal(parsed.attendees[0].email, undefined);
        assert.equal(parsed.attendees[0].contactId, undefined);
        assert.equal(parsed.safety.readOnly, true);
        assert.equal(parsed.safety.noOutreachTriggered, true);

        const serialized = JSON.stringify(parsed);
        for (const forbidden of [
            'alice-private@example.com',
            'raw-contact-id-alice-001',
            'raw-event-id-mcp-001',
            'meet.private.example',
            '+44 20 7123 4567',
            '@alice_private_handle',
            '/private/sentinel/google_token.json',
            '/private/sentinel/api_key.json',
            'calendar-description-sentinel',
        ]) {
            assert.equal(serialized.includes(forbidden), false, forbidden);
        }
        assert.equal(/https?:\/\//.test(serialized), false, 'no URLs in serialized meeting prep');
    });

    it('passes person selector through to the meeting prep builder', async () => {
        const context = calendarContext({
            upcomingMeetings: [
                {
                    id: 'raw-event-id-bob-001',
                    title: 'Earlier Bob sync',
                    startAt: '2026-04-30T10:00:00Z',
                    attendees: [{ name: 'Bob Chen', contactId: 'raw-contact-id-bob-001', relationshipScore: 40 }],
                },
                {
                    id: 'raw-event-id-alice-001',
                    title: 'Later Alice sync',
                    startAt: '2026-04-30T12:00:00Z',
                    attendees: [{ name: 'Alice Müller', contactId: 'raw-contact-id-alice-001', relationshipScore: 82 }],
                },
            ],
        });

        const resp = await handleMessage({
            jsonrpc: '2.0',
            id: 902,
            method: 'tools/call',
            params: { name: 'meeting_prep', arguments: { person: 'Alice', horizonHours: 48 } },
        }, context);
        const parsed = JSON.parse(resp.result.content[0].text);

        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.meeting.title, 'Later Alice sync');
        assert.equal(JSON.stringify(parsed).includes('raw-contact-id-bob-001'), false);
    });

    it('degrades when calendar is stale instead of fabricating prep', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0',
            id: 903,
            method: 'tools/call',
            params: { name: 'meeting_prep', arguments: { horizonHours: 48 } },
        }, calendarContext({ lastSyncAt: '2026-04-01T00:00:00Z' }));
        const parsed = JSON.parse(resp.result.content[0].text);

        assert.equal(parsed.status, 'degraded');
        assert.equal(parsed.meeting, undefined);
        assert.equal(parsed.attendees, undefined);
        assert.equal(parsed.safety.readOnly, true);
    });
});
```

Also update the existing JSON-RPC `tools/list` assertion in `tests/unit/minty-mcp-server.test.js`: it currently expects exactly four tools. It must expect five tools and include `meeting_prep`, otherwise the new tool tests can pass while the existing protocol-list test stays red.

**Step 2: Run to verify RED**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL because `meeting_prep` is not in `TOOLS` and `Unknown tool: meeting_prep` is returned.

---

### Task 3: Wire `meeting_prep` into MCP

**Objective:** Add the tool definition and execute branch using the existing pure envelope builder.

**Files:**
- Modify: `scripts/minty-mcp-server.js`

**Step 1: Add import**

At the top:

```js
const { buildMeetingPrep } = require('../crm/meeting-prep');
```

**Step 2: Add the tool definition**

Append to `TOOLS`:

```js
{
    name: 'meeting_prep',
    description:
        'Prepare a privacy-safe brief for an upcoming calendar meeting. ' +
        'Returns opaque refs, attendee relationship context, citations, freshness, and safety metadata. ' +
        'Read-only — no calendar changes, messages, or outreach.',
    inputSchema: {
        type: 'object',
        properties: {
            horizonHours: { type: 'number', description: 'Look ahead this many hours for an upcoming meeting (default 48, max 168)' },
            person: { type: 'string', description: 'Optional attendee/person name selector' },
        },
    },
},
```

**Step 3: Add safe horizon clamp**

Near `clampLimit()`:

```js
function clampHorizonHours(value, fallback = 48) {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(168, Math.floor(n)));
}
```

**Step 4: Add the execute branch before the unknown-tool fallback**

```js
if (name === 'meeting_prep') {
    const calendarState = syncState.calendar && typeof syncState.calendar === 'object' ? syncState.calendar : {};
    const meetings = Array.isArray(calendarState.upcomingMeetings) ? calendarState.upcomingMeetings : [];
    const envelope = buildMeetingPrep(meetings, {
        now: nowForTests,
        horizonHours: clampHorizonHours(args.horizonHours, 48),
        person: typeof args.person === 'string' ? args.person.trim() : undefined,
        calendarLastSyncAt: calendarState.lastSyncAt || calendarState.lastSyncedAt || calendarState.updatedAt || calendarState.lastSync || null,
        calendarStatus: calendarState.status || 'unknown',
        sourceHealth: {
            status: calendarState.status || 'unknown',
            stale: typeof calendarState.stale === 'boolean' ? calendarState.stale : true,
            lastSyncAt: calendarState.lastSyncAt || calendarState.lastSyncedAt || calendarState.updatedAt || calendarState.lastSync || null,
            evidenceBearing: typeof calendarState.evidenceBearing === 'boolean' ? calendarState.evidenceBearing : meetings.length > 0,
            answerable: typeof calendarState.answerable === 'boolean'
                ? calendarState.answerable
                : (calendarState.status === 'ok' && calendarState.stale === false && meetings.length > 0),
            lastError: typeof calendarState.lastError === 'string' ? calendarState.lastError : undefined,
        },
    });
    return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
}
```

If `meeting-prep.js` already treats old `lastSyncAt` values as stale, keep the MCP branch simple and let the pure builder own freshness judgment. Do not synthesize optimistic source-health defaults: missing calendar health should be stale/non-answerable by default, and real `sync-state.json` readiness/error fields should win over `meetings.length` heuristics.

**Step 5: Run targeted test to verify GREEN**

Run:

```bash
node --test tests/unit/meeting-prep.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose meeting prep MCP tool"
```

---

### Task 4: Update agent-surface docs and exact drift tests

**Objective:** Keep Hermes/OpenClaw docs and the bundled Hermes skill aligned with the new MCP tool.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Modify: `tests/unit/agent-surface-docs.test.js`

**Step 1: Update exact tool assertion**

In `tests/unit/agent-surface-docs.test.js`, change the exact sorted list to:

```js
assert.deepEqual(toolNames, ['meeting_prep', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
```

**Step 2: Document `meeting_prep` in `docs/HERMES_INTEGRATION.md`**

Add under Available tools:

```md
### meeting_prep
Upcoming-meeting prep. Input: `{ horizonHours?, person? }`.
Returns the next matched calendar meeting with opaque `eventRef`, redacted attendee relationship context, citations, freshness, and safety metadata. It never exposes raw calendar event ids, attendee emails, join links, descriptions, locations, or contact ids, and it never mutates Calendar or sends outreach.
```

Also update the setup/readiness smoke section to mention that `meeting_prep` requires Calendar sync state and `MINTY_REF_SECRET` or `MINTY_MCP_REF_SECRET` for opaque refs.

**Step 3: Document `meeting_prep` in `hermes/minty-network-memory/SKILL.md`**

Add a matching tool entry and operating note:

```md
### meeting_prep
Prepare for an upcoming meeting from local Minty calendar sync state.

```json
{ "horizonHours": 48 }
{ "person": "Alice", "horizonHours": 168 }
```

Use this when Sree asks for meeting prep or “what should I remember before my next call?” Treat degraded/empty responses as an honest data-readiness result, not as permission to infer context from memory. Do not expose raw calendar details or attendee contact details.
```

Wrap nested Markdown with four-backtick fences if needed so the skill remains valid Markdown.

**Step 4: Run docs drift test**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: document meeting prep MCP tool"
```

---

### Task 5: Add an end-to-end MCP smoke and run full verification

**Objective:** Prove the MCP boundary preserves the meeting-prep trust contract and the existing suite remains green.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js` if the smoke is best kept there; otherwise create: `tests/integration/meeting-prep-mcp.test.js` only if the repo already has similar MCP integration tests.

**Step 1: Add a small JSON-RPC smoke**

If not already covered in Task 2, add one test that calls `handleMessage()` with a realistic data object and asserts. Also add a production-path loader test (or exported-loader unit test if `loadData()` is already exportable) that writes a temporary `sync-state.json` under a temporary data dir, runs the same data-loading path used by the MCP server, and proves `calendar.upcomingMeetings` plus bounded readiness fields (`status`, `stale`, `answerable`, `evidenceBearing`, `lastSyncAt`) reach `meeting_prep`. This test is required; do not rely only on injecting a handcrafted `data` object into `handleMessage()`:

```js
assert.equal(parsed.status, 'ok');
assert.ok(parsed.dataFreshness);
assert.equal(parsed.safety.contactDetailsOmitted, true);
assert.equal(parsed.safety.readOnly, true);
assert.equal(parsed.safety.noLlmCalls, true);
assert.equal(parsed.safety.noOutreachTriggered, true);
assert.equal(JSON.stringify(parsed).includes('raw-event-id'), false);
assert.equal(JSON.stringify(parsed).includes('raw-contact-id'), false);
assert.equal(JSON.stringify(parsed).includes('@'), false);
assert.equal(/https?:\/\//.test(JSON.stringify(parsed)), false);
```

**Step 2: Run targeted tests**

```bash
node --test tests/unit/meeting-prep.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 3: Run full tests**

```bash
npm test
```

Expected: PASS.

**Step 4: Run E2E only if docs/server/tool wiring affected package behavior beyond unit coverage**

Because this is an MCP/server tool change rather than UI route work, `npm run test:e2e` is optional unless the implementation also touches routes or UI. If run:

```bash
npm run test:e2e
```

Expected: PASS.

**Step 5: Final commit**

```bash
git add tests/unit/minty-mcp-server.test.js
git commit -m "test: smoke meeting prep MCP privacy envelope"
```

---

## Final verification checklist

Run before opening the PR:

```bash
git diff --check origin/main...HEAD
node --test tests/unit/meeting-prep.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-surface-docs.test.js
npm test
```

Manual privacy scan over added output fixtures/snippets:

```bash
git diff origin/main...HEAD -- tests scripts docs hermes | grep -E "alice-private@example|raw-contact-id|raw-event-id|meet\.private|google_token|api_key" || true
```

Expected: forbidden sentinels may appear in this plan and in tests as input fixtures/assertions only, never in expected output snapshots, runtime outputs, or user-facing docs examples. Because this grep scans `docs`, manually distinguish fixture text from output/docs examples; do not treat `|| true` as a pass signal.

## PR summary template

```md
## Summary
- exposes existing `buildMeetingPrep()` through a read-only `meeting_prep` MCP tool
- loads sanitized calendar upcoming meetings for agent callers
- updates Hermes docs/skill and exact agent-surface drift tests

## Safety
- no outreach, calendar mutation, contact mutation, LLM call, or network call
- MCP output uses opaque refs and redacts emails, phones, URLs, locations, descriptions, raw event ids, and raw contact ids

## Tests
- `node --test tests/unit/meeting-prep.test.js tests/unit/minty-mcp-server.test.js tests/unit/agent-surface-docs.test.js`
- `npm test`
```
