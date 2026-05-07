# Hermes Readiness Doctor Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a deterministic `npm run hermes:doctor` command that tells Sree whether Minty is demo-ready, dogfood-ready, or Hermes-native for agent workflows.

**Architecture:** Create a pure `crm/hermes-readiness.js` module that evaluates local Minty data, MCP tool availability, privacy/trust metadata, freshness visibility, and Hermes skill install state. Add a small CLI wrapper in `scripts/hermes-doctor.js`, expose it from `package.json`, and document readiness levels in `docs/HERMES_INTEGRATION.md` plus `hermes/minty-network-memory/SKILL.md`. No new dependencies, no runtime LLM calls, and no user-data mutation.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/*.json`, `data/sync-state.json`, `scripts/agent-query.js`, `scripts/minty-mcp-server.js`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`.

---

## Product framing

Minty is correctly moving toward AI-native private network memory for Hermes/OpenClaw/MCP agents. Existing plans cover the retrieval trust contract (`2026-05-02-agent-retrieval-citations.md`), source readiness preflight (`2026-05-06-agent-source-health-mcp.md`), meeting prep, intro paths, goal actions, workflow evals, and a UI evidence-review workbench.

The remaining setup gap is operational trust: when Sree asks “can Hermes use Minty today?”, the answer still requires manual inference across data files, MCP tool lists, demo-vs-real data, freshness metadata, and whether the Hermes skill is installed. That ambiguity weakens the wedge even if the retrieval tools are good.

This plan restores and updates the off-branch readiness-doctor idea against the current repo state. It complements `source_health`: `source_health` answers “which sources can I trust for this query?”, while `hermes:doctor` answers “what readiness level is this local Minty install at?”

## Readiness levels

1. **Demo-ready:** demo/synthetic data exists and MCP exposes the basic agent tools.
2. **Dogfood-ready:** real local data exists, source/evidence/freshness metadata is present, and basic agent envelopes are privacy-safe.
3. **Hermes-native:** dogfood-ready plus the Minty Hermes skill is installed/discoverable and the MCP config can be verified or generated.

## Success criteria

- `npm run hermes:doctor -- --json` returns a stable machine-readable envelope with `level`, `ready`, `checks[]`, `toolNames[]`, `dataDir`, `dataKind`, `latestSyncAt`, `nextActions[]`, and `safety`.
- `npm run hermes:doctor` prints a short human summary suitable for a terminal or cron report.
- The command distinguishes `./data-demo` from real `./data` and never calls demo fixtures dogfood-ready.
- The checker imports `TOOLS` from `scripts/minty-mcp-server.js` instead of duplicating tool availability assumptions.
- The serialized doctor output never includes emails, phones, raw contact ids, raw contact records, OAuth token paths, private GBrain paths, source file paths, group names, group ids, or message bodies.
- Docs explain exactly how to move from each readiness level to the next.

## Non-goals

- Do not run syncs, import contacts, start services, install skills, or mutate data. The doctor is read-only and only suggests next actions.
- Do not replace `source_health`; this is an install/readiness gate, not per-source query preflight.
- Do not add another MCP workflow tool in this plan.
- Do not read GBrain or private brain data.
- Do not add runtime LLM calls, network calls, embeddings, or npm dependencies.

---

### Task 1: Add pure readiness evaluator

**Objective:** Create `evaluateHermesReadiness()` so readiness levels can be tested without spawning processes or touching real user data.

**Files:**
- Create: `crm/hermes-readiness.js`
- Test: `tests/unit/hermes-readiness.test.js`

**Step 1: Write failing test**

Create `tests/unit/hermes-readiness.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateHermesReadiness } = require('../../crm/hermes-readiness');

function contact(overrides = {}) {
    return {
        id: 'c_private',
        name: 'Alice Example',
        emails: ['alice@example.com'],
        phones: ['+15550123'],
        relationshipScore: 72,
        interactionCount: 3,
        daysSinceContact: 5,
        lastContactedAt: '2026-05-06T08:00:00Z',
        sources: { googleContacts: { sourceProfile: 'default' } },
        ...overrides,
    };
}

test('[HermesReadiness]: real data plus MCP plus installed skill is Hermes-native', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data',
        dataKind: 'real',
        contacts: [contact()],
        insights: { c_private: { topics: ['insurance'], meetingBrief: 'Warm context' } },
        contactEvidence: { c_private: { topics: ['insurance'], evidenceCount: 2 } },
        sourceEvents: [{ source: 'googlecontacts', timestamp: '2026-05-06T08:30:00Z' }],
        syncState: { googleContacts: { lastSyncAt: '2026-05-06T08:30:00Z', status: 'ok' } },
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: true,
        now: '2026-05-06T09:00:00Z',
    });

    assert.equal(result.level, 'hermes-native');
    assert.deepEqual(result.ready, { demo: true, dogfood: true, hermesNative: true });
    assert.equal(result.checks.every(c => c.ok), true);
    assert.equal(result.latestSyncAt, '2026-05-06T08:30:00.000Z');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: FAIL — `Cannot find module '../../crm/hermes-readiness'`.

**Step 3: Write minimal implementation**

Create `crm/hermes-readiness.js`:

```js
'use strict';

const REQUIRED_MCP_TOOLS = ['search_network', 'person_context', 'workflow_brief'];

function parseTime(value) {
    const t = Date.parse(value || '');
    return Number.isNaN(t) ? null : t;
}

function newestTimestamp(...collections) {
    let newest = null;
    function visit(value) {
        if (!value) return;
        if (Array.isArray(value)) return value.forEach(visit);
        if (typeof value !== 'object') return;
        for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt', 'timestamp', 'latestAt']) {
            const t = parseTime(value[key]);
            if (t && (!newest || t > newest)) newest = t;
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') visit(child);
        }
    }
    collections.forEach(visit);
    return newest ? new Date(newest).toISOString() : null;
}

function hasRequiredTools(toolNames) {
    return REQUIRED_MCP_TOOLS.every(t => toolNames.includes(t));
}

function evaluateHermesReadiness(input = {}) {
    const contacts = Array.isArray(input.contacts) ? input.contacts : [];
    const insights = input.insights && typeof input.insights === 'object' && !Array.isArray(input.insights) ? input.insights : {};
    const contactEvidence = input.contactEvidence && typeof input.contactEvidence === 'object' && !Array.isArray(input.contactEvidence) ? input.contactEvidence : {};
    const sourceEvents = Array.isArray(input.sourceEvents) ? input.sourceEvents : [];
    const syncState = input.syncState && typeof input.syncState === 'object' && !Array.isArray(input.syncState) ? input.syncState : {};
    const toolNames = Array.isArray(input.mcpTools) ? input.mcpTools.filter(t => typeof t === 'string') : [];
    const dataKind = input.dataKind || 'missing';
    const realContacts = dataKind === 'real' && contacts.length > 0;
    const evidenceAvailable = Object.keys(insights).length > 0 || Object.keys(contactEvidence).length > 0 || contacts.some(c => c && (c.interactionCount > 0 || c.lastContactedAt));
    const latestSyncAt = newestTimestamp(syncState, sourceEvents);
    const nowMs = parseTime(input.now) || Date.now();
    const latestSyncMs = parseTime(latestSyncAt);
    const freshnessDays = latestSyncMs ? Math.floor((nowMs - latestSyncMs) / 86400000) : null;
    const freshEnough = freshnessDays != null && freshnessDays <= 14;
    const requiredTools = hasRequiredTools(toolNames);

    const checks = [
        { id: 'data.present', ok: contacts.length > 0, label: 'Minty has contacts to query' },
        { id: 'data.real', ok: realContacts, label: 'Using real local data, not demo fixtures' },
        { id: 'mcp.tools', ok: requiredTools, label: 'MCP exposes search_network, person_context, and workflow_brief' },
        { id: 'privacy.contract', ok: requiredTools, label: 'Agent tools use the redacted MCP envelope contract' },
        { id: 'evidence.available', ok: evidenceAvailable, label: 'Recommendations have local evidence or interaction history' },
        { id: 'freshness.visible', ok: Boolean(latestSyncAt), label: 'Freshness metadata is visible' },
        { id: 'freshness.recent', ok: freshEnough, label: 'At least one source updated in the last 14 days' },
        { id: 'hermes.skill', ok: input.hermesSkillInstalled === true, label: 'Minty Hermes skill is installed/discoverable' },
    ];

    const demo = contacts.length > 0 && requiredTools;
    const dogfood = demo && realContacts && evidenceAvailable && Boolean(latestSyncAt) && freshEnough;
    const hermesNative = dogfood && input.hermesSkillInstalled === true;
    const level = hermesNative ? 'hermes-native' : dogfood ? 'dogfood-ready' : demo ? 'demo-ready' : 'not-ready';

    const nextActions = [];
    if (!contacts.length) nextActions.push('Run npm run seed:demo for a demo, or npm run memory:refresh for real local data.');
    if (dataKind !== 'real') nextActions.push('Sync real local data before calling Minty dogfood-ready.');
    if (!requiredTools) nextActions.push('Fix scripts/minty-mcp-server.js so MCP lists search_network, person_context, and workflow_brief.');
    if (!evidenceAvailable) nextActions.push('Run npm run memory:refresh or build source/contact evidence before trusting recommendations.');
    if (!latestSyncAt) nextActions.push('Run npm run service or npm run memory:refresh so freshness metadata exists.');
    if (latestSyncAt && !freshEnough) nextActions.push('Refresh sources; freshest known update is older than 14 days.');
    if (input.hermesSkillInstalled !== true) nextActions.push('Install or symlink hermes/minty-network-memory/SKILL.md into Hermes skills.');

    return {
        level,
        ready: { demo, dogfood, hermesNative },
        dataDir: input.dataDir || null,
        dataKind,
        contactCount: contacts.length,
        toolNames,
        latestSyncAt,
        freshnessDays,
        checks,
        nextActions,
        safety: { contactDetailsOmitted: true, readOnly: true, noLlmCalls: true, noPrivateBrainRead: true },
    };
}

module.exports = { evaluateHermesReadiness, REQUIRED_MCP_TOOLS, newestTimestamp, hasRequiredTools };
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
git commit -m "feat: evaluate Hermes readiness"
```

---

### Task 2: Cover readiness levels and privacy-safe output

**Objective:** Lock in the difference between demo-ready, dogfood-ready, Hermes-native, and not-ready while preventing accidental detail leakage.

**Files:**
- Modify: `tests/unit/hermes-readiness.test.js`
- Modify: `crm/hermes-readiness.js` only if tests expose a bug

**Step 1: Add failing tests**

Append to `tests/unit/hermes-readiness.test.js`:

```js
test('[HermesReadiness]: demo data is never dogfood-ready', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data-demo',
        dataKind: 'demo',
        contacts: [contact()],
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: true,
        now: '2026-05-06T09:00:00Z',
    });

    assert.equal(result.level, 'demo-ready');
    assert.equal(result.ready.demo, true);
    assert.equal(result.ready.dogfood, false);
    assert.ok(result.nextActions.some(a => a.includes('real local data')));
});

test('[HermesReadiness]: missing data is not-ready with concrete next actions', () => {
    const result = evaluateHermesReadiness({
        dataDir: null,
        dataKind: 'missing',
        contacts: [],
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
    });

    assert.equal(result.level, 'not-ready');
    assert.equal(result.ready.demo, false);
    assert.ok(result.nextActions.some(a => a.includes('seed:demo')));
});

test('[HermesReadiness]: output does not leak direct contact details or token paths', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data',
        dataKind: 'real',
        contacts: [contact({ sources: { email: { tokenPath: '/secret/token.json' } } })],
        syncState: { email: { lastSyncAt: '2026-05-06T08:00:00Z', tokenPath: '/secret/token.json' } },
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: false,
        now: '2026-05-06T09:00:00Z',
    });

    const text = JSON.stringify(result);
    assert.equal(text.includes('alice@example.com'), false);
    assert.equal(text.includes('+15550123'), false);
    assert.equal(text.includes('c_private'), false);
    assert.equal(text.includes('/secret/token.json'), false);
});
```

**Step 2: Run test to verify failure or current pass**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: PASS if Task 1 implementation already satisfies the contract; otherwise FAIL with a specific readiness/privacy assertion.

**Step 3: Fix only if needed**

If the privacy test fails, remove raw input-derived fields from the return envelope. Do not add contact samples, source rows, token paths, or raw ids to make debugging easier.

**Step 4: Run tests**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/hermes-readiness.js tests/unit/hermes-readiness.test.js
git commit -m "test: cover Hermes readiness levels"
```

---

### Task 3: Add the CLI doctor wrapper

**Objective:** Provide `scripts/hermes-doctor.js` that loads local data, inspects MCP tool exports, checks Hermes skill install state, and prints JSON or a concise terminal summary.

**Files:**
- Create: `scripts/hermes-doctor.js`
- Modify: `package.json`
- Test: `tests/unit/hermes-doctor.test.js`

**Step 1: Write failing tests**

Create `tests/unit/hermes-doctor.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectDataKind, sanitizeSyncState, renderDoctorSummary } = require('../../scripts/hermes-doctor');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test('[HermesDoctor]: detectDataKind distinguishes data-demo from real data', () => {
    assert.equal(detectDataKind('/repo/data-demo'), 'demo');
    assert.equal(detectDataKind('/repo/data'), 'real');
    assert.equal(detectDataKind(null), 'missing');
});

test('[HermesDoctor]: sanitizeSyncState strips token and path-like fields', () => {
    const safe = sanitizeSyncState({
        email: { lastSyncAt: '2026-05-06T08:00:00Z', tokenPath: '/secret/token.json', cacheFile: '/tmp/raw.json', status: 'ok' },
    });

    assert.deepEqual(safe, { email: { lastSyncAt: '2026-05-06T08:00:00Z', status: 'ok' } });
});

test('[HermesDoctor]: renderDoctorSummary is short and actionable', () => {
    const summary = renderDoctorSummary({
        level: 'demo-ready',
        contactCount: 12,
        dataKind: 'demo',
        checks: [{ id: 'data.present', ok: true, label: 'Minty has contacts to query' }],
        nextActions: ['Sync real local data before calling Minty dogfood-ready.'],
    });

    assert.ok(summary.includes('Minty Hermes readiness: demo-ready'));
    assert.ok(summary.includes('contacts: 12'));
    assert.ok(summary.includes('Next: Sync real local data'));
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/hermes-doctor.test.js
```

Expected: FAIL — `Cannot find module '../../scripts/hermes-doctor'`.

**Step 3: Implement CLI**

Create `scripts/hermes-doctor.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataDir, loadData } = require('./agent-query');
const { TOOLS } = require('./minty-mcp-server');
const { evaluateHermesReadiness } = require('../crm/hermes-readiness');

function detectDataKind(dataDir) {
    if (!dataDir) return 'missing';
    return path.basename(path.resolve(dataDir)) === 'data-demo' ? 'demo' : 'real';
}

function sanitizeSyncState(syncState) {
    const safe = {};
    if (!syncState || typeof syncState !== 'object' || Array.isArray(syncState)) return safe;
    for (const [source, state] of Object.entries(syncState)) {
        if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
        safe[source] = {};
        for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt', 'status', 'enabled']) {
            if (Object.hasOwn(state, key)) safe[source][key] = state[key];
        }
    }
    return safe;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadSyncState(dataDir) {
    if (!dataDir) return {};
    return sanitizeSyncState(readJson(path.join(dataDir, 'sync-state.json'), {}));
}

function defaultHermesSkillPaths() {
    const home = process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes');
    return [
        path.join(home, 'skills', 'minty-network-memory', 'SKILL.md'),
        path.join(home, 'skills', 'productivity', 'minty-network-memory', 'SKILL.md'),
    ];
}

function isHermesSkillInstalled(paths = defaultHermesSkillPaths()) {
    return paths.some(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    });
}

function renderDoctorSummary(report) {
    const lines = [
        `Minty Hermes readiness: ${report.level}`,
        `data: ${report.dataKind} | contacts: ${report.contactCount} | tools: ${report.toolNames.join(', ') || 'none'}`,
    ];
    const failing = report.checks.filter(c => !c.ok).slice(0, 4);
    if (failing.length) lines.push(`Checks to fix: ${failing.map(c => c.id).join(', ')}`);
    if (report.nextActions.length) lines.push(`Next: ${report.nextActions[0]}`);
    return lines.join('\n');
}

function buildReport(argv = process.argv.slice(2), rootDir = path.join(__dirname, '..')) {
    const dataDir = resolveDataDir(rootDir);
    const data = dataDir ? loadData(dataDir) : { contacts: [], insights: {}, interactions: [], contactEvidence: {}, sourceEvents: [] };
    const report = evaluateHermesReadiness({
        dataDir,
        dataKind: detectDataKind(dataDir),
        contacts: data.contacts,
        insights: data.insights,
        contactEvidence: data.contactEvidence,
        sourceEvents: data.sourceEvents,
        syncState: loadSyncState(dataDir),
        mcpTools: TOOLS.map(t => t.name),
        hermesSkillInstalled: isHermesSkillInstalled(),
    });
    return report;
}

module.exports = { detectDataKind, sanitizeSyncState, renderDoctorSummary, buildReport, isHermesSkillInstalled };

if (require.main === module) {
    const json = process.argv.includes('--json');
    const report = buildReport();
    process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : renderDoctorSummary(report) + '\n');
}
```

Add to `package.json` scripts after `mcp`:

```json
"hermes:doctor": "node scripts/hermes-doctor.js",
```

**Step 4: Run tests**

Run:

```bash
node --test tests/unit/hermes-doctor.test.js tests/unit/hermes-readiness.test.js
node scripts/hermes-doctor.js --json
```

Expected: tests PASS; CLI prints a JSON object with `level` and `checks`.

**Step 5: Commit**

```bash
git add scripts/hermes-doctor.js package.json tests/unit/hermes-doctor.test.js
git commit -m "feat: add Hermes readiness doctor CLI"
```

---

### Task 4: Add regression coverage to the full test script

**Objective:** Ensure the new doctor tests run in the default Minty test suite.

**Files:**
- Modify: `package.json`

**Step 1: Update test script**

In `package.json`, add these files to the long `test` script near other agent/MCP tests:

```bash
tests/unit/hermes-readiness.test.js tests/unit/hermes-doctor.test.js
```

**Step 2: Run focused tests**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js tests/unit/hermes-doctor.test.js
```

Expected: PASS.

**Step 3: Run default test script**

Run:

```bash
npm test
```

Expected: PASS.

**Step 4: Commit**

```bash
git add package.json
git commit -m "test: include Hermes doctor in default suite"
```

---

### Task 5: Document readiness levels for Hermes users

**Objective:** Make the readiness command discoverable and explain how to move from demo-ready to dogfood-ready to Hermes-native.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`

**Step 1: Update `docs/HERMES_INTEGRATION.md`**

Add after the setup section:

````md
## Readiness doctor

Run this before trusting Minty inside a Hermes/OpenClaw workflow:

```bash
npm run hermes:doctor
npm run hermes:doctor -- --json
```

Readiness levels:

- `demo-ready` — demo/synthetic data exists and MCP exposes the basic tools. Good for demos only.
- `dogfood-ready` — real local Minty data exists, evidence/freshness metadata is present, and the agent envelope is privacy-safe.
- `hermes-native` — dogfood-ready plus the Minty Hermes skill is installed/discoverable.

The doctor is read-only. It never syncs sources, starts services, sends messages, reads GBrain, or prints contact details. Use `source_health` for per-source query readiness once that MCP tool is implemented.
````

**Step 2: Update Hermes skill**

In `hermes/minty-network-memory/SKILL.md`, add a short “Before use” section after MCP configuration:

````md
## Before use: readiness check

From the Minty repo, run:

```bash
npm run hermes:doctor
```

Treat `demo-ready` as a demo only. For real Hermes workflows, prefer `dogfood-ready` or `hermes-native`. If the doctor reports stale or missing data, run `npm run service` for always-on freshness or `npm run memory:refresh` for Sree's manual dogfood refresh loop.
````

**Step 3: Verify docs**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document Hermes readiness levels"
```

---

## Final verification

Run:

```bash
node --test tests/unit/hermes-readiness.test.js tests/unit/hermes-doctor.test.js tests/unit/minty-mcp-server.test.js
npm test
npm run hermes:doctor -- --json
npm run hermes:doctor
git diff --check
```

Expected:

- All tests pass.
- Doctor JSON contains `level`, `ready`, `checks`, `toolNames`, `dataKind`, `nextActions`, and `safety`.
- Human summary is short and actionable.
- No output includes direct contact details, raw ids, token paths, group names, group ids, message bodies, or private GBrain paths.

## Builder notes

- Keep `source_health` separate. It is a per-source MCP preflight; this doctor is an install/readiness diagnostic.
- If `source_health`, `meeting_prep`, or `intro_paths` have landed by implementation time, do not require them for demo-ready/dogfood-ready. Include them in `toolNames`, but keep the minimum readiness threshold to the current basic tools unless Sree explicitly changes the definition.
- If `scripts/agent-query.js` later loads `syncState`, reuse that instead of reading `sync-state.json` directly in `scripts/hermes-doctor.js`.
- Do not use real Sree data in tests or fixtures.
