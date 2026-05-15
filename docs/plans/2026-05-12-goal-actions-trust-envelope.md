# Goal Actions Trust Envelope Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add the same machine-readable trust contract to `goal_next_actions` that Hermes already receives from `search_network`, `person_context`, and `workflow_brief`.

**Architecture:** Keep `goal_next_actions` read-only and local. Extend `crm/agent-goal-actions.js` with small pure helpers that attach opaque citations, confidence driver codes, freshness, and safe source attribution to each non-empty brief; then add MCP boundary tests proving the fields survive JSON serialization without leaking raw goals, contacts, groups, message bodies, or source handles.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing Minty privacy helpers, no new npm dependencies, no runtime LLM/API calls.

---

## Product context

`goal_next_actions` is now the activation surface: Hermes can ask what to do next for a current goal without sending outreach or mutating Minty. The problem is trust asymmetry. Retrieval tools already return structured `citations`, `confidenceDrivers`, `freshness`, `matchedSources`, `answerSources`, and `sourceSummary`; `goal_next_actions` currently returns action prose and scores only. That forces Hermes/OpenClaw to trust labels like “local profile evidence” without proof.

This plan closes that gap without adding another tool or UI surface. The output should remain a safe next-action brief, not a CRM task manager.

## Current-state evidence

On current `main`:

- `scripts/minty-mcp-server.js` exposes 6 tools, including `goal_next_actions`.
- `crm/agent-goal-actions.js` builds briefs with `goal`, `person`, `score`, `pipelineFollowUps`, `introPaths`, and `nextAction`.
- `tests/unit/agent-goal-actions.test.js` verifies prioritization, intro paths, empty states, and redaction, but does not require trust metadata.
- `scripts/minty-mcp-server.js` passes the `buildAgentGoalActions()` envelope through directly, so any raw field added there will cross the MCP boundary unless the builder keeps the envelope safe.

## Non-goals

- No outreach send, draft send, calendar mutation, CRM stage mutation, or contact mutation.
- No external API calls, runtime LLM calls, or new dependencies.
- No new MCP tool and no UI change.
- Do not expose raw goal ids, contact ids, group ids, group names, emails, phones, source handles, interaction ids, message bodies, raw private paths, URLs, or calendar event ids.
- Do not fabricate trust metadata for empty states.

## Acceptance criteria

- Every non-empty `goal_next_actions.briefs[]` item includes:
  - `citations`: non-empty array of opaque refs when the action has supporting local profile, pipeline, warmth, or intro evidence.
  - `confidenceDrivers`: allowlisted reason codes.
  - `freshness`: `{ daysSinceContact, latestEvidenceAt, stale }` with safe ISO/null values only.
  - `matchedSources`, `answerSources`, and `sourceSummary` derived from safe source labels.
- Empty states keep `briefs: []` and do not invent per-brief trust fields.
- MCP output preserves the fields above for `goal_next_actions`.
- Serialized unit/MCP output excludes raw ids/details listed in Non-goals.
- Existing `search_network`, `person_context`, `workflow_brief`, `source_health`, and `meeting_prep` contracts remain unchanged.

---

### Task 1: Add failing pure tests for trust metadata on pipeline follow-ups

**Objective:** Prove a pipeline follow-up action carries machine-readable trust metadata without leaking raw goal/contact data.

**Files:**
- Modify: `tests/unit/agent-goal-actions.test.js`
- Later modify: `crm/agent-goal-actions.js`

**Step 1: Write failing test**

Append this test after the existing pipeline prioritization test:

```js
test('[AgentGoalActions]: annotates pipeline follow-ups with trust metadata', () => {
    const goals = [{
        id: 'raw-goal-id-trust',
        text: 'raise seed round',
        active: true,
        assignments: { c_pipeline: { stage: 'contacted', updatedAt: '2026-04-10T00:00:00Z' } },
    }];
    const contacts = [contact('c_pipeline', {
        name: 'Maya Partner',
        relationshipScore: 82,
        daysSinceContact: 12,
        lastContactedAt: '2026-04-22T09:00:00Z',
        sources: {
            linkedin: {
                id: 'raw-linkedin-handle',
                company: 'Example Capital',
                position: 'Partner',
            },
        },
    })];

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships: {} }, {
        now: '2026-05-04T09:00:00Z',
    });

    const brief = out.briefs[0];
    assert.equal(out.status, 'ok');
    assert.deepEqual(brief.matchedSources, ['linkedin']);
    assert.deepEqual(brief.answerSources, ['LinkedIn']);
    assert.equal(brief.sourceSummary, 'LinkedIn');
    assert.deepEqual(brief.confidenceDrivers, ['pipeline_assignment', 'warm_relationship', 'recent_or_known_contact']);
    assert.deepEqual(brief.freshness, {
        daysSinceContact: 12,
        latestEvidenceAt: '2026-04-22T09:00:00Z',
        stale: false,
    });
    assert.ok(Array.isArray(brief.citations));
    assert.ok(brief.citations.length >= 2);
    assert.ok(brief.citations.every(c => /^brief:1:cite:\d+$/.test(c.ref)));
    assert.ok(brief.citations.some(c => c.supports === 'pipeline'));
    assert.ok(brief.citations.some(c => c.supports === 'warmth'));

    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('raw-goal-id-trust'), false);
    assert.equal(serialized.includes('c_pipeline'), false);
    assert.equal(serialized.includes('raw-linkedin-handle'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: FAIL because `matchedSources`, `answerSources`, `sourceSummary`, `confidenceDrivers`, `freshness`, and `citations` are missing from briefs.

**Step 3: Commit nothing yet**

Do not commit failing tests alone unless the builder explicitly uses one-commit-per-task TDD. If committing per task, commit after Task 2 goes green.

---

### Task 2: Implement safe trust metadata helpers for direct contact actions

**Objective:** Attach structured trust metadata to pipeline follow-up and new-ask briefs using only safe contact/source/profile fields.

**Files:**
- Modify: `crm/agent-goal-actions.js`
- Test: `tests/unit/agent-goal-actions.test.js`

**Step 1: Add constants and helper functions**

In `crm/agent-goal-actions.js`, near the imports, add safe source labels and driver allowlists:

```js
const SOURCE_DISPLAY_LABELS = Object.freeze({
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    email: 'Email',
    sms: 'SMS',
    linkedin: 'LinkedIn',
    googlecontacts: 'Google Contacts',
    slack: 'Slack',
});

const SAFE_CONFIDENCE_DRIVERS = new Set([
    'pipeline_assignment',
    'warm_relationship',
    'recent_or_known_contact',
    'stale_contact_penalty',
    'profile_match',
    'intro_path',
]);
```

Add these pure helpers before `pipelineFollowUps()`:

```js
function safeSourceKey(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key === 'googlecontacts' || key === 'googlecontact') return 'googlecontacts';
    return SOURCE_DISPLAY_LABELS[key] ? key : null;
}

function contactSourceKeys(contact) {
    const keys = new Set();
    if (contact && isPlainObject(contact.sources)) {
        for (const raw of Object.keys(contact.sources)) {
            const key = safeSourceKey(raw);
            if (key) keys.add(key);
        }
    }
    if (Array.isArray(contact && contact.activeChannels)) {
        for (const raw of contact.activeChannels) {
            const key = safeSourceKey(raw);
            if (key) keys.add(key);
        }
    }
    return [...keys].sort();
}

function sourceLabels(keys) {
    return [...new Set((keys || []).map(safeSourceKey).filter(Boolean).map(k => SOURCE_DISPLAY_LABELS[k]))];
}

function safeLatestEvidenceAt(contact) {
    const candidates = [
        safeIso(contact && contact.lastContactedAt),
        safeIso(contact && contact.updatedAt),
        safeIso(contact && contact.createdAt),
    ].filter(Boolean).sort();
    return candidates.length ? candidates[candidates.length - 1] : null;
}

function trustFreshness(contact, oldestAllowedDays = 180) {
    const rawDays = Number(contact && contact.daysSinceContact);
    const daysSinceContact = Number.isFinite(rawDays) && rawDays >= 0 ? Math.floor(rawDays) : null;
    return {
        daysSinceContact,
        latestEvidenceAt: safeLatestEvidenceAt(contact),
        stale: daysSinceContact == null ? null : daysSinceContact > oldestAllowedDays,
    };
}

function confidenceDriversForContact(contact, extra = [], options = {}) {
    const drivers = [];
    for (const code of extra) {
        if (SAFE_CONFIDENCE_DRIVERS.has(code)) drivers.push(code);
    }
    if (options.includeContactDrivers === false) return [...new Set(drivers)];
    if ((Number(contact && contact.relationshipScore) || 0) >= 50) drivers.push('warm_relationship');
    const fresh = trustFreshness(contact);
    if (fresh.stale === false) drivers.push('recent_or_known_contact');
    if (fresh.stale === true) drivers.push('stale_contact_penalty');
    return [...new Set(drivers)];
}

function buildCitations(entries) {
    const citations = [];
    for (const entry of entries || []) {
        if (!entry || typeof entry !== 'object') continue;
        const supports = typeof entry.supports === 'string' ? entry.supports : null;
        if (!['pipeline', 'profile', 'warmth', 'freshness', 'intro_path'].includes(supports)) continue;
        citations.push({
            ref: `brief:1:cite:${citations.length + 1}`,
            source: entry.source === 'goal' ? 'goal' : entry.source === 'graph' ? 'graph' : 'contact',
            field: typeof entry.field === 'string' ? entry.field : 'local',
            provenance: entry.provenance === 'derived-local' ? 'derived-local' : 'local-contact',
            observedAt: safeIso(entry.observedAt) || null,
            supports,
        });
    }
    return citations;
}

function withTrustMetadata(brief, contact, options = {}) {
    const matchedSources = contactSourceKeys(contact);
    const answerSources = sourceLabels(matchedSources);
    const sourceSummary = answerSources.length ? answerSources.join(', ') : 'Local profile';
    const freshness = trustFreshness(contact);
    const confidenceDrivers = confidenceDriversForContact(contact, options.confidenceDrivers || [], options);
    const citations = buildCitations([
        ...(options.citations || []),
        { source: 'contact', field: 'relationshipScore', supports: 'warmth', observedAt: freshness.latestEvidenceAt, provenance: 'derived-local' },
        { source: 'contact', field: 'daysSinceContact', supports: 'freshness', observedAt: freshness.latestEvidenceAt, provenance: 'derived-local' },
    ]);
    return {
        ...brief,
        citations,
        confidenceDrivers,
        freshness,
        matchedSources,
        answerSources,
        sourceSummary,
    };
}
```

**Important adjustment:** `buildCitations()` above starts with `brief:1` only as a temporary TDD scaffold for the first single-brief test. Task 3 must be implemented before the feature branch is considered mergeable; do not expose or ship an intermediate state where multiple final briefs can share `brief:1` citation refs.

**Step 2: Wrap pipeline and new-ask briefs**

In `pipelineFollowUps()`, wrap the pushed object:

```js
const brief = {
    goal: { text: redact(goal.text) },
    goalRef,
    person: safePerson(contact),
    score: Math.round(score),
    pipelineFollowUps: [{ stage, ageDays, updatedAt }],
    introPaths: [],
    nextAction: {
        type: 'pipeline_follow_up',
        label: `Follow up with ${displayName(contact)} on ${redact(goal.text)}`,
        reason: `Existing goal pipeline is in ${stage}${ageDays == null ? '' : ` and has not moved for ${ageDays} days`}.`,
    },
};
out.push(withTrustMetadata(brief, contact, {
    confidenceDrivers: ['pipeline_assignment'],
    citations: [{
        source: 'goal',
        field: 'assignments.stage',
        supports: 'pipeline',
        observedAt: updatedAt,
        provenance: 'derived-local',
    }],
}));
```

In `newAskActions()`, wrap each mapped brief:

```js
return rankContactsForGoal(contacts, goal.text, 8).map(contact => {
    const brief = {
        goal: { text: redact(goal.text) },
        goalRef,
        person: safePerson(contact),
        score: Math.round(70 + (Number(contact.goalRelevance) || 0) / 2 + Math.min(20, Number(contact.relationshipScore) || 0) / 5),
        pipelineFollowUps: [],
        introPaths: [],
        nextAction: {
            type: 'new_ask',
            label: `Ask ${displayName(contact)} about ${redact(goal.text)}`,
            reason: 'Contact appears relevant to the active goal based on local profile evidence.',
        },
    };
    return withTrustMetadata(brief, contact, {
        confidenceDrivers: ['profile_match'],
        citations: [{
            source: 'contact',
            field: 'profile',
            supports: 'profile',
            observedAt: safeLatestEvidenceAt(contact),
            provenance: 'local-contact',
        }],
    });
});
```

**Step 3: Run narrow test**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: PASS for the new pipeline metadata test and existing tests.

**Step 4: Commit**

```bash
git add crm/agent-goal-actions.js tests/unit/agent-goal-actions.test.js
git commit -m "feat: add trust metadata to goal action follow-ups"
```

---

### Task 3: Renumber citations after sorting and dedupe

**Objective:** Ensure citation refs are stable per final brief position, not accidentally duplicated as `brief:1` after sorting.

**Files:**
- Modify: `crm/agent-goal-actions.js`
- Modify: `tests/unit/agent-goal-actions.test.js`

**Step 1: Add failing regression test**

Append:

```js
test('[AgentGoalActions]: citation refs are stable per final brief order', () => {
    const goals = [{
        text: 'raise seed',
        active: true,
        assignments: {
            c_one: { stage: 'contacted', updatedAt: '2026-04-20T00:00:00Z' },
            c_two: { stage: 'contacted', updatedAt: '2026-04-01T00:00:00Z' },
        },
    }];
    const contacts = [
        contact('c_one', { name: 'One Investor', relationshipScore: 60, daysSinceContact: 3, lastContactedAt: '2026-05-01T00:00:00Z' }),
        contact('c_two', { name: 'Two Investor', relationshipScore: 80, daysSinceContact: 10, lastContactedAt: '2026-04-24T00:00:00Z' }),
    ];

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships: {} }, {
        now: '2026-05-04T09:00:00Z',
        limit: 2,
    });

    assert.equal(out.briefs.length, 2);
    assert.ok(out.briefs[0].citations.every(c => c.ref.startsWith('brief:1:cite:')));
    assert.ok(out.briefs[1].citations.every(c => c.ref.startsWith('brief:2:cite:')));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: FAIL if both briefs still have `brief:1` citation refs.

**Step 3: Implement final citation renumbering**

Add this helper near the dedupe logic:

```js
function renumberBriefCitations(brief, briefIndex) {
    if (!Array.isArray(brief.citations)) return brief;
    return {
        ...brief,
        citations: brief.citations.map((citation, citationIndex) => ({
            ...citation,
            ref: `brief:${briefIndex + 1}:cite:${citationIndex + 1}`,
        })),
    };
}
```

In `buildAgentGoalActions()`, change the return to renumber after sorting/deduping:

```js
const finalBriefs = deduped.map(renumberBriefCitations);
return {
    status: finalBriefs.length ? 'ok' : 'empty',
    confidence: finalBriefs.length ? 'medium' : 'low',
    briefs: finalBriefs,
    ...(finalBriefs.length ? {} : { reason: 'No safe goal actions found.' }),
    safety,
};
```

**Step 4: Run test**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-goal-actions.js tests/unit/agent-goal-actions.test.js
git commit -m "fix: stabilize goal action citation refs"
```

---

### Task 4: Add trust metadata for warm-intro actions without leaking group evidence

**Objective:** Warm-intro recommendations should show graph/provenance confidence while keeping group ids and group names redacted.

**Files:**
- Modify: `tests/unit/agent-goal-actions.test.js`
- Modify: `crm/agent-goal-actions.js`

**Step 1: Expand the existing warm-intro test**

In `[AgentGoalActions]: includes warm intro path when direct relationship is cold`, add these assertions after the existing intro path assertions:

```js
assert.deepEqual(out.briefs[0].confidenceDrivers, ['intro_path']);
assert.ok(out.briefs[0].citations.some(c => c.source === 'graph' && c.supports === 'intro_path'));
assert.deepEqual(out.briefs[0].freshness.daysSinceContact, null);
assert.ok(Array.isArray(out.briefs[0].matchedSources));
assert.ok(Array.isArray(out.briefs[0].answerSources));
assert.equal(typeof out.briefs[0].sourceSummary, 'string');
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: FAIL until warm-intro briefs are wrapped with trust metadata.

**Step 3: Wrap warm-intro briefs**

In `warmIntroActions()`, replace `out.push({ ... })` with:

```js
const brief = {
    goal: { text: redact(goal.text) },
    goalRef,
    person: safePerson(target),
    score: Math.round(125 + top.pathScore + (target.goalRelevance || 0) / 2),
    pipelineFollowUps: [],
    introPaths: [{
        target: safePerson(target),
        intermediary: {
            name: redact(top.intermediaryName),
            ...(top.intermediaryTitle ? { title: redact(top.intermediaryTitle) } : {}),
            ...(top.intermediaryCompany ? { company: redact(top.intermediaryCompany) } : {}),
            warmth: warmthLabel(top.intermediaryScore),
        },
        sharedContext: 'shared private group membership',
    }],
    nextAction: {
        type: 'warm_intro_request',
        label: `Ask ${redact(top.intermediaryName)} for a warm intro to ${displayName(target)}`,
        reason: 'Target is goal-relevant but cold; a warmer mutual connection exists through local group evidence.',
    },
};
out.push(withTrustMetadata(brief, target, {
    includeContactDrivers: false,
    confidenceDrivers: ['intro_path'],
    citations: [{
        source: 'graph',
        field: 'shared_private_group_membership',
        supports: 'intro_path',
        observedAt: safeLatestEvidenceAt(target),
        provenance: 'derived-local',
    }],
}));
```

For warm-intro actions, make sure `confidenceDriversForContact()` does not automatically add `warm_relationship` for the cold target. If the target is cold, the only driver should be `intro_path`; if it is stale, `stale_contact_penalty` is acceptable but update the assertion to the exact intended behavior.

**Step 4: Run test**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/agent-goal-actions.js tests/unit/agent-goal-actions.test.js
git commit -m "feat: add trust metadata to intro goal actions"
```

---

### Task 5: Verify MCP preserves the goal action trust envelope

**Objective:** Prove the Hermes/OpenClaw boundary receives the trust fields and still redacts raw private data.

**Files:**
- Modify: `tests/unit/minty-mcp-server.test.js`
- Later modify only if needed: `scripts/minty-mcp-server.js`

**Step 1: Expand the existing MCP goal action test**

In `tests/unit/minty-mcp-server.test.js`, inside `goal_next_actions tool` → `returns redacted read-only goal action briefs through MCP`, first add safe freshness fields to the contact fixture so the boundary test proves non-null freshness:

```js
daysSinceContact: 20,
lastContactedAt: '2026-04-14T09:00:00Z',
```

Then add these assertions after `assert.equal(parsed.safety.noOutreachTriggered, true);`:

```js
assert.ok(Array.isArray(parsed.briefs[0].citations));
assert.ok(parsed.briefs[0].citations.every(c => /^brief:1:cite:\d+$/.test(c.ref)));
assert.deepEqual(parsed.briefs[0].confidenceDrivers, ['pipeline_assignment', 'warm_relationship', 'recent_or_known_contact']);
assert.deepEqual(parsed.briefs[0].matchedSources, ['linkedin']);
assert.deepEqual(parsed.briefs[0].answerSources, ['LinkedIn']);
assert.equal(parsed.briefs[0].sourceSummary, 'LinkedIn');
assert.deepEqual(parsed.briefs[0].freshness, {
    daysSinceContact: 20,
    latestEvidenceAt: '2026-04-14T09:00:00Z',
    stale: false,
});
```

**Step 2: Run test**

Run:

```bash
node --test tests/unit/minty-mcp-server.test.js
```

Expected: PASS if MCP direct pass-through is already safe. If it fails because fields are missing, inspect whether `buildAgentGoalActions()` was called with the right `contacts` data. If it fails because raw data appears, do not add a broad allowlist in MCP; fix the pure envelope in `crm/agent-goal-actions.js`.

**Step 3: Commit**

```bash
git add tests/unit/minty-mcp-server.test.js scripts/minty-mcp-server.js crm/agent-goal-actions.js
git commit -m "test: preserve goal action trust metadata over MCP"
```

---

### Task 6: Add explicit empty-state and privacy regression tests

**Objective:** Lock the boundary: no trust metadata is fabricated for empty results, and raw private fields stay out of serialized output.

**Files:**
- Modify: `tests/unit/agent-goal-actions.test.js`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Tighten pure empty-state test**

In `[AgentGoalActions]: redacts direct contact details and returns honest empty state`, add:

```js
assert.equal(out.briefs.some(b => b.citations || b.freshness || b.matchedSources), false);
assert.equal(out.answerability, undefined);
```

**Step 2: Add MCP privacy regression for source/group/message leaks**

Append to the `goal_next_actions tool` describe block:

```js
it('does not leak raw source handles, group data, or message bodies in trusted goal actions', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0',
        id: 1202,
        method: 'tools/call',
        params: { name: 'goal_next_actions', arguments: { goal: 'target investor', limit: 3 } },
    }, {
        nowForTests: '2026-05-04T09:00:00Z',
        goals: [{ id: 'raw-goal-id-intro', text: 'target investor', active: true }],
        contacts: [
            {
                id: 'raw-target-id',
                name: 'Target Investor',
                relationshipScore: 10,
                emails: ['target-secret@example.com'],
                phones: ['raw-phone-555-0101'],
                sources: { linkedin: { id: 'raw-target-linkedin', company: 'Target Capital', position: 'Partner' } },
                groupMemberships: [{ chatId: 'raw-group-id@g.us' }],
            },
            {
                id: 'raw-warm-id',
                name: 'Warm Founder',
                relationshipScore: 85,
                sources: { whatsapp: { id: 'raw-whatsapp-handle' } },
                groupMemberships: [{ chatId: 'raw-group-id@g.us' }],
            },
        ],
        interactions: [{ id: 'raw-message-id', contactId: 'raw-target-id', body: 'raw private message body' }],
        groupMemberships: {
            'raw-group-id@g.us': { name: 'Secret Group Name', members: ['raw-target-id', 'raw-warm-id'] },
        },
    });

    const parsed = JSON.parse(resp.result.content[0].text);
    const serialized = JSON.stringify(parsed);
    assert.equal(parsed.status, 'ok');
    assert.ok(parsed.briefs.some(b => b.nextAction.type === 'warm_intro_request'));
    assert.equal(serialized.includes('raw-target-id'), false);
    assert.equal(serialized.includes('raw-warm-id'), false);
    assert.equal(serialized.includes('raw-group-id'), false);
    assert.equal(serialized.includes('Secret Group Name'), false);
    assert.equal(serialized.includes('target-secret@example.com'), false);
    assert.equal(serialized.includes('raw-phone-555-0101'), false);
    assert.equal(serialized.includes('raw-target-linkedin'), false);
    assert.equal(serialized.includes('raw-whatsapp-handle'), false);
    assert.equal(serialized.includes('raw private message body'), false);
});
```

**Step 3: Run narrow tests**

Run:

```bash
node --test tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js crm/agent-goal-actions.js scripts/minty-mcp-server.js
git commit -m "test: guard goal action trust envelope privacy"
```

---

### Task 7: Run final verification

**Objective:** Verify the full repo still passes and no docs/tool contract drift was introduced.

**Files:**
- No code changes unless tests reveal a real issue.

**Step 1: Run targeted tests**

```bash
node --test tests/unit/agent-goal-actions.test.js
node --test tests/unit/minty-mcp-server.test.js
node --test tests/unit/agent-surface-docs.test.js
```

Expected: all pass.

**Step 2: Run full unit/integration suite**

```bash
npm test
```

Expected: all pass.

**Step 3: Decide whether e2e is required**

This plan should not touch routes or `crm/ui.html.js`, so `npm run test:e2e` is optional. Run it only if the implementation expands into route/UI behavior.

**Step 4: Final commit if needed**

If final verification required small fixes:

```bash
git add crm/agent-goal-actions.js scripts/minty-mcp-server.js tests/unit/agent-goal-actions.test.js tests/unit/minty-mcp-server.test.js
git commit -m "fix: complete goal action trust envelope"
```

---

## Implementation notes and pitfalls

- Keep `goalRef` opaque (`goal:1`) and do not expose source goal ids.
- Citation refs must be opaque and position-based (`brief:N:cite:M`), not derived from contact ids, group ids, or source ids.
- `sourceSummary` must come from canonical safe source labels only; never from raw source handles or group names.
- `latestEvidenceAt` may be `null`; do not parse loose dates or normalize invalid dates via JavaScript rollover.
- Empty states should remain honest: no action means no per-brief trust metadata.
- MCP currently passes `goal_next_actions` through directly. That is acceptable only if `crm/agent-goal-actions.js` owns a fully safe envelope and MCP tests prove it.
- If the builder chooses to reuse helpers from `crm/agent-retrieval.js`, first export them intentionally and add drift tests. Prefer local small helpers to avoid changing retrieval contracts.

## Final verification checklist

- [ ] `node --test tests/unit/agent-goal-actions.test.js` passes.
- [ ] `node --test tests/unit/minty-mcp-server.test.js` passes.
- [ ] `node --test tests/unit/agent-surface-docs.test.js` passes.
- [ ] `npm test` passes.
- [ ] Serialized fixtures do not contain raw ids, emails, phones, source handles, group names, message bodies, URLs, private paths, or event ids.
- [ ] No outreach, provider mutation, runtime LLM, cron, or dependency change was introduced.
