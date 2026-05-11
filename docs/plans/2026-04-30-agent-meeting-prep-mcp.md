# Agent Meeting Prep MCP Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a `meeting_prep` MCP tool so Hermes can ask Minty for the next source-backed meeting brief without opening the CRM UI, while preserving the newer MCP trust contract around source health, opaque refs, and privacy-safe citations.

**Architecture:** Reuse Minty's existing Calendar sync path: `crm/sync.js` already writes enriched `sync-state.json.calendar.upcomingMeetings`, and `crm/server.js` already re-enriches that data for Today and `/api/calendar/upcoming`. Add a pure `crm/meeting-prep.js` module that converts those pre-enriched meetings into a redacted agent envelope, extend `scripts/agent-query.js` to load only sanitized calendar sync metadata for agent callers, and expose the result via `scripts/minty-mcp-server.js`. Meeting prep should reuse the trust-contract conventions from retrieval/person-context/source-health — opaque refs, redacted citations, honest empty states, and freshness preflight — without exposing raw calendar/contact records. No runtime LLM calls, no outreach, no new dependencies.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/sync-state.json`, `data/unified/contacts.json`, `data/unified/insights.json`, `crm/calendar.js`, `scripts/minty-mcp-server.js`.

---

## Product framing

Minty's pivot is agent-native private network memory. The existing MCP surface is useful but still query-first:

- `search_network` — find relevant people by goal/query.
- `person_context` — look up a known person.
- `workflow_brief` — get a goal-oriented people list.
- `source_health` — preflight whether a source is fresh/evidence-bearing before trusting source-scoped answers.

**2026-05-10 update:** This plan predates the newer `source_health`, source answerability gate, opaque contact refs, and GBrain export trust-contract work. Implement the updated snippets below, not the older raw-id shape. Meeting prep must be at least as strict as `search_network`/`person_context`: no raw calendar event ids, raw contact ids, attendee emails, phones, URLs, descriptions, source handles, private paths, or raw invalid input in the agent envelope.

**2026-05-11 current-state update:** PR #202 landed the pure privacy-safe meeting-prep envelope (`crm/meeting-prep.js`) and unit coverage (`tests/unit/meeting-prep.test.js`). Do not recreate that module. The next builder should start at the MCP/docs/smoke handoff: wire `buildMeetingPrep()` into `scripts/minty-mcp-server.js`, update `tests/unit/minty-mcp-server.test.js` from the current exact tool list `['person_context', 'search_network', 'source_health', 'workflow_brief']` to include `meeting_prep`, then update `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`, and `tests/unit/agent-surface-docs.test.js`. Preserve the existing `person_context` source-filter behavior and the source-health/answerability contract; meeting prep should be additive, not a second retrieval implementation.

The missing agent workflow is now the protocol boundary, not the formatter. Calendar prep envelopes exist locally, but Hermes still cannot ask through MCP: **“I have a call soon — who is it with, what do I know, what should I remember, and how fresh is this context?”** That is a sharper wedge than another CRM screen because it lands inside Sree's existing assistant workflow right before a high-value interaction.

The remaining work is intentionally narrow: one read-only MCP tool wired to the existing pure meeting-prep envelope, plus source-backed evidence preservation, redacted contact fields, docs, and smoke coverage. It does not schedule meetings, send messages, or create generic “stay in touch” nagging.

Success criteria:

- `meeting_prep` appears in MCP `tools/list` beside `person_context`, `search_network`, `source_health`, and `workflow_brief`; update exact tool-count/name assertions from 4 tools to 5 tools.
- `meeting_prep({ horizonHours: 48 })` returns the next upcoming meeting with matched attendees, relationship warmth, topics/open loops/meeting briefs, opaque citations, freshness metadata, and safety metadata.
- `meeting_prep({ person: "Alice" })` prefers the next meeting whose matched attendee name includes Alice.
- The envelope omits emails, phone numbers, URLs/join links, raw attendee objects, raw contact records, raw contact ids, raw calendar event ids, raw calendar locations, and calendar descriptions.
- Empty/low-data states fail usefully: no fabricated context, no stale confidence inflation.

Privacy contract for implementation:

- Treat every calendar-derived string as untrusted private data. Meeting titles, locations, attendee display names, attendee ids, event ids, and citation labels can contain emails, phone numbers, Zoom/Meet links, dial-ins, addresses, or pasted descriptions.
- Run every returned string through one central redaction helper, and add whole-envelope tests that `JSON.stringify(prep)` excludes fixture emails, phones, URLs, raw event ids, raw contact ids, source handles, private filesystem paths, and token-path-like strings.
- Do not return raw `location`; return `locationType` (`video`, `phone`, `in_person`, or `unknown`) unless a future product decision explicitly requires more.
- "Source-backed" citations must point to concrete local provenance when available without exposing raw ids: source type, opaque `citationRef`, observed timestamp, and redacted evidence kind are enough. Field-name-only labels are not enough to claim verification, but raw event/contact ids are not allowed in MCP output.
- Opaque refs require `MINTY_REF_SECRET` or `MINTY_MCP_REF_SECRET` in production. If no ref secret is configured, fail closed with `opaque_ref_unavailable` rather than returning raw ids. Refs are stable only for the configured secret; rotating the secret invalidates previously issued `eventRef`, `contactRef`, and `citationRef` values.

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

process.env.MINTY_REF_SECRET ||= 'unit-test-only-meeting-prep-ref-secret';

const NOW = '2026-04-30T09:00:00Z';
const READY_CALENDAR = { status: 'ok', stale: false, lastSyncAt: '2026-04-30T08:55:00Z', evidenceBearing: true, answerable: true };

function meeting(overrides = {}) {
    return {
        id: 'evt_1',
        title: 'Coffee with Alice',
        startAt: '2026-04-30T11:00:00Z',
        endAt: '2026-04-30T11:30:00Z',
        location: 'Zoom https://meet.example.com/private +44 20 7123 4567',
        attendees: [
            {
                email: 'alice@example.com',
                displayName: 'Alice',
                contactId: 'c_alice',
                name: 'Alice Müller',
                relationshipScore: 82,
                daysSinceContact: 5,
                topics: ['EU insurance', '@alice_handle'],
                openLoops: ['Send deck intro from /root/.hermes/google_token.json'],
                meetingBrief: 'Alice is a warm investor contact; token file /Users/sree/private/api_key.json is irrelevant.',
                responseStatus: 'accepted by alice@example.com',
            },
        ],
        ...overrides,
    };
}

test('[MeetingPrep]: returns next upcoming meeting with redacted attendee context', () => {
    const prep = buildMeetingPrep([meeting()], { now: NOW, horizonHours: 48, sourceHealth: READY_CALENDAR });

    assert.equal(prep.status, 'ok');
    assert.match(prep.meeting.eventRef, /^calendar-event:/);
    assert.equal(prep.meeting.id, undefined);
    assert.equal(prep.meeting.title, 'Coffee with Alice');
    assert.equal(prep.attendees[0].name, 'Alice Müller');
    assert.equal(prep.attendees[0].email, undefined);
    assert.equal(prep.attendees[0].relationshipScore, 82);
    assert.ok(prep.attendees[0].citations.some(c => c.source === 'insights.meetingBrief'));
    const serialized = JSON.stringify(prep);
    for (const forbidden of ['alice@example.com', 'c_alice', 'evt_1', 'meet.example.com', '+44 20 7123 4567', '@alice_handle', '/root/.hermes/google_token.json', '/Users/sree/private/api_key.json']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
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

const crypto = require('node:crypto');

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
        .replace(/\+?\d[\d\s().*xX-]{5,}\d/g, '[redacted-phone]')
        .replace(/[A-Z0-9._%+-]+@/gi, '[redacted-email]')
        .replace(/(^|[^\w])@[a-z0-9_.-]{2,}/gi, '$1[redacted-handle]')
        .replace(/\b(?:telegram|whatsapp|linkedin|slack|email|sms|googleContacts):[^\s,;)]*/gi, '[redacted-source-ref]')
        .replace(/(?:^|\s)(?:\.?\.?\/)?[^\s,;)]*(?:token|secret|credential|key)[^\s,;)]*\.(?:json|ya?ml|env|txt)/gi, ' [redacted-secret-path]')
        .replace(/(?:\/[^\s,;)]*){2,}|[A-Z]:\\[^\s,;)]*/g, '[redacted-path]');
}

function isoOrNull(value) {
    const t = toMs(value);
    return t == null ? null : new Date(t).toISOString();
}

function safeStatus(value) {
    const status = String(value || '').toLowerCase();
    return ['ok', 'stale', 'error', 'missing', 'unknown'].includes(status) ? status : 'unknown';
}

function locationType(value) {
    const text = String(value || '').toLowerCase();
    if (/zoom|meet|teams|http/.test(text)) return 'video';
    if (/phone|dial|tel:/.test(text)) return 'phone';
    if (text.trim()) return 'in_person';
    return 'unknown';
}

class OpaqueRefUnavailableError extends Error {
    constructor() {
        super('opaque_ref_unavailable');
        this.code = 'opaque_ref_unavailable';
    }
}

function safeRef(prefix, value) {
    const s = String(value || '');
    const secret = process.env.MINTY_REF_SECRET || process.env.MINTY_MCP_REF_SECRET;
    // Production must set a stable ref secret. Without it, fail closed instead of exposing raw ids.
    // Rotating the secret intentionally invalidates previously issued opaque refs.
    if (!secret) throw new OpaqueRefUnavailableError();
    const digest = crypto.createHmac('sha256', secret).update(prefix).update('\0').update(s).digest('base64url');
    return prefix + ':' + digest.slice(0, 24);
}

function sanitizeSourceHealth(health, now = Date.now()) {
    if (!health || typeof health !== 'object') return { status: 'unknown', stale: true, evidenceBearing: false, answerable: false, lastSyncAt: null };
    const status = safeStatus(health.status);
    const lastSyncAt = isoOrNull(health.lastSyncAt);
    const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : null;
    const maxAgeMs = 72 * 60 * 60 * 1000;
    const staleByAge = !lastSyncMs || lastSyncMs > now || (now - lastSyncMs) > maxAgeMs;
    const stale = health.stale === true || status !== 'ok' || staleByAge;
    const evidenceBearing = health.evidenceBearing === true;
    return {
        status,
        stale,
        lastSyncAt,
        evidenceBearing,
        answerable: status === 'ok' && !stale && evidenceBearing && health.answerable !== false,
    };
}

function sourceNotReadyEnvelope(sourceHealth, generatedAt) {
    return {
        status: 'degraded',
        reason: 'Calendar source is not fresh, evidence-bearing, and answerable enough to prepare a meeting brief safely.',
        generatedAt,
        dataFreshness: { generatedAt, sourceHealth },
        safety: {
            contactDetailsOmitted: true,
            readOnly: true,
            noLlmCalls: true,
            noOutreachTriggered: true,
        },
    };
}

function safeAttendee(a, calendarEventId) {
    const citations = [];
    const contactRef = a.contactId ? safeRef('contact', a.contactId) : null;
    const eventRef = calendarEventId ? safeRef('calendar-event', calendarEventId) : null;
    const baseCitation = {
        citationRef: safeRef('citation', [contactRef, eventRef, a.lastInteractionAt || a.updatedAt || a.analyzedAt || ''].join('|')),
        source: null,
        evidenceKind: null,
        observedAt: isoOrNull(a.lastInteractionAt || a.updatedAt || a.analyzedAt),
        provenance: contactRef || eventRef || a.lastInteractionAt || a.updatedAt || a.analyzedAt ? 'local' : 'derived-field-only',
    };
    if (a.meetingBrief) citations.push({ ...baseCitation, evidenceKind: 'meeting_brief', source: 'insights.meetingBrief', label: 'Meeting brief available' });
    if (Array.isArray(a.topics) && a.topics.length) citations.push({ ...baseCitation, evidenceKind: 'topics', source: 'insights.topics', label: redactSensitiveString(a.topics.slice(0, 3).join(', ')) });
    if (Array.isArray(a.openLoops) && a.openLoops.length) citations.push({ ...baseCitation, evidenceKind: 'open_loops', source: 'insights.openLoops', label: redactSensitiveString(a.openLoops.slice(0, 2).join('; ')) });
    if (a.daysSinceContact != null) citations.push({ ...baseCitation, evidenceKind: 'recency', source: 'contact.daysSinceContact', label: 'Last contact ' + a.daysSinceContact + 'd ago' });

    return {
        contactRef,
        name: redactSensitiveString(a.name || a.displayName || 'Unknown attendee'),
        responseStatus: a.responseStatus ? redactSensitiveString(a.responseStatus) : null,
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
    const eventRef = String(opts.eventRef || '').trim();

    const candidates = (Array.isArray(meetings) ? meetings : [])
        .filter(m => m && m.id && toMs(m.startAt) != null)
        .filter(m => (toMs(m.endAt) || toMs(m.startAt)) >= nowMs && toMs(m.startAt) <= horizonMs)
        .sort((a, b) => toMs(a.startAt) - toMs(b.startAt));

    if (eventRef) return candidates.find(m => m.id && safeRef('calendar-event', m.id) === eventRef) || null;
    if (person) {
        return candidates.find(m => (m.attendees || []).some(a =>
            String(a.name || a.displayName || '').toLowerCase().includes(person)
        )) || null;
    }
    return candidates[0] || null;
}

function buildMeetingPrep(meetings, opts = {}) {
    const generatedAt = new Date(toMs(opts.now) || Date.now()).toISOString();
    const nowMs = toMs(opts.now) || Date.now();
    const sourceHealth = sanitizeSourceHealth(opts.sourceHealth, nowMs);
    if (!sourceHealth.answerable) return sourceNotReadyEnvelope(sourceHealth, generatedAt);

    let selected;
    try {
        selected = selectMeeting(meetings, opts);
    } catch (err) {
        if (err && err.code === 'opaque_ref_unavailable') {
            return {
                status: 'error',
                reason: 'Opaque references are unavailable; meeting prep cannot safely return private calendar context.',
                generatedAt,
                dataFreshness: { generatedAt, sourceHealth },
                safety: { contactDetailsOmitted: true, readOnly: true, noLlmCalls: true, noOutreachTriggered: true },
            };
        }
        throw err;
    }
    if (!selected) {
        return {
            status: 'empty',
            reason: 'No upcoming meeting matched the request inside the selected horizon.',
            generatedAt,
            dataFreshness: {
                generatedAt,
                calendarLastSyncAt: isoOrNull(opts.calendarLastSyncAt),
                calendarStatus: safeStatus(opts.calendarStatus),
                sourceHealth,
            },
            safety: {
                contactDetailsOmitted: true,
                readOnly: true,
                noLlmCalls: true,
                noOutreachTriggered: true,
            },
        };
    }

    let attendees;
    try {
        attendees = (selected.attendees || []).filter(a => !isSelfOrEmpty(a)).map(a => safeAttendee(a, selected.id));
    } catch (err) {
        if (err && err.code === 'opaque_ref_unavailable') {
            return {
                status: 'error',
                reason: 'Opaque references are unavailable; meeting prep cannot safely return private calendar context.',
                generatedAt,
                dataFreshness: { generatedAt, sourceHealth },
                safety: { contactDetailsOmitted: true, readOnly: true, noLlmCalls: true, noOutreachTriggered: true },
            };
        }
        throw err;
    }
    let eventRef;
    try {
        eventRef = selected.id ? safeRef('calendar-event', selected.id) : null;
    } catch (err) {
        if (err && err.code === 'opaque_ref_unavailable') {
            return {
                status: 'error',
                reason: 'Opaque references are unavailable; meeting prep cannot safely return private calendar context.',
                generatedAt,
                dataFreshness: { generatedAt, sourceHealth },
                safety: { contactDetailsOmitted: true, readOnly: true, noLlmCalls: true, noOutreachTriggered: true },
            };
        }
        throw err;
    }
    const strongest = attendees.slice().sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))[0] || null;

    return {
        status: 'ok',
        meeting: {
            eventRef,
            title: redactSensitiveString(selected.title || '(No title)'),
            startAt: isoOrNull(selected.startAt),
            endAt: isoOrNull(selected.endAt),
            locationType: locationType(selected.location),
        },
        summary: strongest
            ? 'Prep for ' + strongest.name + ' — ' + (strongest.meetingBrief || strongest.citations[0]?.label || 'review relationship context before the meeting') + '.'
            : 'No matched Minty contacts found for this meeting yet.',
        attendees,
        dataFreshness: {
            generatedAt,
            calendarLastSyncAt: isoOrNull(opts.calendarLastSyncAt),
            calendarStatus: safeStatus(opts.calendarStatus),
            sourceHealth,
        },
        safety: {
            contactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'urls', 'rawLocation', 'rawContact', 'rawContactId', 'rawCalendarEventId', 'rawAttendee', 'description'],
            readOnly: true,
            noLlmCalls: true,
            noOutreachTriggered: true,
        },
    };
}

module.exports = { buildMeetingPrep, selectMeeting, safeAttendee, warmthLabel, redactSensitiveString, locationType, safeRef, sanitizeSourceHealth, sourceNotReadyEnvelope, OpaqueRefUnavailableError, isoOrNull, safeStatus };
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

    const prep = buildMeetingPrep(meetings, { now: NOW, person: 'Alice', horizonHours: 48, sourceHealth: READY_CALENDAR });

    assert.equal(prep.status, 'ok');
    assert.match(prep.meeting.eventRef, /^calendar-event:/);
    assert.equal(prep.meeting.id, undefined);
    assert.equal(JSON.stringify(prep).includes('evt_alice'), false);
});

test('[MeetingPrep]: empty state does not fabricate context or omit freshness', () => {
    const prep = buildMeetingPrep([], {
        now: NOW,
        horizonHours: 48,
        calendarLastSyncAt: '2026-04-30T08:55:00Z',
        calendarStatus: 'ok',
        sourceHealth: { status: 'ok', stale: false, lastSyncAt: '2026-04-30T08:55:00Z', evidenceBearing: true, answerable: true },
    });

    assert.equal(prep.status, 'empty');
    assert.match(prep.reason, /No upcoming meeting/);
    assert.equal(prep.attendees, undefined);
    assert.equal(prep.dataFreshness.calendarStatus, 'ok');
    assert.equal(prep.dataFreshness.sourceHealth.status, 'ok');
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

const PATH_SENTINELS = [
    '/tmp/minty-fixture/meeting_token.json',
    '/tmp/minty-fixture/api_key.json',
    '/tmp/minty-fixture/nested/credential.env',
];

test('[MeetingPrep]: path and secret redaction is order-independent across string fields', () => {
    const prep = buildMeetingPrep([meeting({
        title: PATH_SENTINELS[0],
        location: PATH_SENTINELS[1],
        attendees: [{
            displayName: PATH_SENTINELS[2],
            contactId: 'c_path',
            topics: ['path ' + PATH_SENTINELS[0]],
            openLoops: ['path ' + PATH_SENTINELS[1]],
            meetingBrief: 'path ' + PATH_SENTINELS[2],
        }],
    })], { now: NOW, sourceHealth: READY_CALENDAR });

    const text = JSON.stringify(prep);
    for (const forbidden of PATH_SENTINELS) {
        assert.equal(text.includes(forbidden), false, forbidden);
    }
    assert.match(text, /redacted-(?:secret-)?path/);
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

In `scripts/agent-query.js`, change `loadData()` to read `sync-state.json` from the data directory root, but expose only the calendar fields required by `meeting_prep`. Do not pass the full raw sync state into MCP tool responses.

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
    const calendar = syncState.calendar || {};
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        syncState: {
            calendar: {
                status: calendar.status || 'unknown',
                lastSyncAt: calendar.lastSyncAt || null,
            },
        },
        meetings: Array.isArray(calendar.upcomingMeetings) ? calendar.upcomingMeetings : [],
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

**Objective:** Add the fifth MCP tool and route calls to `buildMeetingPrep()` using loaded calendar data plus sanitized source-health status.

**Files:**
- Modify: `scripts/minty-mcp-server.js:15-68`
- Modify: `scripts/minty-mcp-server.js:95-171`
- Test: `tests/unit/minty-mcp-server.test.js`

**Step 1: Add failing tool-list test**

In `tests/unit/minty-mcp-server.test.js`, update the `tools/list` assertion:

```js
assert.equal(tools.length, 5);
const names = tools.map(t => t.name).sort();
assert.deepEqual(names, ['meeting_prep', 'person_context', 'search_network', 'source_health', 'workflow_brief']);
```

Add a tool definition shape test:

```js
it('meeting_prep has optional eventRef, person, and horizonHours', () => {
    const tool = TOOLS.find(t => t.name === 'meeting_prep');
    assert.ok(tool);
    assert.ok(tool.inputSchema.properties.eventRef);
    assert.equal(tool.inputSchema.properties.meetingId, undefined);
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
const { buildMeetingPrep, isoOrNull, safeStatus } = require('../crm/meeting-prep');
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
            eventRef: { type: 'string', description: 'Optional opaque calendar-event ref returned by a previous meeting_prep call' },
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
    const calendarStatus = safeStatus(syncState.calendar?.status);
    const calendarLastSyncAt = isoOrNull(syncState.calendar?.lastSyncAt);
    const calendarHealth = {
        status: calendarStatus,
        stale: calendarStatus !== 'ok',
        lastSyncAt: calendarLastSyncAt,
        evidenceBearing: Array.isArray(data.meetings || syncState.calendar?.upcomingMeetings),
    };
    const prep = buildMeetingPrep(data.meetings || syncState.calendar?.upcomingMeetings || [], {
        eventRef: args.eventRef,
        person: args.person,
        horizonHours: clampHorizonHours(args.horizonHours, 48),
        calendarLastSyncAt,
        calendarStatus,
        sourceHealth: calendarHealth,
    });
    return { content: [{ type: 'text', text: JSON.stringify(prep, null, 2) }] };
}
```

Do not reuse `clampLimit()` for `horizonHours`; it caps at 50 and would contradict the documented 1–168 hour window.

**Step 4: Add tool-call tests**

Append to `tests/unit/minty-mcp-server.test.js`:

```js
process.env.MINTY_REF_SECRET ||= 'unit-test-only-meeting-prep-ref-secret';

describe('meeting_prep tool', () => {
    it('returns redacted prep for the next meeting', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 50, method: 'tools/call',
            params: { name: 'meeting_prep', arguments: { horizonHours: 48 } },
        }, {
            contacts: CONTACTS,
            insights: INSIGHTS,
            syncState: { calendar: { status: 'ok', lastSyncAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() } },
            meetings: [{
                id: 'evt_1',
                title: 'Alice call @alice_handle',
                startAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                location: 'Zoom https://meet.example.com/private /root/.hermes/google_token.json',
                attendees: [{
                    email: 'alice@example.com',
                    displayName: 'Alice',
                    contactId: 'wa_001',
                    name: 'Alice Müller',
                    relationshipScore: 72,
                    daysSinceContact: 3,
                    topics: ['EU insurance', '@alice_handle'],
                    meetingBrief: 'Warm founder/investor context; see /Users/sree/private/api_key.json never.',
                }],
            }],
        });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.status, 'ok');
        assert.match(parsed.meeting.eventRef, /^calendar-event:/);
        assert.equal(parsed.meeting.id, undefined);
        assert.equal(parsed.dataFreshness.sourceHealth.status, 'ok');
        const serialized = JSON.stringify(parsed);
        for (const forbidden of ['evt_1', 'wa_001', 'alice@example.com', '@alice_handle', 'meet.example.com', '/root/.hermes/google_token.json', '/Users/sree/private/api_key.json']) {
            assert.equal(serialized.includes(forbidden), false, forbidden);
        }
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
Upcoming meeting brief. Input: `{ eventRef?, person?, horizonHours? }`.
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
