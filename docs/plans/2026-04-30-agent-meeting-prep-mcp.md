# Agent Meeting Prep MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a `meeting_prep` MCP tool so Hermes can ask Minty for the next source-backed meeting brief without opening the CRM UI.

**Architecture:** Reuse Minty's existing Calendar sync path: `crm/sync.js` already writes enriched `sync-state.json.calendar.upcomingMeetings`, and `crm/server.js` already re-enriches that data for Today and `/api/calendar/upcoming`. Add a pure `crm/meeting-prep.js` module that converts those meetings into a redacted agent envelope, extend `scripts/agent-query.js` to load sync state, and expose the result via `scripts/minty-mcp-server.js`. No runtime LLM calls, no outreach, no new dependencies.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/sync-state.json`, `data/unified/contacts.json`, `data/unified/insights.json`, `crm/calendar.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's pivot is agent-native private network memory. The existing MCP surface is useful but still query-first:

- `search_network` — find relevant people by goal/query.
- `person_context` — look up a known person.
- `workflow_brief` — get a goal-oriented people list.

The missing agent workflow is meeting prep. Calendar data already exists and is refreshed by the daemon, but Hermes cannot ask: **“I have a call soon — who is it with, what do I know, what should I remember, and how fresh is this context?”** That is a sharper wedge than another CRM screen because it lands inside Sree's existing assistant workflow right before a high-value interaction.

This plan is intentionally narrow: one read-only MCP tool, one pure formatter, source-backed evidence, redacted contact fields. It does not schedule meetings, send messages, or create generic “stay in touch” nagging.

Success criteria:

- `meeting_prep` appears in MCP `tools/list` beside `search_network`, `person_context`, and `workflow_brief`.
- `meeting_prep({ horizonHours: 48 })` returns the next upcoming meeting with matched attendees, relationship warmth, topics/open loops/meeting briefs, citations, freshness metadata, and safety metadata.
- `meeting_prep({ person: "Alice" })` prefers the next meeting whose matched attendee name includes Alice.
- The envelope omits emails, phone numbers, URLs/join links, raw attendee objects, raw contact records, raw calendar locations, and calendar descriptions.
- Empty/low-data states fail usefully: no fabricated context, no stale confidence inflation.

Privacy contract for implementation:

- Treat every calendar-derived string as untrusted private data. Meeting titles, locations, attendee display names, and citation labels can contain emails, phone numbers, Zoom/Meet links, dial-ins, addresses, or pasted descriptions.
- Run every returned string through one central redaction helper, and add whole-envelope tests that `JSON.stringify(prep)` excludes fixture emails, phones, URLs, and join links.
- Do not return raw `location`; return `locationType` (`video`, `phone`, `in_person`, or `unknown`) unless a future product decision explicitly requires more.
- "Source-backed" citations must point to concrete local provenance when available: source type plus contact/interaction/event id or timestamp. Field-name-only labels are not enough to claim verification.

---

### Task 1: Add the pure meeting prep envelope builder

**Objective:** Create a deterministic `buildMeetingPrep()` helper that selects an upcoming meeting and returns a redacted, source-backed agent envelope.

**Files:**
- Create: `crm/meeting-prep.js`
- Test: `tests/unit/meeting-prep.test.js`

**Step 1: Write failing test**

Create `tests/unit/meeting-prep.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMeetingPrep } = require('../../crm/meeting-prep');

const NOW = '2026-04-30T09:00:00Z';

function meeting(overrides = {}) {
    return {
        id: 'evt_1',
        title: 'Coffee with Alice',
        startAt: '2026-04-30T11:00:00Z',
        endAt: '2026-04-30T11:30:00Z',
        location: 'Zoom',
        attendees: [
            {
                email: 'alice@example.com',
                displayName: 'Alice',
                contactId: 'c_alice',
                name: 'Alice Müller',
                relationshipScore: 82,
                daysSinceContact: 5,
                topics: ['EU insurance', 'fundraising'],
                openLoops: ['Send deck intro'],
                meetingBrief: 'Alice is a warm investor contact.',
            },
        ],
        ...overrides,
    };
}

test('[MeetingPrep]: returns next upcoming meeting with redacted attendee context', () => {
    const prep = buildMeetingPrep([meeting()], { now: NOW, horizonHours: 48 });

    assert.equal(prep.status, 'ok');
    assert.equal(prep.meeting.id, 'evt_1');
    assert.equal(prep.meeting.title, 'Coffee with Alice');
    assert.equal(prep.attendees[0].name, 'Alice Müller');
    assert.equal(prep.attendees[0].email, undefined);
    assert.equal(prep.attendees[0].relationshipScore, 82);
    assert.ok(prep.attendees[0].citations.some(c => c.source === 'insights.meetingBrief'));
    assert.equal(prep.safety.contactDetailsOmitted, true);
    assert.equal(prep.safety.readOnly, true);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/meeting-prep.test.js
```

Expected: FAIL — `Cannot find module '../../crm/meeting-prep'`.

**Step 3: Write minimal implementation**

Create `crm/meeting-prep.js`:

```js
'use strict';

function toMs(value) {
    const t = Date.parse(value || '');
    return Number.isNaN(t) ? null : t;
}

function warmthLabel(score) {
    const s = Number(score) || 0;
    if (s >= 70) return 'strong';
    if (s >= 50) return 'warm';
    if (s >= 30) return 'cool';
    return 'cold';
}

function redactSensitiveString(value) {
    if (!value) return value;
    return String(value)
        .replace(/(?:mailto:|tel:)\S+/gi, '[redacted-contact]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/https?:\/\/\S+/gi, '[redacted-url]')
        .replace(/\b(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/gi, '[redacted-url]')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
        .replace(/[A-Z0-9._%+-]+@/gi, '[redacted-email]');
}

function locationType(value) {
    const text = String(value || '').toLowerCase();
    if (/zoom|meet|teams|http/.test(text)) return 'video';
    if (/phone|dial|tel:/.test(text)) return 'phone';
    if (text.trim()) return 'in_person';
    return 'unknown';
}

function safeAttendee(a, meetingId) {
    const citations = [];
    const contactId = a.contactId || null;
    const baseCitation = {
        contactId,
        eventId: meetingId || null,
        field: null,
        observedAt: a.lastInteractionAt || a.updatedAt || a.analyzedAt || null,
        provenance: contactId || meetingId || a.lastInteractionAt || a.updatedAt || a.analyzedAt ? 'local' : 'derived-field-only',
    };
    if (a.meetingBrief) citations.push({ ...baseCitation, field: 'meetingBrief', source: 'insights.meetingBrief', label: 'Meeting brief available' });
    if (Array.isArray(a.topics) && a.topics.length) citations.push({ ...baseCitation, field: 'topics', source: 'insights.topics', label: redactSensitiveString(a.topics.slice(0, 3).join(', ')) });
    if (Array.isArray(a.openLoops) && a.openLoops.length) citations.push({ ...baseCitation, field: 'openLoops', source: 'insights.openLoops', label: redactSensitiveString(a.openLoops.slice(0, 2).join('; ')) });
    if (a.daysSinceContact != null) citations.push({ ...baseCitation, field: 'daysSinceContact', source: 'contact.daysSinceContact', label: 'Last contact ' + a.daysSinceContact + 'd ago' });

    return {
        contactId,
        name: redactSensitiveString(a.name || a.displayName || 'Unknown attendee'),
        responseStatus: a.responseStatus || null,
        relationshipScore: a.relationshipScore ?? null,
        warmth: a.relationshipScore == null ? null : warmthLabel(a.relationshipScore),
        daysSinceContact: a.daysSinceContact ?? null,
        topics: Array.isArray(a.topics) ? a.topics.slice(0, 5).map(redactSensitiveString) : [],
        openLoops: Array.isArray(a.openLoops) ? a.openLoops.slice(0, 5).map(redactSensitiveString) : [],
        meetingBrief: a.meetingBrief ? redactSensitiveString(a.meetingBrief) : null,
        citations,
    };
}

function isSelfOrEmpty(a) {
    return !a || a.self === true || (!a.contactId && !(a.name || a.displayName));
}

function selectMeeting(meetings, opts = {}) {
    const nowMs = toMs(opts.now) || Date.now();
    const horizonHours = Number.isFinite(opts.horizonHours) ? opts.horizonHours : 48;
    const horizonMs = nowMs + Math.max(1, Math.min(168, horizonHours)) * 60 * 60 * 1000;
    const person = String(opts.person || '').trim().toLowerCase();
    const meetingId = String(opts.meetingId || '').trim();

    const candidates = (Array.isArray(meetings) ? meetings : [])
        .filter(m => m && m.id && toMs(m.startAt) != null)
        .filter(m => (toMs(m.endAt) || toMs(m.startAt)) >= nowMs && toMs(m.startAt) <= horizonMs)
        .sort((a, b) => toMs(a.startAt) - toMs(b.startAt));

    if (meetingId) return candidates.find(m => String(m.id) === meetingId) || null;
    if (person) {
        return candidates.find(m => (m.attendees || []).some(a =>
            String(a.name || a.displayName || '').toLowerCase().includes(person)
        )) || null;
    }
    return candidates[0] || null;
}

function buildMeetingPrep(meetings, opts = {}) {
    const selected = selectMeeting(meetings, opts);
    const generatedAt = new Date(toMs(opts.now) || Date.now()).toISOString();
    if (!selected) {
        return {
            status: 'empty',
            reason: 'No upcoming meeting matched the request inside the selected horizon.',
            generatedAt,
            safety: {
                contactDetailsOmitted: true,
                readOnly: true,
                noLlmCalls: true,
                noOutreachTriggered: true,
            },
        };
    }

    const attendees = (selected.attendees || []).filter(a => !isSelfOrEmpty(a)).map(a => safeAttendee(a, selected.id));
    const strongest = attendees.slice().sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))[0] || null;

    return {
        status: 'ok',
        meeting: {
            id: selected.id,
            title: redactSensitiveString(selected.title || '(No title)'),
            startAt: selected.startAt || null,
            endAt: selected.endAt || null,
            locationType: locationType(selected.location),
        },
        summary: strongest
            ? 'Prep for ' + strongest.name + ' — ' + (strongest.meetingBrief || strongest.citations[0]?.label || 'review relationship context before the meeting') + '.'
            : 'No matched Minty contacts found for this meeting yet.',
        attendees,
        dataFreshness: {
            generatedAt,
            calendarLastSyncAt: opts.calendarLastSyncAt || null,
            calendarStatus: opts.calendarStatus || 'unknown',
        },
        safety: {
            contactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'urls', 'rawLocation', 'rawContact', 'rawAttendee', 'description'],
            readOnly: true,
            noLlmCalls: true,
            noOutreachTriggered: true,
        },
    };
}

module.exports = { buildMeetingPrep, selectMeeting, safeAttendee, warmthLabel, redactSensitiveString, locationType };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/meeting-prep.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/meeting-prep.js tests/unit/meeting-prep.test.js
git commit -m "feat: build meeting prep envelopes"
```

---

### Task 2: Cover meeting selection and privacy edge cases

**Objective:** Lock in the selection contract and prevent accidental contact-detail leakage.

**Files:**
- Modify: `tests/unit/meeting-prep.test.js`
- Modify: `crm/meeting-prep.js` only if tests expose a bug

**Step 1: Add edge-case tests**

Append to `tests/unit/meeting-prep.test.js`:

```js
test('[MeetingPrep]: person filter selects matching future meeting', () => {
    const meetings = [
        meeting({ id: 'evt_bob', title: 'Bob sync', startAt: '2026-04-30T10:00:00Z', attendees: [{ displayName: 'Bob' }] }),
        meeting({ id: 'evt_alice', title: 'Alice sync', startAt: '2026-04-30T12:00:00Z' }),
    ];

    const prep = buildMeetingPrep(meetings, { now: NOW, person: 'Alice', horizonHours: 48 });

    assert.equal(prep.status, 'ok');
    assert.equal(prep.meeting.id, 'evt_alice');
});

test('[MeetingPrep]: empty state does not fabricate context', () => {
    const prep = buildMeetingPrep([], { now: NOW, horizonHours: 48 });

    assert.equal(prep.status, 'empty');
    assert.match(prep.reason, /No upcoming meeting/);
    assert.equal(prep.attendees, undefined);
});

test('[MeetingPrep]: output never includes raw emails, phones, URLs, or locations', () => {
    const prep = buildMeetingPrep([meeting({
        title: 'Call with private@example.com',
        location: 'zoom.us/j/123456789?pwd=secret',
        attendees: [{
            email: 'private@example.com',
            phone: '+15551230100',
            displayName: 'private@example.com',
            contactId: 'c_private',
            relationshipScore: 60,
            topics: ['Follow up at example.com/private'],
            openLoops: ['Call +15551230100'],
            meetingBrief: 'Private details at private@example.com',
        }],
    })], { now: NOW });

    const text = JSON.stringify(prep);
    assert.equal(text.includes('private@example.com'), false);
    assert.equal(text.includes('private@'), false);
    assert.equal(text.includes('private Person'), false);
    assert.equal(/[A-Z0-9._%+-]+@/i.test(text), false);
    assert.equal(text.includes('+15551230100'), false);
    assert.equal(text.includes('zoom.us'), false);
    assert.equal(text.includes('example.com/private'), false);
    assert.equal(prep.meeting.location, undefined);
    assert.equal(prep.meeting.locationType, 'video');
});
```

**Step 2: Run targeted tests**

Run:

```bash
node --test tests/unit/meeting-prep.test.js
```

Expected: PASS. If not, fix `crm/meeting-prep.js`; do not weaken the privacy assertions.

**Step 3: Run related unit tests**

Run:

```bash
node --test tests/unit/meeting-prep.test.js tests/unit/calendar.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add crm/meeting-prep.js tests/unit/meeting-prep.test.js
git commit -m "test: cover meeting prep selection and privacy"
```

---

### Task 3: Load calendar sync state for agent/MCP callers

**Objective:** Extend the shared agent data loader so MCP tools can access upcoming meetings and calendar freshness metadata without duplicating file I/O.

**Files:**
- Modify: `scripts/agent-query.js:48-63`
- Test: `tests/unit/agent-query.test.js` if present; otherwise add assertions to `tests/unit/minty-mcp-server.test.js` in Task 4

**Step 1: Check for existing agent-query tests**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
print(Path('tests/unit/agent-query.test.js').exists())
PY
```

Expected: prints `False` unless a test was added later.

**Step 2: Extend `loadData()`**

In `scripts/agent-query.js`, change `loadData()` to read `sync-state.json` from the data directory root:

```js
function loadData(dataDir) {
    function loadJson(file) {
        const p = path.join(dataDir, 'unified', file);
        if (!fs.existsSync(p)) return file === 'insights.json' ? {} : [];
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    function loadSyncState() {
        const p = path.join(dataDir, 'sync-state.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch { return {}; }
    }
    const syncState = loadSyncState();
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        syncState,
        meetings: syncState.calendar?.upcomingMeetings || [],
    };
}
```

Do not change the CLI output in this task; existing `npm run agent -- "..."` should keep returning network query results only.

**Step 3: Smoke the CLI still works**

Run:

```bash
npm run seed:demo
npm run agent -- "investors in London"
```

Expected: command exits 0 and prints JSON or TTY-formatted network results as before.

**Step 4: Commit**

```bash
git add scripts/agent-query.js
git commit -m "feat: load calendar state for agent tools"
```

---

### Task 4: Expose `meeting_prep` through the MCP server

**Objective:** Add the fourth MCP tool and route calls to `buildMeetingPrep()` using loaded calendar data.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-68`
- Modify: `scripts/minty-mcp-server.js:95-171`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Add failing tool-list test**

In `tests/unit/minty-mcp-server.test.js`, update the `tools/list` assertion:

```js
assert.equal(tools.length, 4);
const names = tools.map(t => t.name).sort();
assert.deepEqual(names, ['meeting_prep', 'person_context', 'search_network', 'workflow_brief']);
```

Add a tool definition shape test:

```js
it('meeting_prep has optional meetingId, person, and horizonHours', () => {
    const tool = TOOLS.find(t => t.name === 'meeting_prep');
    assert.ok(tool);
    assert.ok(tool.inputSchema.properties.meetingId);
    assert.ok(tool.inputSchema.properties.person);
    assert.ok(tool.inputSchema.properties.horizonHours);
    assert.deepEqual(tool.inputSchema.required || [], []);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — tool count/name mismatch.

**Step 3: Add MCP implementation**

At the top of `scripts/minty-mcp-server.js`, add:

```js
const { buildMeetingPrep } = require('../crm/meeting-prep');
```

Add a `TOOLS` entry:

```js
{
    name: 'meeting_prep',
    description:
        'Prepare for an upcoming meeting using local Calendar + Minty relationship context. ' +
        'Returns redacted attendee context, source citations, open loops, and freshness metadata. ' +
        'Read-only — no calendar edits, no messages sent, no contact details exposed.',
    inputSchema: {
        type: 'object',
        properties: {
            meetingId: { type: 'string', description: 'Optional exact calendar event id to prepare for' },
            person: { type: 'string', description: 'Optional attendee name filter, e.g. "Alice"' },
            horizonHours: { type: 'number', description: 'Upcoming window to search, 1-168 hours, default 48' },
        },
    },
},
```

Inside `executeTool(name, args, data)`, add before the unknown-tool branch:

```js
function clampHorizonHours(value, defaultValue = 48) {
    const n = Number(value);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.max(1, Math.min(168, Math.floor(n)));
}

if (name === 'meeting_prep') {
    args = args || {};
    const syncState = data.syncState || {};
    const prep = buildMeetingPrep(data.meetings || syncState.calendar?.upcomingMeetings || [], {
        meetingId: args.meetingId,
        person: args.person,
        horizonHours: clampHorizonHours(args.horizonHours, 48),
        calendarLastSyncAt: syncState.calendar?.lastSyncAt || null,
        calendarStatus: syncState.calendar?.status || 'unknown',
    });
    return { content: [{ type: 'text', text: JSON.stringify(prep, null, 2) }] };
}
```

Do not reuse `clampLimit()` for `horizonHours`; it caps at 50 and would contradict the documented 1–168 hour window.

**Step 4: Add tool-call tests**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
describe('meeting_prep tool', () => {
    it('returns redacted prep for the next meeting', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 50, method: 'tools/call',
            params: { name: 'meeting_prep', arguments: { horizonHours: 48 } },
        }, {
            contacts: CONTACTS,
            insights: INSIGHTS,
            syncState: { calendar: { status: 'ok', lastSyncAt: '2026-04-30T08:55:00Z' } },
            meetings: [{
                id: 'evt_1',
                title: 'Alice call',
                startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                attendees: [{
                    email: 'alice@example.com',
                    displayName: 'Alice',
                    contactId: 'wa_001',
                    name: 'Alice Müller',
                    relationshipScore: 72,
                    daysSinceContact: 3,
                    topics: ['EU insurance'],
                    meetingBrief: 'Warm founder/investor context.',
                }],
            }],
        });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.meeting.id, 'evt_1');
        assertNoDirectContactDetails(parsed);
        assert.equal(parsed.safety.contactDetailsOmitted, true);
    });
});
```

**Step 5: Run MCP tests**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/meeting-prep.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/minty-mcp-server.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose meeting prep MCP tool"
```

---

### Task 5: Document the Hermes meeting prep workflow

**Objective:** Update agent-facing docs and the Hermes skill so agents know when to call `meeting_prep` instead of doing generic person search.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:100-114`
- Modify: `docs/OPENCLAW_HERMES.md` around tool list
- Modify: `hermes/minty-network-memory/SKILL.md:30-60`

**Step 1: Update `docs/HERMES_INTEGRATION.md`**

Under “Available tools,” add:

```md
### meeting_prep
Upcoming meeting brief. Input: `{ meetingId?, person?, horizonHours? }`.
Returns the next matching meeting with redacted attendee context, topics, open loops, source citations, and calendar freshness metadata.
```

Under “Example queries,” add:

```md
| `meeting_prep({ "person": "Alice" })` | Prep for the next Alice meeting with relationship context and open loops |
```

**Step 2: Update `hermes/minty-network-memory/SKILL.md`**

Add meeting prep to “When to use”:

```md
- **Meeting prep** — before a call, ask Minty for redacted attendee context, open loops, and source-backed reminders
```

Add tool docs:

````md
### meeting_prep
Prepare for the next upcoming meeting or the next meeting with a named person.

```json
{ "person": "Alice", "horizonHours": 48 }
```

Use this before `person_context` when the user asks “what should I know for my next meeting/call?” because it includes calendar freshness and attendee-specific context.
````

**Step 3: Update `docs/OPENCLAW_HERMES.md`**

Add `meeting_prep` to the MCP tool list:

```md
- `meeting_prep` — read-only upcoming meeting prep from Calendar + Minty context. Returns redacted attendee context, open loops, provenance-aware citations, and freshness metadata; never returns raw emails, phones, locations, descriptions, or join links.
```

**Step 4: Verify docs diff**

Run:

```bash
git diff -- docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
```

Expected: only MCP/Hermes documentation changes; no private notes.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document meeting prep MCP workflow"
```

---

### Task 6: Add an end-to-end MCP smoke for meeting prep

**Objective:** Prove the stdio MCP server can list and call `meeting_prep` with fixture data.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`
- Possibly modify: `scripts/seed-dev-data.js` only if existing demo data lacks `sync-state.json.calendar.upcomingMeetings`

**Step 1: Add stdio smoke test**

In `tests/unit/minty-mcp-server.test.js`, add a child-process smoke similar to the existing Content-Length test, but call `tools/call` for `meeting_prep`. Use a temporary `CRM_DATA_DIR` fixture if needed so the production data loader path is exercised.

Minimal pattern:

```js
// Create temp data dir with unified/contacts.json, unified/insights.json, sync-state.json.
// Spawn `node scripts/minty-mcp-server.js` with env { ...process.env, CRM_DATA_DIR: tmpDir }.
// Send initialize, notifications/initialized, tools/call meeting_prep as newline-delimited JSON.
// Assert stdout JSON includes `"status":"ok"` or pretty-spaced equivalent and does not include fixture email.
```

Keep this test deterministic: meeting `startAt` should be `new Date(Date.now() + 60 * 60 * 1000).toISOString()`.

**Step 2: Run targeted test**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 3: Run full suite**

Run:

```bash
npm test
```

Expected: all unit tests PASS.

**Step 4: Commit**

```bash
git add tests/unit/minty-mcp-server.test.js scripts/seed-dev-data.js
git commit -m "test: smoke meeting prep MCP call"
```

Only include `scripts/seed-dev-data.js` if it was actually changed.

---

## Verification checklist

After all tasks:

```bash
npm test
npm run seed:demo
python3 - <<'PY' | node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY
git status --short --branch
```

Expected:

- Unit tests pass.
- MCP `tools/list` includes `meeting_prep`.
- `meeting_prep` responses omit direct contact details and raw calendar attendee data.
- The tool returns `status: "empty"` instead of inventing context when there is no matching meeting.
- Working tree is clean after task commits.

## Rollback plan

If `meeting_prep` feels too early for public MCP docs, keep `crm/meeting-prep.js` and the tests but revert the `TOOLS` entry and docs. The pure helper remains useful for `/api/today`, CLI output, and future Hermes-native workflows.
