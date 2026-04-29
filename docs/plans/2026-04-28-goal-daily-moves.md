# Goal Daily Moves Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn each active Minty goal into one calm, prioritized move for today so the user knows exactly what to do next.

**Architecture:** Add a pure `crm/goal-moves.js` module that scores next actions from three local signals: goal pipeline state, recent engagement, and ranked goal recommendations. Wire the result into `GET /api/today` as `dailyMoves`, then render it above goal cards as the primary action layer. No persistence format changes, no new dependencies, and no runtime LLM calls.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/goals.json`, `contacts.json`, `interactions.json`, `crm/server.js`, inline SPA in `crm/ui.html.js`.

---

## Product framing

Minty's public philosophy says the user opens Minty when they have a goal and need to activate their network, not when they want a dashboard. Sree's private product note sharpens this further: Minty should reveal the hidden leverage in the user's existing network. The current Today view is close, but it still mostly shows ranked people and pipeline controls. The missing product layer is a decision: **what is the one best move for each goal today?**

This plan complements, rather than duplicates, the existing plans:

- `2026-04-27-goal-match-evidence.md` explains why a person matches a goal.
- `2026-04-28-goal-activation-brief.md` groups direct asks and intro paths.
- This plan chooses the next move across goal state: nudge stuck contacts, follow up on ghosted outreach, act on a warm recommendation, or prep for a relevant meeting.

Success criteria:

- `GET /api/today` returns `dailyMoves[]` with at most one top move per active goal.
- Moves are deterministic, grounded only in local JSON, and never framed as generic relationship maintenance.
- The UI promotes daily moves above long lists, with one primary action sentence per goal.
- Existing goal ranking, retro, assignment, and Today behavior remain backward-compatible.

---

### Task 1: Create the pure goal move planner

**Objective:** Add `buildGoalDailyMove()` that chooses one deterministic move from a goal, its retro, and ranked recommendations.

**Files:**
- Create: `crm/goal-moves.js`
- Test: `tests/unit/goal-moves.test.js`

**Step 1: Write failing test**

Create `tests/unit/goal-moves.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildGoalDailyMove } = require('../../crm/goal-moves');

function contact(id, overrides = {}) {
    return {
        id,
        name: id,
        relationshipScore: 50,
        daysSinceContact: null,
        sources: { linkedin: null, googleContacts: null },
        ...overrides,
    };
}

test('[GoalMoves]: nudges stuck pipeline contact before suggesting new people', () => {
    const goal = { id: 'g_1', text: 'raise seed round' };
    const retro = {
        stuck: [contact('c_stuck', { name: 'Maya Partner', relationshipScore: 82, stage: 'Contacted', ageDays: 18 })],
        ghosted: [],
        replied: [],
        aggregate: { totalAssigned: 1 },
    };
    const ranked = [contact('c_new', { name: 'Alex Angel', relationshipScore: 90, goalRelevance: 80 })];

    const move = buildGoalDailyMove(goal, retro, ranked, { now: '2026-04-28T09:00:00Z' });

    assert.equal(move.goalId, 'g_1');
    assert.equal(move.type, 'nudge_stuck');
    assert.equal(move.contact.id, 'c_stuck');
    assert.match(move.label, /Nudge Maya Partner/);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/unit/goal-moves.test.js
```

Expected: FAIL — `Cannot find module '../../crm/goal-moves'`.

**Step 3: Write minimal implementation**

Create `crm/goal-moves.js`:

```js
'use strict';

function summarizeContact(c) {
    if (!c) return null;
    return {
        id: c.id,
        name: c.name || null,
        company: c.company || c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        position: c.position || c.sources?.linkedin?.position || c.sources?.googleContacts?.title || null,
        relationshipScore: c.relationshipScore || 0,
        daysSinceContact: c.daysSinceContact ?? null,
        goalRelevance: c.goalRelevance ?? null,
        stage: c.stage || null,
    };
}

function firstNamed(list) {
    return (Array.isArray(list) ? list : []).find(c => c && c.id && c.name) || null;
}

function buildGoalDailyMove(goal, retro, rankedContacts, opts = {}) {
    if (!goal || !goal.id) return null;
    const ranked = Array.isArray(rankedContacts) ? rankedContacts : [];
    const r = retro || {};

    const stuck = firstNamed(r.stuck);
    if (stuck) {
        return {
            goalId: goal.id,
            goalText: goal.text || '',
            type: 'nudge_stuck',
            priority: 95,
            contact: summarizeContact(stuck),
            label: 'Nudge ' + stuck.name + ' — they are stuck at “' + (stuck.stage || 'this stage') + '”.',
            reason: 'This goal already has a warm path in motion; unblock it before adding more names.',
            generatedAt: new Date(opts.now || Date.now()).toISOString(),
        };
    }

    const ghosted = firstNamed(r.ghosted);
    if (ghosted) {
        return {
            goalId: goal.id,
            goalText: goal.text || '',
            type: 'follow_up_ghosted',
            priority: 85,
            contact: summarizeContact(ghosted),
            label: 'Decide whether to follow up with ' + ghosted.name + ' or drop them from this goal.',
            reason: 'Your last outreach has not received a reply; avoid letting the pipeline silently rot.',
            generatedAt: new Date(opts.now || Date.now()).toISOString(),
        };
    }

    const warm = ranked.find(c => c && c.name && (Number(c.relationshipScore) || 0) >= 60) || firstNamed(ranked);
    if (warm) {
        return {
            goalId: goal.id,
            goalText: goal.text || '',
            type: 'start_direct_ask',
            priority: 70,
            contact: summarizeContact(warm),
            label: 'Ask ' + warm.name + ' about “' + (goal.text || 'this goal') + '”.',
            reason: 'They are the strongest currently visible match for this goal.',
            generatedAt: new Date(opts.now || Date.now()).toISOString(),
        };
    }

    return {
        goalId: goal.id,
        goalText: goal.text || '',
        type: 'no_move',
        priority: 0,
        contact: null,
        label: 'No strong move found for this goal yet.',
        reason: 'Minty needs more synced context or a narrower goal before recommending action.',
        generatedAt: new Date(opts.now || Date.now()).toISOString(),
    };
}

function buildGoalDailyMoves(goals, retrosByGoalId, rankedByGoalId, opts = {}) {
    return (Array.isArray(goals) ? goals : [])
        .filter(g => g && g.active !== false)
        .map(g => buildGoalDailyMove(g, retrosByGoalId?.[g.id], rankedByGoalId?.[g.id], opts))
        .filter(Boolean)
        .sort((a, b) => b.priority - a.priority || String(a.goalText).localeCompare(String(b.goalText)));
}

module.exports = {
    buildGoalDailyMove,
    buildGoalDailyMoves,
    summarizeContact,
};
```

**Step 4: Run test to verify pass**

Run:

```bash
npm test -- tests/unit/goal-moves.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/goal-moves.js tests/unit/goal-moves.test.js
git commit -m "feat: plan daily moves for goals"
```

---

### Task 2: Cover move priority edge cases

**Objective:** Lock the product order: unblock active pipeline first, then handle ghosted outreach, then start a new direct ask.

**Files:**
- Modify: `tests/unit/goal-moves.test.js`
- Modify: `crm/goal-moves.js` only if tests expose a bug

**Step 1: Add edge-case tests**

Append to `tests/unit/goal-moves.test.js`:

```js
test('[GoalMoves]: ghosted contact beats starting a new direct ask', () => {
    const goal = { id: 'g_1', text: 'hire founding designer' };
    const retro = {
        stuck: [],
        ghosted: [contact('c_ghost', { name: 'Ravi Designer', relationshipScore: 72 })],
        replied: [],
    };
    const ranked = [contact('c_new', { name: 'New Designer', relationshipScore: 90, goalRelevance: 91 })];

    const move = buildGoalDailyMove(goal, retro, ranked, { now: '2026-04-28T09:00:00Z' });

    assert.equal(move.type, 'follow_up_ghosted');
    assert.equal(move.contact.id, 'c_ghost');
});

test('[GoalMoves]: warm ranked contact becomes direct ask when pipeline is empty', () => {
    const goal = { id: 'g_2', text: 'enter German crypto market' };
    const ranked = [contact('c_warm', { name: 'Benedek', relationshipScore: 77, goalRelevance: 84 })];

    const move = buildGoalDailyMove(goal, { stuck: [], ghosted: [] }, ranked, { now: '2026-04-28T09:00:00Z' });

    assert.equal(move.type, 'start_direct_ask');
    assert.equal(move.contact.id, 'c_warm');
    assert.match(move.label, /Ask Benedek/);
});

test('[GoalMoves]: returns no_move when there are no usable signals', () => {
    const move = buildGoalDailyMove({ id: 'g_empty', text: 'find niche experts' }, {}, [], { now: '2026-04-28T09:00:00Z' });

    assert.equal(move.type, 'no_move');
    assert.equal(move.contact, null);
});
```

**Step 2: Run targeted tests**

Run:

```bash
npm test -- tests/unit/goal-moves.test.js
```

Expected: PASS. If not, fix `crm/goal-moves.js` rather than weakening the tests.

**Step 3: Run full unit suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

**Step 4: Commit**

```bash
git add crm/goal-moves.js tests/unit/goal-moves.test.js
git commit -m "test: cover goal daily move priorities"
```

---

### Task 3: Wire daily moves into `/api/today`

**Objective:** Return `dailyMoves[]` from `GET /api/today` using existing goal retros and ranked goal contacts.

**Files:**
- Modify: `crm/server.js:386-387`
- Modify: `crm/server.js:3185-3308`
- Test: `tests/unit/goal-pipeline.test.js` or `tests/integration/today.test.js` if a Today integration test already exists

**Step 1: Add a focused API-shape test**

If there is an existing Today integration test, add this assertion there. If not, append this characterization test to `tests/unit/goal-pipeline.test.js`:

```js
test('today daily move shape is built from goal retro and ranked contacts', () => {
    const { buildGoalRetro } = require('../../crm/goal-retro');
    const { buildGoalDailyMoves } = require('../../crm/goal-moves');
    const { rankContactsForGoal } = require('../../crm/utils');

    const goal = {
        id: 'g_1',
        text: 'raise seed round',
        active: true,
        stages: ['To reach out', 'Contacted'],
        assignments: { c_1: { stage: 'Contacted', updatedAt: '2026-04-01T00:00:00Z' } },
    };
    const contacts = [{ id: 'c_1', name: 'Maya VC', relationshipScore: 82, daysSinceContact: 20, sources: { linkedin: { position: 'Partner', company: 'Seedcamp' } } }];
    const retro = buildGoalRetro(goal, contacts, {}, new Set(['me']), new Date('2026-04-28T00:00:00Z'));
    const ranked = rankContactsForGoal(contacts, goal.text, 5);
    const dailyMoves = buildGoalDailyMoves([goal], { [goal.id]: retro }, { [goal.id]: ranked }, { now: '2026-04-28T00:00:00Z' });

    assert.equal(dailyMoves.length, 1);
    assert.equal(dailyMoves[0].goalId, 'g_1');
    assert.ok(dailyMoves[0].label);
});
```

**Step 2: Run test**

Run:

```bash
npm test -- tests/unit/goal-pipeline.test.js
```

Expected: PASS once Tasks 1–2 exist.

**Step 3: Wire server imports**

Near the top of `crm/server.js`, after the existing goal retro import around line 386, add:

```js
const _goalMoves = require('./goal-moves');
```

**Step 4: Build per-goal retros and daily moves**

Inside `handleGetToday()` after `goalSections` is created and before `pulse`, add:

```js
    const rankedByGoalId = Object.fromEntries(goalSections.map(section => [section.goalId, section.contacts]));
    const retrosByGoalId = {};
    try {
        const interactions = fs.existsSync(paths.interactions)
            ? JSON.parse(fs.readFileSync(paths.interactions, 'utf8')) : [];
        const { contactMap } = buildSearchIndex(paths, uuid);
        const byContact = {};
        for (const i of interactions) {
            let cid = null;
            if (i.chatId) cid = contactMap[i.chatId];
            if (!cid && typeof i.from === 'string') cid = contactMap[i.from];
            if (!cid && typeof i.to === 'string') cid = contactMap[i.to];
            if (!cid) continue;
            if (!byContact[cid]) byContact[cid] = [];
            byContact[cid].push({ ...i, _contactId: cid });
        }
        const selfIds = new Set(['me', ...(paths.selfIds || [])]);
        for (const goal of activeGoals) {
            retrosByGoalId[goal.id] = _goalRetro.buildGoalRetro(goal, contacts, byContact, selfIds);
        }
    } catch (e) {
        console.error('[today/daily-moves]', e.message);
    }

    const dailyMoves = _goalMoves.buildGoalDailyMoves(activeGoals, retrosByGoalId, rankedByGoalId);
```

Then add `dailyMoves` to the JSON response:

```js
        dailyMoves,
```

Keep the existing `goals`, `goalSections`, `pulse`, `upcomingMeetings`, `syncWarnings`, and `lifeEvents` keys unchanged.

**Step 5: Run tests**

Run:

```bash
npm test -- tests/unit/goal-pipeline.test.js
npm test
```

Expected: all tests PASS.

**Step 6: Commit**

```bash
git add crm/server.js tests/unit/goal-pipeline.test.js
git commit -m "feat: include daily moves in today API"
```

---

### Task 4: Render daily moves as the first Today section

**Objective:** Make Today lead with the action layer, not a list of people.

**Files:**
- Modify: `crm/ui.html.js:620-660`
- Modify: `crm/ui.html.js:2301-2353`
- Test: `tests/unit/ui-js-syntax.test.js`

**Step 1: Add CSS**

Near the Today card styles in `crm/ui.html.js`, add:

```css
.daily-moves { display: grid; gap: 10px; margin-bottom: 14px; }
.daily-move-card {
  padding: 14px;
  border: 1px solid rgba(99,102,241,0.20);
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(99,102,241,0.10), rgba(17,24,39,0.72));
}
.daily-move-kicker {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 6px;
}
.daily-move-label { color: var(--text-primary); font-size: 14px; line-height: 1.35; }
.daily-move-reason { color: var(--text-secondary); font-size: 12px; line-height: 1.4; margin-top: 6px; }
.daily-move-contact { color: var(--accent-hover); }
```

**Step 2: Add render helper**

Inside the SPA script near Today rendering helpers, add:

```js
function renderDailyMoves(moves) {
  const list = Array.isArray(moves) ? moves.filter(m => m && m.type !== 'no_move').slice(0, 3) : [];
  if (!list.length) return '';
  return '<div class="today-section daily-moves">' + list.map(m => {
    const contact = m.contact && m.contact.name ? '<span class="daily-move-contact">' + esc(m.contact.name) + '</span>' : 'Next move';
    return '<div class="daily-move-card" data-goal-id="' + esc(m.goalId || '') + '">' +
      '<div class="daily-move-kicker">Today · ' + esc(m.goalText || 'Goal') + '</div>' +
      '<div class="daily-move-label">' + esc(m.label || '') + '</div>' +
      (m.reason ? '<div class="daily-move-reason">' + contact + ' · ' + esc(m.reason) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}
```

**Step 3: Render daily moves before the goals strip**

In `renderToday(el)`, after these existing lines:

```js
  const goals     = todayGoals;
  const sections  = (todayData && todayData.goalSections)     || [];
  const pulse     = (todayData && todayData.pulse)            || [];
```

Add:

```js
  const dailyMoves = (todayData && todayData.dailyMoves) || [];
```

Then before `// ---- Goals strip ----`, add:

```js
  html += renderDailyMoves(dailyMoves);
```

**Step 4: Run syntax/unit checks**

Run:

```bash
npm test -- tests/unit/ui-js-syntax.test.js
npm test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add crm/ui.html.js
git commit -m "feat: show daily moves on today view"
```

---

### Task 5: Add e2e smoke coverage for Today daily moves

**Objective:** Ensure the Today view renders daily moves without browser errors when fixture data provides an active goal.

**Files:**
- Modify: `tests/e2e/ui-smoke.stagehand.js` or the existing Today smoke file
- Possibly modify: `tests/e2e/_fixtures.js` if the current seed lacks an active goal with an assigned stale contact

**Step 1: Locate the Today smoke**

Run:

```bash
npm run test:e2e -- --list
```

Expected: Playwright lists existing specs. Choose the smoke that visits the Today/home view.

**Step 2: Seed a daily move if needed**

If fixture data does not naturally produce a move, seed:

- one active goal: `raise seed round`
- one assigned contact in stage `Contacted`
- `updatedAt` at least 15 days before the fixed fixture clock, or a warm ranked contact with `relationshipScore >= 60`

Do not add real user data.

**Step 3: Add a tolerant assertion**

After the Today view loads, add:

```js
await expect(page.locator('.daily-move-card').first()).toBeVisible();
await expect(page.locator('.daily-move-card').first()).toContainText(/Nudge|Ask|follow up|Today/i);
```

**Step 4: Run e2e tests**

Run:

```bash
npm run test:e2e
```

Expected: all e2e tests PASS.

**Step 5: Commit**

```bash
git add tests/e2e
git commit -m "test: smoke today daily moves"
```

---

### Task 6: Tighten public roadmap around action-first Today

**Objective:** Make docs reflect the product shift from ranked recommendations to one prioritized move per goal.

**Files:**
- Modify: `VISION.md:20-29`
- Modify: `ROADMAP.md:17-25`
- Test: documentation-only; verify diff manually

**Step 1: Update `VISION.md`**

Under `### Medium term (v1.x)`, add or adjust one bullet:

```md
- **Action-first Today** — each active goal gets one prioritized move: unblock a stuck warm path, follow up deliberately, or start the best direct ask.
```

**Step 2: Update `ROADMAP.md`**

Under `## Next (v0.3 — Summer 2026)`, add:

```md
- 🧭 **Daily goal moves** — Today leads with one concrete action per goal, not a generic relationship dashboard
```

**Step 3: Verify docs**

Run:

```bash
git diff -- VISION.md ROADMAP.md
```

Expected: only roadmap/vision wording changes.

**Step 4: Commit**

```bash
git add VISION.md ROADMAP.md
git commit -m "docs: position action-first today"
```

---

## Verification checklist

After all tasks:

```bash
npm test
npm run test:e2e
git status --short --branch
```

Expected:

- Unit tests pass.
- E2E smoke tests pass because `crm/ui.html.js` changed.
- Working tree is clean.
- `GET /api/today` returns `dailyMoves[]` with at most one high-priority move per active goal.
- Today view shows the daily moves section before the broader goal recommendation lists.

## Rollback plan

If the action layer feels too prescriptive, keep Tasks 1–3 and revert Tasks 4–5. The `dailyMoves[]` API remains valuable for CLI output, weekly digests, and future notification surfaces while preserving the existing Today UI.
