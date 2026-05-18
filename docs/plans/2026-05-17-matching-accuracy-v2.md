# Matching Accuracy v2 Candidate Scoring Implementation Plan

> Implement this plan task-by-task with test-first changes and focused verification.

**Goal:** Make cross-source identity candidates more conservative, more explainable, and still strictly manual-review by default.

**Architecture:** Keep `crm/match.js` as the candidate generator, but split fuzzy-name scoring into small helpers so short-name edits, common-name matches, last-name initials, and weak corroboration have explicit rules and reason strings. Keep generated overrides routed through `reviewOverrideFromMatch(...)` so no fuzzy candidate is auto-confirmed by the matcher.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `crm/match.js`, `tests/unit/match.test.js`, and `crm/MATCHING.md`.

---

## Current evidence

- Open issue: `#269 Tighten Matching accuracy v2 candidate scoring`.
- Current source anchors:
  - `crm/match.js:159-165` has a broad `fuzzyMatch(a, b)` threshold that allows one edit for short names.
  - `crm/match.js:213-335` scores exact/fuzzy first and last names but does not distinguish high-risk short names or common-name fuzzy-last candidates.
  - `crm/match.js:349-424` returns generated candidate matches; `crm/match.js:19-32` converts them to manual-review overrides.
  - `tests/unit/match.test.js` already covers scoring, candidate generation, common-name penalty, and manual-review override behavior.
  - `crm/MATCHING.md:80-83` is stale: it says `confirmed` / `likely` merge automatically, but generated candidates are now written as `possible` for user review.
- Verified current gap with a tiny synthetic smoke:
  - `fuzzyMatch('sam', 'sim') === true`.
  - `scoreGenericPair('James Smyth', 'James Smith')` returns `score: 55`, `confidence: 'likely'` using only common first name plus fuzzy last name.

## Acceptance criteria

- Short first names such as `sam` vs `sim` do not fuzzy-match unless an explicit nickname rule handles them.
- Last-name fuzzy evidence is more conservative for short surnames and common first names.
- Last-name initials (`Alex R` vs `Alex Rivera`) are explained as weak partial evidence, not treated as full fuzzy last-name evidence.
- Common first-name candidates without corroboration remain `possible` or `skip`, never `likely` / `confirmed` before review.
- Generated cross-source candidates still become overrides with `confidence: "possible"` through `reviewOverrideFromMatch(...)`; `suggestedConfidence` may show the scorer's recommendation for review UI context.
- Reason strings explain accepted and penalized evidence, for example `Last name initial matches`, `Short last name fuzzy ignored`, or `Common first name requires corroboration`.
- `crm/MATCHING.md` matches the current safety contract: exact phone/email merging lives in `crm/merge.js`; this matcher only produces review suggestions.
- Verification passes: `node --test tests/unit/match.test.js` and `git diff --check -- crm/match.js tests/unit/match.test.js crm/MATCHING.md`.

## Non-goals

- Do not run match generation against real user data.
- Do not edit real `data/unified/match_overrides.json`.
- Do not auto-confirm fuzzy identity matches.
- Do not add hosted LLMs, external enrichment, provider calls, or live importers.
- Do not expand the identity review UI in this plan.

---

### Task 1: Add failing tests for short-name fuzzy blocking

**Objective:** Prove the matcher currently accepts risky short-name fuzzy matches.

**Files:**
- Modify: `tests/unit/match.test.js`

**Step 1: Write failing tests**

Add these tests after the existing `fuzzyMatch` tests:

```js
test('fuzzyMatch: short first names with one edit are too risky', () => {
    assert.equal(fuzzyMatch('sam', 'sim'), false);
    assert.equal(fuzzyMatch('tom', 'tim'), false);
});

test('fuzzyMatch: longer one-edit names can still match', () => {
    assert.equal(fuzzyMatch('alexander', 'alexender'), true);
    assert.equal(fuzzyMatch('jonathan', 'johnathan'), true);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: FAIL because `fuzzyMatch('sam', 'sim')` currently returns `true`.

**Step 3: Implement minimal code**

In `crm/match.js`, replace `fuzzyMatch` with stricter short-token handling:

```js
function fuzzyMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const maxLen = Math.max(a.length, b.length);
    const minLen = Math.min(a.length, b.length);
    if (minLen < 5) return false;
    const dist = lev(a, b);
    return dist <= Math.max(1, Math.floor(maxLen * 0.2));
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: PASS, except any later existing tests that intentionally relied on short fuzzy nickname behavior should be updated in Task 2, not silently ignored.

**Step 5: Commit**

```bash
git add crm/match.js tests/unit/match.test.js
git commit -m "fix: block risky short-name fuzzy matches"
```

---

### Task 2: Preserve explicit nickname evidence without broad short fuzzy matching

**Objective:** Keep nickname matching useful while avoiding generic short-token fuzziness.

**Files:**
- Modify: `crm/match.js`
- Modify: `tests/unit/match.test.js`

**Step 1: Write failing tests**

Replace or adjust the existing fuzzy nickname test so the preserved case is an explicit longer nickname, not a three-letter near-match:

```js
test('scoreGenericPair: fuzzy nickname match only for distinctive nickname tokens', () => {
    const wa = waContact('Jimmie');
    const li = liContact('Robert (Jimmy) Patel');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.score > 0, 'distinctive fuzzy nickname should produce a positive score');
    assert.ok(r.reasons.some(reason => reason.includes('fuzzy-matches nickname')));
});

test('scoreGenericPair: short nickname typo is not enough for a candidate', () => {
    const wa = waContact('Jim');
    const li = liContact('Robert (Tim) Patel');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'skip');
    assert.equal(r.score, 0);
});
```

**Step 2: Run focused test**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: PASS after Task 1 if nickname handling uses the same stricter `fuzzyMatch` rule.

**Step 3: Keep implementation minimal**

If Task 1 already passes these tests, do not add new code. If not, update only the nickname branch in `scoreGenericPair(...)` so fuzzy nickname matching calls `fuzzyMatch(firstA, nickB)` and exact nickname matching remains allowed.

**Step 4: Commit**

```bash
git add crm/match.js tests/unit/match.test.js
git commit -m "test: preserve conservative nickname matching"
```

---

### Task 3: Add conservative last-name evidence helper

**Objective:** Make last-name exact, initial, fuzzy, and mismatch handling explicit and explainable.

**Files:**
- Modify: `crm/match.js`
- Modify: `tests/unit/match.test.js`

**Step 1: Write failing tests**

Add these tests near the `scoreGenericPair` scoring tests:

```js
test('scoreGenericPair: last-name initial is weak evidence, not full fuzzy evidence', () => {
    const wa = waContact('Alex R');
    const li = liContact('Alex Rivera');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.reasons.some(reason => reason.includes("Last name initial matches: 'r' -> 'rivera'")));
    assert.equal(r.reasons.some(reason => reason.includes('Last name fuzzy')), false);
    assert.equal(r.score, 50);
    assert.equal(r.confidence, 'likely');
});

test('scoreGenericPair: short last-name fuzzy is ignored with an explanation', () => {
    const wa = waContact('Sam Rao');
    const li = liContact('Sam Roy');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.ok(r.reasons.some(reason => reason.includes("Short last name fuzzy ignored: 'rao' vs 'roy'")));
    assert.equal(r.reasons.some(reason => reason.includes('Last name fuzzy')), false);
    assert.equal(r.confidence, 'possible');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: FAIL because initials and short fuzzy surnames are not handled separately yet.

**Step 3: Implement minimal helper**

Add this helper above `scoreGenericPair(...)` in `crm/match.js`:

```js
function scoreLastNameEvidence(lastA, lastB) {
    if (lastA && lastB) {
        if (lastA === lastB) {
            return { score: 40, reason: `Last name exact: '${lastA}'` };
        }
        const isInitialA = lastA.length === 1;
        const isInitialB = lastB.length === 1;
        if (isInitialA && lastB.startsWith(lastA)) {
            return { score: 10, reason: `Last name initial matches: '${lastA}' -> '${lastB}'` };
        }
        if (isInitialB && lastA.startsWith(lastB)) {
            return { score: 10, reason: `Last name initial matches: '${lastB}' -> '${lastA}'` };
        }
        if (Math.min(lastA.length, lastB.length) < 5 && lev(lastA, lastB) === 1) {
            return { score: 0, reason: `Short last name fuzzy ignored: '${lastA}' vs '${lastB}'` };
        }
        if (fuzzyMatch(lastA, lastB)) {
            return { score: 30, reason: `Last name fuzzy: '${lastA}' ~ '${lastB}'` };
        }
        return { score: -20, reason: `Last name mismatch: '${lastA}' vs '${lastB}'` };
    }
    if (lastA && !lastB) {
        return { score: -5, reason: `Last name missing on second contact: '${lastA}'` };
    }
    if (!lastA && lastB) {
        return { score: -5, reason: `Last name missing on first contact: '${lastB}'` };
    }
    return { score: 0, reason: null };
}
```

Then replace the inline last-name block in `scoreGenericPair(...)` with:

```js
const lastEvidence = scoreLastNameEvidence(lastA, lastB);
if (lastEvidence.reason) reasons.push(lastEvidence.reason);
score += lastEvidence.score;
```

Export the helper only if a test imports it directly; prefer testing through `scoreGenericPair(...)` unless the implementation becomes hard to inspect.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: PASS after updating any brittle exact-score tests affected by the new missing-last-name reason.

**Step 5: Commit**

```bash
git add crm/match.js tests/unit/match.test.js
git commit -m "fix: explain conservative last-name evidence"
```

---

### Task 4: Downgrade common-name fuzzy-last candidates without corroboration

**Objective:** Prevent common first name plus fuzzy last name from looking stronger than the evidence supports.

**Files:**
- Modify: `crm/match.js`
- Modify: `tests/unit/match.test.js`

**Step 1: Write failing tests**

Update the existing common fuzzy-last test from `likely` to the new conservative behavior:

```js
test('scoreGenericPair: common first name plus fuzzy last stays possible without corroboration', () => {
    const wa = waContact('James Smyth');
    const li = liContact('James Smith');
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'possible');
    assert.ok(r.score < 45, `score ${r.score} should stay below likely threshold`);
    assert.ok(r.reasons.some(reason => reason.includes("Common first name 'james' requires corroboration for fuzzy last name")));
});
```

Add a positive control proving corroboration can still make a candidate useful:

```js
test('scoreGenericPair: common fuzzy last can become likely with source corroboration', () => {
    const wa = waContact('James Smyth DeepMind');
    const li = liContact('James Smith', { company: 'DeepMind' });
    const r = scoreGenericPair(wa, 'whatsapp', li, 'linkedin');
    assert.equal(r.confidence, 'likely');
    assert.ok(r.reasons.some(reason => reason.includes('Affiliation keyword')));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: FAIL because current score is `55` / `likely` for `James Smyth` vs `James Smith`.

**Step 3: Implement minimal code**

Track whether fuzzy last-name evidence was used:

```js
const lastEvidence = scoreLastNameEvidence(lastA, lastB);
if (lastEvidence.reason) reasons.push(lastEvidence.reason);
score += lastEvidence.score;
const usedFuzzyLastName = lastEvidence.kind === 'fuzzy';
```

Update `scoreLastNameEvidence(...)` returns to include `kind: 'exact' | 'initial' | 'short_fuzzy_ignored' | 'fuzzy' | 'mismatch' | 'missing' | 'none'`.

After common-name penalty, add:

```js
if (firstA && COMMON_NAMES.has(firstA) && usedFuzzyLastName) {
    reasons.push(`Common first name '${firstA}' requires corroboration for fuzzy last name`);
    score -= 15;
}
```

Do not apply this extra penalty to exact last names, exact nicknames, location match, company/org match, or distinctive affiliation keyword matches unless the final tests prove those candidates are still too broad.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/match.js tests/unit/match.test.js
git commit -m "fix: downgrade weak common-name fuzzy candidates"
```

---

### Task 5: Preserve manual-review override safety contract

**Objective:** Lock the no-auto-confirm behavior for generated matcher outputs.

**Files:**
- Modify: `tests/unit/match.test.js`

**Step 1: Write regression test**

Add this near the existing `reviewOverrideFromMatch` test:

```js
test('matchGroups plus reviewOverrideFromMatch keeps generated candidates manual-review only', () => {
    const wa = waContact('Zarquon Smith');
    const li = liContact('Zarquon Smith');
    const result = matchGroups([wa], 'whatsapp', [li], 'linkedin');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].confidence, 'confirmed');

    const override = reviewOverrideFromMatch(result.matches[0]);
    assert.equal(override.confidence, 'possible');
    assert.equal(override.suggestedConfidence, 'confirmed');
    assert.deepEqual(override.ids, [wa.id, li.id]);
});
```

**Step 2: Run test**

Run:

```bash
node --test tests/unit/match.test.js
```

Expected: PASS. If it fails, fix `reviewOverrideFromMatch(...)` rather than weakening the test.

**Step 3: Commit**

```bash
git add tests/unit/match.test.js
git commit -m "test: lock generated match manual review contract"
```

---

### Task 6: Update matching docs to match reality

**Objective:** Remove stale language that implies generated fuzzy candidates auto-merge.

**Files:**
- Modify: `crm/MATCHING.md`

**Step 1: Patch the scoring contract**

Update `crm/MATCHING.md` so Step 3 says:

```md
Classify each pair for reviewer guidance as:
- `"confirmed"` — strong suggested match; still written as a review suggestion by `crm/match.js`
- `"likely"` — useful suggested match; still written as a review suggestion by `crm/match.js`
- `"possible"` — weak suggested match; needs human review
- `"skip"` — clearly different people

Important: `crm/match.js` does not auto-confirm generated fuzzy cross-source candidates. It writes generated suggestions through `reviewOverrideFromMatch(...)`, which stores `confidence: "possible"` plus `suggestedConfidence` for the identity review UI. Exact phone/email unification happens separately in `crm/merge.js`.
```

Update Step 4 example so generated overrides use:

```json
{
  "confidence": "possible",
  "suggestedConfidence": "confirmed",
  "ids": ["c_0042", "c_1837"],
  "reason": "First name exact: 'alex'; Last name exact: 'patel'; Phone prefix +44 consistent with LI context",
  "sources_linked": ["whatsapp", "linkedin"]
}
```

Update Step 5 / `merge.js` prose to say only human-approved `confirmed` / `likely` overrides are merged; generated `possible` suggestions are not.

**Step 2: Verify docs diff**

Run:

```bash
git diff --check -- crm/MATCHING.md
```

Expected: no output, exit 0.

**Step 3: Commit**

```bash
git add crm/MATCHING.md
git commit -m "docs: clarify identity matching review contract"
```

---

### Task 7: Final focused verification

**Objective:** Prove the matcher change is safe and isolated.

**Files:**
- Verify only; no edits expected.

**Step 1: Run focused unit tests**

```bash
node --test tests/unit/match.test.js
```

Expected: all tests pass.

**Step 2: Run full unit suite if focused test passes**

```bash
npm test
```

Expected: all tests pass.

**Step 3: Run whitespace check**

```bash
git diff --check -- crm/match.js tests/unit/match.test.js crm/MATCHING.md
```

Expected: no output, exit 0.

**Step 4: Confirm no real data was touched**

```bash
git diff --name-only origin/main...HEAD
```

Expected: only project code/docs/test files for this issue, with no `data/` files or private exports.

**Step 5: Close issue after PR merge**

After the implementation PR is merged, close `#269` with a comment summarizing:

- short fuzzy first names blocked;
- common-name fuzzy-last candidates downgraded without corroboration;
- generated candidates still manual-review only;
- tests/docs updated.
