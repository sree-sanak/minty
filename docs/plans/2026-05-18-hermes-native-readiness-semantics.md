# Hermes-Native Readiness Semantics Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make `npm run hermes:doctor` distinguish data readiness from Hermes-native readiness so agents do not call Minty fully ready when the installed Hermes skill is absent or stale.

**Architecture:** Keep `crm/hermes-readiness.js` as the pure evaluator, but make skill-drift checks injectable for synthetic tests and add explicit `readiness` booleans for `demo`, `dogfood`, and `hermesNative`. Preserve the existing data-file checks while making absent/stale installed skill a warning with a next action and `readiness.hermesNative === false`.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, `crm/hermes-readiness.js`, `scripts/hermes-doctor.js`, `tests/unit/hermes-readiness.test.js`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`.

---

## Current evidence

- Current `npm run hermes:doctor -- --json` reports `level: "ready"` and `nextActions: []` even when the installed Hermes Minty skill is absent.
- Verified smoke:
  - `$HOME/.hermes/skills/minty-network-memory/SKILL.md` is absent.
  - `evaluateReadiness({ dataDir: './data' })` returns `skill_drift.status: "pass"` with detail `Installed skill not present...`.
- This contradicts the product readiness model in `docs/HERMES_INTEGRATION.md`: dogfood-ready means source-backed local data is usable; Hermes-native additionally requires the Minty skill to be installed/discoverable.
- Older plan `docs/plans/2026-05-06-hermes-readiness-doctor.md` created the doctor. This plan is the narrow remaining handoff after issue #210 landed: fix semantics, not a new tool.

## Acceptance criteria

- Missing installed skill returns `skill_drift.status === "warn"`, not `pass`.
- Missing or stale installed skill adds a safe `nextActions` item and leaves `readiness.hermesNative === false`.
- Real local data with required artifacts can still report data-level readiness, but the JSON makes clear whether Minty is `demo`, `dogfood`, and `hermesNative` ready.
- The human CLI output prints all three readiness levels in a short unambiguous form.
- Tests use temp files only and never read or write the real Hermes home.
- Serialized output does not expose absolute private paths, raw contact ids, emails, phones, source handles, message bodies, or credential/env names.

## Non-goals

- Do not install/symlink the skill, mutate Hermes config, or modify cron jobs.
- Do not add another MCP tool.
- Do not read GBrain/private brain data.
- Do not change retrieval ranking, source health, or contact ingestion.
- Do not expose the absolute installed-skill path in doctor output.

---

### Task 1: Make skill drift checks injectable and warn when installed skill is absent

**Objective:** Prove the installed skill absence case with temp files and make it a warning.

**Files:**
- Modify: `crm/hermes-readiness.js`
- Modify: `tests/unit/hermes-readiness.test.js`

**Step 1: Write failing tests**

Append these tests near the existing `Skill drift detection` section in `tests/unit/hermes-readiness.test.js`:

```js
test('[HermesReadiness]: checkSkillDrift warns when installed skill is absent', () => {
    const dir = tmpDir();
    try {
        const repoSkill = path.join(dir, 'repo-skill.md');
        const installedSkill = path.join(dir, 'missing-installed-skill.md');
        fs.writeFileSync(repoSkill, [
            '# Skill',
            '### search_network',
            '### person_context',
            '### workflow_brief',
        ].join('\n'));

        const result = checkSkillDrift({ repoSkillPath: repoSkill, installedSkillPath: installedSkill });

        assert.equal(result.name, 'skill_drift');
        assert.equal(result.status, 'warn');
        assert.match(result.detail, /Installed skill not present/);
        assert.equal(JSON.stringify(result).includes(dir), false, 'must not leak temp absolute path');
        assert.equal(JSON.stringify(result).includes(installedSkill), false, 'must not leak installed skill path');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: checkSkillDrift passes when installed skill has repo tools', () => {
    const dir = tmpDir();
    try {
        const repoSkill = path.join(dir, 'repo-skill.md');
        const installedSkill = path.join(dir, 'installed-skill.md');
        const content = [
            '# Skill',
            '### search_network',
            '### person_context',
            '### workflow_brief',
        ].join('\n');
        fs.writeFileSync(repoSkill, content);
        fs.writeFileSync(installedSkill, content);

        const result = checkSkillDrift({ repoSkillPath: repoSkill, installedSkillPath: installedSkill });

        assert.equal(result.status, 'pass');
        assert.match(result.detail, /Installed skill in sync/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: FAIL because `checkSkillDrift` currently ignores injected paths and returns `pass` for missing installed skill.

**Step 3: Write minimal implementation**

In `crm/hermes-readiness.js`, change `checkSkillDrift()` to accept optional paths:

```js
function checkSkillDrift(opts = {}) {
    const repoSkillPath = opts.repoSkillPath || REPO_SKILL_PATH;
    const installedSkillPath = opts.installedSkillPath || INSTALLED_SKILL_PATH;

    const repoExists = fs.existsSync(repoSkillPath);
    if (!repoExists) {
        return { name: 'skill_drift', status: 'warn', detail: 'Repo skill not found — cannot check drift' };
    }

    let repoContent;
    try {
        repoContent = fs.readFileSync(repoSkillPath, 'utf8');
    } catch {
        return { name: 'skill_drift', status: 'warn', detail: 'Repo skill unreadable' };
    }

    const repoTools = extractSkillTools(repoContent);
    if (!fs.existsSync(installedSkillPath)) {
        return {
            name: 'skill_drift',
            status: 'warn',
            detail: 'Installed skill not present — install minty-network-memory to become Hermes-native',
        };
    }

    let installedContent;
    try {
        installedContent = fs.readFileSync(installedSkillPath, 'utf8');
    } catch {
        return { name: 'skill_drift', status: 'warn', detail: 'Installed skill unreadable' };
    }

    const installedTools = extractSkillTools(installedContent);
    const missingInInstalled = [...repoTools].filter(t => !installedTools.has(t));
    if (missingInInstalled.length === 0) {
        return {
            name: 'skill_drift',
            status: 'pass',
            detail: `Installed skill in sync (${installedTools.size} tools)`,
        };
    }

    return {
        name: 'skill_drift',
        status: 'warn',
        detail: `Installed skill missing ${missingInInstalled.length} tool(s): ${missingInInstalled.join(', ')}. Update minty-network-memory skill.`,
    };
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/hermes-readiness.js tests/unit/hermes-readiness.test.js
git commit -m "fix: warn when Minty Hermes skill is absent"
```

---

### Task 2: Add explicit readiness booleans for demo, dogfood, and Hermes-native

**Objective:** Prevent agents from inferring Hermes-native readiness from data-file readiness alone.

**Files:**
- Modify: `crm/hermes-readiness.js`
- Modify: `tests/unit/hermes-readiness.test.js`

**Step 1: Write failing tests**

Add these tests after the level semantics tests:

```js
test('[HermesReadiness]: full data without installed skill is dogfood but not Hermes-native', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
            'interactions.json': [{ id: 'i_001' }],
            'contact-evidence.json': { c_001: { sources: ['email'] } },
            'hybrid-index.json': { version: 1 },
        });
        const missingSkill = path.join(dir, 'missing-skill.md');
        const result = evaluateReadiness({
            dataDir: dir,
            skillDrift: { installedSkillPath: missingSkill },
        });

        assert.deepEqual(result.readiness, {
            demo: true,
            dogfood: true,
            hermesNative: false,
        });
        assert.ok(result.nextActions.some(action => action.includes('minty-network-memory')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: demo data never becomes dogfood-ready', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
            'interactions.json': [{ id: 'i_001' }],
            'contact-evidence.json': { c_001: {} },
            'hybrid-index.json': { version: 1 },
        });
        const result = evaluateReadiness({ dataDir: dir, dataKind: 'demo' });

        assert.equal(result.readiness.demo, true);
        assert.equal(result.readiness.dogfood, false);
        assert.equal(result.readiness.hermesNative, false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: FAIL because `evaluateReadiness` has no `readiness` object and no injectable skill check.

**Step 3: Write minimal implementation**

Patch `evaluateReadiness` in `crm/hermes-readiness.js`:

```js
function evaluateReadiness(opts = {}) {
    const { dataDir, dataKind: kindOverride } = opts;
    const toolNames = TOOLS.map(t => t.name);

    if (!dataDir) {
        return {
            level: 'not-ready',
            readiness: { demo: false, dogfood: false, hermesNative: false },
            checks: [{ name: 'dataDir', status: 'fail', detail: 'No data directory found' }],
            toolNames,
            dataDir: '(none)',
            dataKind: kindOverride || 'none',
            nextActions: ['Import at least one source (npm run whatsapp, npm run email, etc.) then run npm run merge.'],
        };
    }

    const dataKind = kindOverride || 'user';
    const fileChecks = REQUIRED_FILES.map(spec => checkFile(dataDir, spec));
    const skillDriftCheck = checkSkillDrift(opts.skillDrift || {});
    const checks = [...fileChecks, skillDriftCheck];
    const requiredFileFails = fileChecks.filter(c => c.status === 'fail');
    const requiredFilePasses = fileChecks.filter(c => c.status === 'pass');

    // Demo-ready intentionally means partial/synthetic data can exercise at least one MCP tool path.
    // It is weaker than dogfood-ready, which requires every required artifact from real local data.
    const demo = requiredFilePasses.length > 0 && requiredFileFails.length < REQUIRED_FILES.length;
    const dogfood = dataKind !== 'demo' && requiredFilePasses.length === REQUIRED_FILES.length && requiredFileFails.length === 0;
    const hermesNative = dogfood && skillDriftCheck.status === 'pass';

    let level;
    if (hermesNative) level = 'hermes-native';
    else if (dogfood) level = 'dogfood-ready';
    else if (demo) level = 'demo-ready';
    else level = 'not-ready';

    const nextActions = [];
    if (requiredFileFails.length > 0) {
        const missing = requiredFileFails.map(f => f.name).join(', ');
        nextActions.push(`Missing data: ${missing}. Run npm run merge and npm run contact-evidence to rebuild.`);
    }
    if (skillDriftCheck.status === 'warn') {
        nextActions.push('Install or update Minty Hermes skill: minty-network-memory');
    }

    return {
        level,
        readiness: { demo, dogfood, hermesNative },
        checks,
        toolNames,
        dataDir: redactPath(dataDir),
        dataKind,
        nextActions,
    };
}
```

Keep any existing tests that asserted `level === "ready"` updated to the new explicit level: full user data with missing skill should be `dogfood-ready`; full user data with injected synced skill should be `hermes-native`.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/hermes-readiness.js tests/unit/hermes-readiness.test.js
git commit -m "feat: expose Hermes-native readiness semantics"
```

---

### Task 3: Update human doctor output and docs

**Objective:** Make the terminal and docs clearly show demo/dogfood/Hermes-native readiness without requiring JSON parsing.

**Files:**
- Modify: `scripts/hermes-doctor.js`
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Write failing docs/output test**

In `tests/unit/agent-surface-docs.test.js`, add:

```js
test('[AgentSurfaceDocs]: readiness docs distinguish dogfood from Hermes-native', () => {
    for (const relPath of DOC_PATHS) {
        const doc = readDoc(relPath);
        assert.ok(doc.includes('dogfood-ready'), `${relPath} must mention dogfood-ready`);
        assert.ok(doc.includes('Hermes-native'), `${relPath} must mention Hermes-native`);
        assert.ok(doc.includes('minty-network-memory'), `${relPath} must mention installed skill name`);
    }
});
```

**Step 2: Run test to verify failure or current coverage**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS may already occur for docs; if it passes, keep it as a regression test before changing CLI/docs.

**Step 3: Update CLI output**

In `scripts/hermes-doctor.js`, after printing the top-level label, add:

```js
if (result.readiness) {
    const mark = value => value ? 'yes' : 'no';
    console.log(`Demo-ready: ${mark(result.readiness.demo)}`);
    console.log(`Dogfood-ready: ${mark(result.readiness.dogfood)}`);
    console.log(`Hermes-native: ${mark(result.readiness.hermesNative)}`);
    console.log('');
}
```

**Step 4: Update docs**

Patch `docs/HERMES_INTEGRATION.md` and `hermes/minty-network-memory/SKILL.md` readiness sections to state:

```md
`npm run hermes:doctor -- --json` reports both `level` and `readiness`:

- `readiness.demo`: demo/synthetic or partial local data plus MCP tool availability.
- `readiness.dogfood`: real local data has contacts, interactions, contact evidence, and hybrid index artifacts.
- `readiness.hermesNative`: dogfood-ready plus the installed `minty-network-memory` Hermes skill is present and in sync.

If `readiness.dogfood` is true but `readiness.hermesNative` is false, Minty can answer local CLI/MCP queries, but Hermes may not reliably auto-load the Minty operating rules until the skill is installed or updated.
```

**Step 5: Run focused tests and smoke**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js tests/unit/agent-surface-docs.test.js
npm run hermes:doctor -- --json
npm run hermes:doctor
```

Expected: tests PASS; JSON includes `readiness`; human output shows all three readiness lines.

**Step 6: Commit**

```bash
git add scripts/hermes-doctor.js docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: clarify Minty Hermes readiness levels"
```

---

### Task 4: Final verification

**Objective:** Prove the readiness semantics are safe and do not leak private data.

**Files:**
- Verify only.

**Step 1: Run focused tests**

```bash
node --test tests/unit/hermes-readiness.test.js tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 2: Run doctor JSON smoke**

```bash
DOCTOR_JSON=$(mktemp)
trap 'rm -f "$DOCTOR_JSON"' EXIT
npm run hermes:doctor -- --json > "$DOCTOR_JSON"
node - "$DOCTOR_JSON" <<'NODE'
const fs = require('node:fs');
const out = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!out.readiness || typeof out.readiness.hermesNative !== 'boolean') throw new Error('missing readiness.hermesNative');
const raw = JSON.stringify(out);
for (const forbidden of ['@', '+155', '/home/', '/Users/', 'OAuth', 'message body']) {
  if (raw.includes(forbidden)) throw new Error(`doctor output leaked ${forbidden}`);
}
for (const pattern of [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, /\+?\d[\d\s().-]{7,}\d/]) {
  if (pattern.test(raw)) throw new Error('doctor output leaked contact detail pattern');
}
NODE
```

Expected: no output and exit code 0.

**Step 3: Run whitespace check**

```bash
git diff --check -- crm/hermes-readiness.js scripts/hermes-doctor.js tests/unit/hermes-readiness.test.js tests/unit/agent-surface-docs.test.js docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
```

Expected: no output.

**Step 4: Commit if needed**

If verification required minor fixes:

```bash
git add crm/hermes-readiness.js scripts/hermes-doctor.js tests/unit/hermes-readiness.test.js tests/unit/agent-surface-docs.test.js docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "test: verify Hermes readiness privacy contract"
```
