# Goal Match Evidence Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Minty's goal-first recommendations explain why each person can help and whether the connection is warm enough to act on now.

**Architecture:** Extend the existing pure goal-ranking logic in `crm/utils.js` so scoring returns structured evidence without changing the score contract. Surface that evidence through the existing `/api/today` goal sections and render it as compact human chips on Today cards; no runtime LLM calls, no new dependencies, and no new persistence format.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, inline SPA in `crm/ui.html.js`, existing JSON data in `data/unified/`.

---

## Product framing

Minty's philosophy says the home loop is not “people you have not spoken to”; it is “given my active goal, who can move the needle?” The current implementation ranks contacts for a goal (`scoreContactForGoal`, `rankContactsForGoal`) but the UI can only show a relevance number. That creates a trust gap: Sree sees “Jane — 72” but not “Partner at Index · warm enough to ask · last spoke 12 days ago.” This plan closes that gap with deterministic, inspectable evidence.

Success criteria:
- A user can look at a goal card and immediately understand the recommendation.
- Evidence is grounded only in contact metadata already present locally.
- Scores remain backward-compatible for existing callers and tests.
- The UI stays calm: 2–3 chips, not a dense analytics row.

---

### Task 1: Add pure goal evidence helper

**Objective:** Introduce `explainContactForGoal(contact, goalText)` that returns structured reasons while leaving `scoreContactForGoal()` unchanged.

**Files:**
- Modify: `crm/utils.js:350-520`
- Test: `tests/unit/goals.test.js`

**Step 1: Write failing test**

Append to `tests/unit/goals.test.js`:

```js
test('[Goals]: explains fundraise matches with role and warmth evidence', () => {
    const investor = makeContact({
        name: 'Maya Patel',
        sources: { linkedin: { company: 'Index Ventures', position: 'Partner' } },
        relationshipScore: 82,
        daysSinceContact: 12,
    });

    const { explainContactForGoal } = require('../../crm/utils');
    const explanation = explainContactForGoal(investor, 'raise seed round from venture investors');

    assert.equal(explanation.score, scoreContactForGoal(investor, 'raise seed round from venture investors'));
    assert.ok(explanation.reasons.some(r => r.type === 'role' && /investor/i.test(r.label)));
    assert.ok(explanation.reasons.some(r => r.type === 'access' && /warm/i.test(r.label)));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/unit/goals.test.js
```

Expected: FAIL — `explainContactForGoal is not a function`.

**Step 3: Write minimal implementation**

In `crm/utils.js`, above `scoreContactForGoal()`, add reusable helpers:

```js
function goalContactText(contact) {
    return [
        contact.name || '',
        contact.company || '',
        contact.position || '',
        (contact.apollo && contact.apollo.headline) || '',
        (contact.apollo && contact.apollo.industry) || '',
        (contact.sources && contact.sources.linkedin && contact.sources.linkedin.company) || '',
        (contact.sources && contact.sources.linkedin && contact.sources.linkedin.position) || '',
    ].join(' ').toLowerCase();
}

function detectGoalIntentRoles(goalText) {
    const lower = String(goalText || '').toLowerCase();
    let intentRoles = [];
    if (/\b(fund|raise|invest|round|capital|vc|seed|series|angel|pitch)\b/.test(lower)) {
        intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.fundraise);
    }
    if (/\b(hire|hiring|recruit|talent|engineer|developer|cto|coo|team)\b/.test(lower)) {
        intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.hire);
    }
    if (/\b(market|sales|customer|client|business|expansion|growth|revenue)\b/.test(lower)) {
        intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.market);
    }
    if (/\b(advisor|advice|mentor|expert|consult|strategy)\b/.test(lower)) {
        intentRoles = intentRoles.concat(GOAL_INTENT_ROLES.advisor);
    }
    return [...new Set(intentRoles)];
}

function goalKeywords(goalText) {
    const stopWords = new Set([
        'raise', 'find', 'hire', 'need', 'want', 'help', 'with', 'into', 'that', 'from',
        'for', 'and', 'the', 'our', 'my', 'get', 'use', 'make', 'have', 'some', 'are',
        'can', 'who', 'new', 'all', 'not', 'any', 'but', 'how',
    ]);
    return String(goalText || '').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
}

function relationshipAccessLabel(score) {
    const s = Number(score || 0);
    if (s >= 75) return 'Warm enough to ask';
    if (s >= 50) return 'Good access';
    if (s >= 25) return 'Needs a warm-up';
    return 'Cold access';
}
```

Then add:

```js
function explainContactForGoal(contact, goalText) {
    const score = scoreContactForGoal(contact, goalText);
    if (!contact || !goalText || score === 0) return { score, reasons: [] };

    const contactText = goalContactText(contact);
    const reasons = [];

    for (const role of detectGoalIntentRoles(goalText)) {
        const signals = GOAL_ROLE_SIGNALS[role] || [];
        const matched = signals.find(s => contactText.includes(s));
        if (matched) {
            reasons.push({ type: 'role', label: role[0].toUpperCase() + role.slice(1) + ' signal', detail: matched });
            break;
        }
    }

    const keywords = goalKeywords(goalText).filter(w => contactText.includes(w));
    if (keywords.length > 0) {
        reasons.push({ type: 'keyword', label: 'Matches ' + keywords.slice(0, 2).join(', '), detail: keywords.slice(0, 5).join(', ') });
    }

    reasons.push({
        type: 'access',
        label: relationshipAccessLabel(contact.relationshipScore),
        detail: String(contact.relationshipScore || 0) + '/100 relationship score',
    });

    if (contact.daysSinceContact != null) {
        const days = Number(contact.daysSinceContact);
        reasons.push({ type: 'recency', label: days === 0 ? 'Spoke today' : 'Spoke ' + days + 'd ago', detail: String(days) + ' days since contact' });
    }

    return { score, reasons: reasons.slice(0, 4) };
}
```

Finally export `explainContactForGoal` in `module.exports`.

**Step 4: Run test to verify pass**

Run:

```bash
npm test -- tests/unit/goals.test.js
```

Expected: PASS for `tests/unit/goals.test.js`.

**Step 5: Commit**

```bash
git add crm/utils.js tests/unit/goals.test.js
git commit -m "feat: explain goal contact matches"
```

---

### Task 2: Refactor goal scoring to share evidence helpers

**Objective:** Remove duplicated parsing logic so `scoreContactForGoal()` and `explainContactForGoal()` cannot drift.

**Files:**
- Modify: `crm/utils.js:393-448`
- Test: `tests/unit/goals.test.js`

**Step 1: Write failing/guard test**

Append to `tests/unit/goals.test.js`:

```js
test('[Goals]: score and explanation stay aligned for keyword-only matches', () => {
    const fintech = makeContact({
        sources: { linkedin: { company: 'Stripe', position: 'Head of Product' } },
        apollo: { headline: 'Building fintech payments infrastructure', industry: 'fintech' },
        relationshipScore: 0,
    });

    const { explainContactForGoal } = require('../../crm/utils');
    const goal = 'break into fintech payments market';

    assert.equal(explainContactForGoal(fintech, goal).score, scoreContactForGoal(fintech, goal));
    assert.ok(explainContactForGoal(fintech, goal).reasons.some(r => r.type === 'keyword'));
});
```

**Step 2: Run targeted test**

Run:

```bash
npm test -- tests/unit/goals.test.js
```

Expected: PASS or FAIL depending on Task 1 implementation; if it passes already, treat this as a characterization guard.

**Step 3: Refactor implementation**

Replace the duplicated contact text, intent role, and goal word blocks inside `scoreContactForGoal()` with calls to the new helpers:

```js
function scoreContactForGoal(contact, goalText) {
    if (!goalText || !contact) return 0;

    const contactText = goalContactText(contact);
    let score = 0;

    const intentRoles = detectGoalIntentRoles(goalText);
    if (intentRoles.length > 0) {
        for (const role of intentRoles) {
            const signals = GOAL_ROLE_SIGNALS[role] || [];
            if (signals.some(s => contactText.includes(s))) {
                score += 40;
                break;
            }
        }
    }

    const matchCount = goalKeywords(goalText).filter(w => contactText.includes(w)).length;
    score += Math.min(40, matchCount * 12);
    score += Math.min(20, Math.round((contact.relationshipScore || 0) / 5));

    return Math.min(100, Math.round(score));
}
```

**Step 4: Run tests**

Run:

```bash
npm test -- tests/unit/goals.test.js
npm test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add crm/utils.js tests/unit/goals.test.js
git commit -m "refactor: share goal scoring evidence helpers"
```

---

### Task 3: Attach explanations to ranked goal contacts

**Objective:** Make `rankContactsForGoal()` include `goalReasons` so downstream API/UI code does not need to recompute explanations.

**Files:**
- Modify: `crm/utils.js:450-468`
- Test: `tests/unit/goals.test.js`

**Step 1: Write failing test**

Append to `tests/unit/goals.test.js`:

```js
test('[Goals]: ranked contacts include compact goal reasons', () => {
    const investor = makeContact({
        sources: { linkedin: { company: 'Seedcamp', position: 'Investor' } },
        relationshipScore: 70,
    });

    const [result] = rankContactsForGoal([investor], 'raise seed round');

    assert.ok(Array.isArray(result.goalReasons));
    assert.ok(result.goalReasons.length > 0);
    assert.ok(result.goalReasons.length <= 4);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/unit/goals.test.js
```

Expected: FAIL — `goalReasons` is missing.

**Step 3: Write minimal implementation**

Change the `.map()` in `rankContactsForGoal()` to compute once:

```js
.map(c => {
    const explanation = explainContactForGoal(c, goalText);
    return { ...c, goalRelevance: explanation.score, goalReasons: explanation.reasons };
})
```

**Step 4: Run tests**

Run:

```bash
npm test -- tests/unit/goals.test.js
npm test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add crm/utils.js tests/unit/goals.test.js
git commit -m "feat: include evidence with goal rankings"
```

---

### Task 4: Render goal evidence chips on Today cards

**Objective:** Show 2–3 concise evidence chips under each goal recommendation in the Today view.

**Files:**
- Modify: `crm/ui.html.js:412-430` and `crm/ui.html.js:2390-2425`
- Test: `tests/e2e/` smoke coverage if existing Today view test can be extended; otherwise add a unit-free DOM smoke only if there is an established helper.

**Step 1: Add CSS**

Near the goal card styles in `crm/ui.html.js`, add:

```css
.goal-reasons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.goal-reason-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid rgba(99,102,241,0.22);
  border-radius: 999px;
  background: rgba(99,102,241,0.08);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.2;
}
.goal-reason-chip.access { border-color: rgba(34,197,94,0.22); background: rgba(34,197,94,0.08); }
.goal-reason-chip.recency { border-color: rgba(245,158,11,0.20); background: rgba(245,158,11,0.07); }
```

**Step 2: Render chips**

Inside the `section.contacts.forEach(c => { ... })` card template, before the stage selector row, add:

```js
const goalReasons = Array.isArray(c.goalReasons) ? c.goalReasons.slice(0, 3) : [];
const reasonHtml = goalReasons.length
  ? '<div class="goal-reasons">' + goalReasons.map(r => '<span class="goal-reason-chip ' + esc(r.type || '') + '" title="' + esc(r.detail || r.label || '') + '">' + esc(r.label || '') + '</span>').join('') + '</div>'
  : '';
```

Then include `${reasonHtml}` under the contact metadata line, before `today-card-stage-row`.

**Step 3: Manual browser verification**

Run:

```bash
npm run crm
```

Open `http://localhost:3456`, create a goal such as “raise seed round,” and verify each recommended person shows small chips like:

```text
Investor signal · Warm enough to ask · Spoke 12d ago
```

Expected: no console errors; card remains readable on mobile width.

**Step 4: Run automated tests**

Run:

```bash
npm test
npm run test:e2e
```

Expected: all unit and e2e tests PASS.

**Step 5: Commit**

```bash
git add crm/ui.html.js tests/e2e tests/unit/goals.test.js
git commit -m "feat: show evidence for goal recommendations"
```

---

### Task 5: Tighten roadmap language around the core loop

**Objective:** Align public roadmap wording with the philosophy that goal-oriented activation is core now, not a distant long-term idea.

**Files:**
- Modify: `VISION.md:20-29`
- Modify: `ROADMAP.md:17-25`
- Test: documentation-only; no code tests required, but run markdown sanity by reading the files.

**Step 1: Update `VISION.md`**

Move “Goal-oriented UX” from Long term into Medium term and phrase it as current product direction:

```md
### Medium term (v1.x)
- **Goal-oriented UX** — Minty becomes a goal-achievement tool first: “help me find an intro to X via my network,” not “keep everyone warm.”
- **Local AI layer** — bring-your-own-LLM for relationship summaries and goal-aware ranking. Runs against local JSON, no data leaves.
- **Calendar integration** — cross-reference upcoming meetings with contact history
- **Natural language search** — “who did I meet at that conference in March”
- **Stale data detection** — warn when a contact has not been updated from any source in a year

### Long term
- **Graph-level features** — shortest-path intro finding, company clustering, network-wide queries
- **Collaborative editing** — trusted contacts can update their own records (e2e encrypted)
```

**Step 2: Update `ROADMAP.md`**

Add one v0.3 bullet under “Next”:

```md
- 🎯 **Goal evidence for recommendations** — every suggested person explains why they match the goal and whether the connection is warm enough to act on
```

**Step 3: Verify docs**

Run:

```bash
git diff -- VISION.md ROADMAP.md
```

Expected: only wording changes; no code.

**Step 4: Commit**

```bash
git add VISION.md ROADMAP.md
git commit -m "docs: align roadmap around goal activation"
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

## Rollback plan

If the UI feels noisy after implementation, keep Tasks 1–3 and revert Task 4 only. The structured `goalReasons` field is still valuable for API consumers and future design iterations.
