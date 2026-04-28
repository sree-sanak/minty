# Goal Activation Brief Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn each active Minty goal into a concise activation brief that shows the best direct asks, the best warm-intro paths, and the next action to take.

**Architecture:** Add pure helpers in `crm/people-graph.js` that enrich already-ranked goal contacts with warm-intro path evidence from `group-memberships.json`. Extend `/api/today` to include a small `activationBrief` per goal, then render it in Today as a calm “hidden leverage” section without new persistence, dependencies, or runtime LLM calls.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `data/unified/group-memberships.json`, `crm/server.js`, inline SPA in `crm/ui.html.js`.

---

## Product framing

Sree’s private product note says Minty’s current mission is: “Minty helped me see the hidden leverage in my network.” The public philosophy says the user opens Minty with a goal and needs to know “who can help me with X right now, and how should I reach them?” Today’s goal sections rank relevant people, and the intro finder separately finds warm paths to a named target. The gap is that goal mode does not yet combine those two signals.

This plan makes the Today view answer three action questions for every active goal:

1. **Who should I ask directly?** High relevance + warm enough relationship.
2. **Who should I reach through someone else?** Relevant target + warmer intermediary discovered through small-group co-membership.
3. **What is the first move?** A short deterministic sentence grounded in local data.

Success criteria:
- Every active goal can return `activationBrief.directAsks`, `activationBrief.warmIntroPaths`, and `activationBrief.nextAction`.
- Recommendations are deterministic and grounded in local contact/group data only.
- The UI shows at most 2 direct asks and 2 intro paths, so it feels like a brief rather than a dashboard.
- Existing goal ranking, network query, and intro finder behavior remain backward-compatible.

---

### Task 1: Add pure activation brief helper

**Objective:** Create `buildGoalActivationBrief()` in `crm/people-graph.js` to combine ranked goal contacts with warm-intro paths.

**Files:**
- Modify: `crm/people-graph.js:196-242`
- Test: `tests/unit/people-graph.test.js`

**Step 1: Write failing test**

Append to `tests/unit/people-graph.test.js`:

```js
test('[PeopleGraph]: buildGoalActivationBrief separates direct asks from warm intro paths', () => {
    const contacts = [
        { id: 'c_you', name: 'You', groupMemberships: [{ chatId: 'seed@g.us' }] },
        { id: 'c_target', name: 'Maya Investor', relationshipScore: 15, groupMemberships: [{ chatId: 'seed@g.us' }] },
        { id: 'c_warm', name: 'Priya Warm', relationshipScore: 85, groupMemberships: [{ chatId: 'seed@g.us' }] },
        { id: 'c_direct', name: 'Alex Angel', relationshipScore: 82, groupMemberships: [] },
    ];
    const memberships = {
        'seed@g.us': { name: 'Seed Founders', size: 4, members: ['c_you', 'c_target', 'c_warm'] },
    };
    const ranked = [
        { ...contacts[1], goalRelevance: 78 },
        { ...contacts[3], goalRelevance: 70 },
    ];

    const { buildGoalActivationBrief } = require('../../crm/people-graph');
    const brief = buildGoalActivationBrief('raise seed round', ranked, contacts, memberships, { excludeIds: ['c_you'] });

    assert.equal(brief.goalText, 'raise seed round');
    assert.equal(brief.directAsks[0].contact.id, 'c_direct');
    assert.equal(brief.warmIntroPaths[0].target.id, 'c_target');
    assert.equal(brief.warmIntroPaths[0].intermediary.id, 'c_warm');
    assert.ok(/Ask Alex Angel directly/.test(brief.nextAction));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/unit/people-graph.test.js
```

Expected: FAIL — `buildGoalActivationBrief is not a function`.

**Step 3: Write minimal implementation**

In `crm/people-graph.js`, below `buildWarmIntroBriefs()` and above `module.exports`, add:

```js
function summarizeContactForActivation(c) {
    return {
        id: c.id,
        name: c.name,
        company: c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null,
        position: c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.title || null,
        relationshipScore: Number(c.relationshipScore) || 0,
        daysSinceContact: c.daysSinceContact ?? null,
        goalRelevance: c.goalRelevance ?? null,
    };
}

function buildGoalActivationBrief(goalText, rankedContacts, allContacts, memberships, opts = {}) {
    const directThreshold = opts.directThreshold ?? 60;
    const maxDirect = opts.maxDirect ?? 2;
    const maxIntroPaths = opts.maxIntroPaths ?? 2;
    const excludeIds = Array.isArray(opts.excludeIds) ? opts.excludeIds : [];
    const ranked = Array.isArray(rankedContacts) ? rankedContacts : [];

    const directAsks = ranked
        .filter(c => (Number(c.relationshipScore) || 0) >= directThreshold)
        .slice(0, maxDirect)
        .map(c => ({
            contact: summarizeContactForActivation(c),
            reason: 'Warm enough to ask directly',
        }));

    const directIds = new Set(directAsks.map(a => a.contact.id));
    const warmIntroPaths = [];
    for (const target of ranked) {
        if (directIds.has(target.id)) continue;
        const paths = findIntroPaths(target.id, allContacts, memberships, {
            maxPaths: 1,
            maxGroupSize: opts.maxGroupSize ?? 200,
            excludeIds,
        });
        if (!paths.length) continue;
        const top = paths[0];
        warmIntroPaths.push({
            target: summarizeContactForActivation(target),
            intermediary: {
                id: top.intermediaryId,
                name: top.intermediaryName,
                score: top.intermediaryScore,
                title: top.intermediaryTitle,
                company: top.intermediaryCompany,
            },
            sharedGroup: top.sharedGroupsWithTarget[0] || null,
            pathScore: top.pathScore,
            reason: 'Warmer path through shared group context',
        });
        if (warmIntroPaths.length >= maxIntroPaths) break;
    }

    let nextAction = null;
    if (directAsks.length) {
        nextAction = 'Ask ' + directAsks[0].contact.name + ' directly about “' + goalText + '”.';
    } else if (warmIntroPaths.length) {
        nextAction = 'Ask ' + warmIntroPaths[0].intermediary.name + ' for context on ' + warmIntroPaths[0].target.name + '.';
    }

    return { goalText, directAsks, warmIntroPaths, nextAction };
}
```

Add `buildGoalActivationBrief` to `module.exports`.

**Step 4: Run test to verify pass**

Run:

```bash
npm test -- tests/unit/people-graph.test.js
```

Expected: PASS for `tests/unit/people-graph.test.js`.

**Step 5: Commit**

```bash
git add crm/people-graph.js tests/unit/people-graph.test.js
git commit -m "feat: build goal activation briefs"
```

---

### Task 2: Cover empty and noise cases

**Objective:** Ensure activation briefs degrade gracefully when there are no groups, no ranked contacts, or only mega-group paths.

**Files:**
- Modify: `tests/unit/people-graph.test.js`
- Modify: `crm/people-graph.js:234-310` only if Task 1 needs fixes

**Step 1: Write guard tests**

Append to `tests/unit/people-graph.test.js`:

```js
test('[PeopleGraph]: buildGoalActivationBrief returns empty brief for no ranked contacts', () => {
    const { buildGoalActivationBrief } = require('../../crm/people-graph');
    const brief = buildGoalActivationBrief('hire designer', [], [], {});
    assert.deepEqual(brief.directAsks, []);
    assert.deepEqual(brief.warmIntroPaths, []);
    assert.equal(brief.nextAction, null);
});

test('[PeopleGraph]: buildGoalActivationBrief ignores mega-group-only intro paths', () => {
    const contacts = [
        { id: 'c_target', name: 'Target', relationshipScore: 10, groupMemberships: [{ chatId: 'mega@g.us' }] },
        { id: 'c_warm', name: 'Warm', relationshipScore: 90, groupMemberships: [{ chatId: 'mega@g.us' }] },
    ];
    const memberships = { 'mega@g.us': { name: 'Huge Community', size: 900, members: ['c_target', 'c_warm'] } };
    const { buildGoalActivationBrief } = require('../../crm/people-graph');
    const brief = buildGoalActivationBrief('meet fintech founders', [contacts[0]], contacts, memberships);
    assert.deepEqual(brief.warmIntroPaths, []);
});
```

**Step 2: Run targeted tests**

Run:

```bash
npm test -- tests/unit/people-graph.test.js
```

Expected: PASS. If this fails, fix `buildGoalActivationBrief()` rather than weakening the tests.

**Step 3: Run full unit suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

**Step 4: Commit**

```bash
git add crm/people-graph.js tests/unit/people-graph.test.js
git commit -m "test: cover goal activation brief edge cases"
```

---

### Task 3: Add activation briefs to `/api/today`

**Objective:** Include `activationBrief` inside every `goalSections[]` object returned by `GET /api/today`.

**Files:**
- Modify: `crm/server.js:2997-2999`
- Modify: `crm/server.js:3212-3236`
- Test: `tests/unit/goal-pipeline.test.js` or a new focused integration-style unit test if current helper patterns allow it

**Step 1: Write failing test**

If `tests/unit/goal-pipeline.test.js` remains the closest Today/goal integration harness, add a minimal assertion by simulating the shape produced by `handleGetToday()`:

```js
test('today goal section includes activation brief shape', () => {
    const { rankContactsForGoal } = require('../../crm/utils');
    const { buildGoalActivationBrief } = require('../../crm/people-graph');
    const contacts = [
        { id: 'c_1', name: 'Maya VC', relationshipScore: 80, sources: { linkedin: { position: 'Partner', company: 'Seedcamp' } } },
    ];
    const ranked = rankContactsForGoal(contacts, 'raise seed round', 5);
    const activationBrief = buildGoalActivationBrief('raise seed round', ranked, contacts, {});
    const section = { goalId: 'g_1', goalText: 'raise seed round', contacts: ranked, activationBrief };

    assert.ok(section.activationBrief);
    assert.ok(Array.isArray(section.activationBrief.directAsks));
    assert.ok(Array.isArray(section.activationBrief.warmIntroPaths));
    assert.equal(section.activationBrief.nextAction, 'Ask Maya VC directly about “raise seed round”.');
});
```

**Step 2: Run test**

Run:

```bash
npm test -- tests/unit/goal-pipeline.test.js
```

Expected: PASS once Task 1 exists. This is a characterization test for the new response shape.

**Step 3: Wire server code**

At the imports near `crm/server.js:2997`, change:

```js
const { rankContactsForGoal } = require('./utils');
```

and ensure the existing people-graph import includes `buildGoalActivationBrief` where `findIntroPaths` / `computeGroupSignalScores` are imported. If there is already a destructuring import, add the new symbol rather than creating a second import.

Inside `handleGetToday()`, before building `goalSections`, compute viewer exclusions:

```js
const memberships = loadGroupMemberships();
const viewerId = getViewerContactId(paths);
const excludeIds = [];
if (viewerId) excludeIds.push(viewerId);
if (paths.selfIds?.size) excludeIds.push(...paths.selfIds);
```

Then change the returned goal section to include the brief:

```js
const goalSections = activeGoals.map(goal => {
    const ranked = rankContactsForGoal(contacts, goal.text, 5);
    const activationBrief = buildGoalActivationBrief(goal.text, ranked, contacts, memberships, { excludeIds });
    return {
        goalId:   goal.id,
        goalText: goal.text,
        activationBrief,
        contacts: ranked.map(c => {
            const company  = c.sources?.linkedin?.company || c.sources?.googleContacts?.org || null;
            const position = c.sources?.linkedin?.position || c.sources?.googleContacts?.title || c.apollo?.title || null;
            const ins = insights[c.id] || null;
            return {
                id:                c.id,
                name:              c.name,
                company,
                position,
                relationshipScore: c.relationshipScore || 0,
                daysSinceContact:  c.daysSinceContact  || null,
                activeChannels:    c.activeChannels    || [],
                goalRelevance:     c.goalRelevance,
                goalReasons:       c.goalReasons || [],
                meetingBrief:      ins ? ins.meetingBrief : null,
                topics:            ins ? (ins.topics || []) : [],
            };
        }),
    };
});
```

Note: `goalReasons` is included for compatibility with `docs/plans/2026-04-27-goal-match-evidence.md`. If that plan has not been implemented yet, this remains harmless because it defaults to `[]`.

**Step 4: Run tests**

Run:

```bash
npm test -- tests/unit/goal-pipeline.test.js
npm test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add crm/server.js tests/unit/goal-pipeline.test.js
git commit -m "feat: include activation briefs in today API"
```

---

### Task 4: Render activation brief on Today goal cards

**Objective:** Show a compact “Best moves” section for each goal in the Today view.

**Files:**
- Modify: `crm/ui.html.js` near Today styles
- Modify: `crm/ui.html.js` near Today goal-section rendering
- Test: `tests/unit/ui-js-syntax.test.js`

**Step 1: Add CSS**

Near the existing Today/goal card CSS in `crm/ui.html.js`, add:

```css
.activation-brief {
  margin: 12px 0 14px;
  padding: 12px;
  border: 1px solid rgba(99,102,241,0.18);
  border-radius: 14px;
  background: rgba(99,102,241,0.06);
}
.activation-brief-title {
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 8px;
}
.activation-move {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.4;
  margin-top: 6px;
}
.activation-move strong { color: var(--text-primary); font-weight: 500; }
.activation-next { color: var(--accent-hover); margin-top: 8px; font-size: 12px; }
```

**Step 2: Add render helper**

Inside the SPA script, near other Today rendering helpers, add:

```js
function renderActivationBrief(brief) {
  if (!brief) return '';
  const direct = Array.isArray(brief.directAsks) ? brief.directAsks.slice(0, 2) : [];
  const intros = Array.isArray(brief.warmIntroPaths) ? brief.warmIntroPaths.slice(0, 2) : [];
  if (!direct.length && !intros.length && !brief.nextAction) return '';
  const directHtml = direct.map(a => '<div class="activation-move">→ <span><strong>' + esc(a.contact.name) + '</strong> direct ask' + (a.contact.company ? ' · ' + esc(a.contact.company) : '') + '</span></div>').join('');
  const introHtml = intros.map(p => '<div class="activation-move">↗ <span><strong>' + esc(p.intermediary.name) + '</strong> can open ' + esc(p.target.name) + (p.sharedGroup ? ' via ' + esc(p.sharedGroup.name) : '') + '</span></div>').join('');
  const nextHtml = brief.nextAction ? '<div class="activation-next">' + esc(brief.nextAction) + '</div>' : '';
  return '<div class="activation-brief"><div class="activation-brief-title">Best moves</div>' + directHtml + introHtml + nextHtml + '</div>';
}
```

**Step 3: Insert helper output**

In the Today goal section template, render the brief before the list of contacts:

```js
${renderActivationBrief(section.activationBrief)}
```

Keep the existing contact list below it. Do not remove existing goal recommendations.

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
git commit -m "feat: show goal activation brief in today view"
```

---

### Task 5: Add e2e smoke coverage for Today activation brief

**Objective:** Ensure the Today view can render the new brief without browser errors.

**Files:**
- Modify: `tests/e2e/ui-smoke.stagehand.js` or the existing Today smoke file if one exists
- Possibly modify: `tests/e2e/_fixtures.js` if seeded data needs one warm-intro path

**Step 1: Locate Today smoke setup**

Run:

```bash
npm run test:e2e -- --list
```

Expected: Playwright lists the current e2e specs. Choose the existing UI smoke that visits Today/home.

**Step 2: Add assertion**

In the selected e2e smoke, after the Today view loads, add a tolerant assertion:

```js
await expect(page.locator('.activation-brief').first()).toBeVisible();
await expect(page.locator('.activation-brief')).toContainText(/Best moves|direct ask|can open/i);
```

If fixture data does not currently produce a brief, update `tests/e2e/_fixtures.js` so it seeds:
- one active goal: `raise seed round`
- one warm direct investor contact with `relationshipScore >= 60`
- optionally one low-warmth target sharing a small group with a high-warmth intermediary

**Step 3: Run e2e tests**

Run:

```bash
npm run test:e2e
```

Expected: all e2e tests PASS.

**Step 4: Commit**

```bash
git add tests/e2e
git commit -m "test: smoke goal activation brief UI"
```

---

### Task 6: Document the product shift in roadmap language

**Objective:** Make public docs reflect that the next product bet is activation briefs, not more CRM chrome.

**Files:**
- Modify: `VISION.md:20-29`
- Modify: `ROADMAP.md:17-25`

**Step 1: Update `VISION.md`**

In Medium term, ensure goal-oriented UX and activation briefs are present:

```md
- **Goal activation briefs** — for each active goal, Minty shows the best direct asks, the best warm-intro paths, and the first move to make.
```

**Step 2: Update `ROADMAP.md`**

Under “Next (v0.3 — Summer 2026)”, add:

```md
- 🧭 **Goal activation briefs** — turn each goal into a short list of best direct asks, warm-intro paths, and first moves
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
git commit -m "docs: position goal activation briefs"
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
- `GET /api/today` returns each `goalSections[]` item with `activationBrief.directAsks`, `activationBrief.warmIntroPaths`, and `activationBrief.nextAction`.

## Rollback plan

If the Today view feels too busy, keep Tasks 1–3 and revert Task 4 only. The API shape and pure helper remain useful for CLI output, future digest generation, and a redesigned Today card.
