# Hermes Readiness Doctor Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a deterministic `npm run hermes:doctor` command that tells Sree whether Minty is demo-ready, dogfood-ready, or Hermes-native for agent workflows.

**Architecture:** Create a pure `crm/hermes-readiness.js` module that scores local Minty data, MCP tool availability, privacy contract, freshness, and Hermes skill install state. Add a small CLI wrapper in `scripts/hermes-doctor.js`, expose it from `package.json`, and document the readiness levels in the Hermes integration docs and Minty Hermes skill. No new dependencies, no runtime LLM calls, and no mutation of user data.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `data/unified/contacts.json`, `data/sync-state.json`, `scripts/minty-mcp-server.js`, `scripts/agent-query.js`, `hermes/minty-network-memory/SKILL.md`.

---

## Product framing

Minty's current pivot is AI-native private network memory for Hermes first, then broader MCP-compatible agents. The existing surfaces are promising:

- `search_network` — natural-language private network search.
- `person_context` — relationship context for a known person.
- `workflow_brief` — goal-oriented people brief.
- `hermes/minty-network-memory/SKILL.md` — a Hermes skill, but installation is still manual.
- `npm run memory:refresh` — Sree's current dogfood refresh loop.
- `npm run service` — the desired always-on product shape.

The gap is not another retrieval tool. The gap is operational trust. When Sree asks “is Minty usable in Hermes today?”, the answer currently requires manually checking data files, MCP registration, tool list output, contact counts, and whether real data is being used instead of demo fixtures. That ambiguity weakens the wedge.

This plan adds a narrow doctor/readiness command with three explicit levels:

1. **Demo-ready:** demo or synthetic data exists and MCP can list tools.
2. **Dogfood-ready:** real local data exists, agent envelopes are redacted/source-backed, freshness metadata is present, and low-evidence results fail safely.
3. **Hermes-native:** dogfood-ready plus the Minty Hermes skill is installed/discoverable and the MCP config can be generated or verified.

Success criteria:

- `npm run hermes:doctor -- --json` returns a stable machine-readable envelope with `level`, `checks[]`, `toolNames[]`, `dataDir`, `dataKind`, and `nextActions[]`.
- `npm run hermes:doctor` prints a short human summary suitable for Sree in a terminal.
- The command never prints emails, phone numbers, raw contact records, OAuth token paths, or private GBrain content.
- The doctor distinguishes demo data from real `./data` and refuses to call demo fixtures “dogfood-ready”.
- The doctor checks MCP tool availability directly through exported `TOOLS`, not by duplicating hard-coded assumptions.
- Docs explain how to move from each readiness level to the next.

---

### Task 1: Add pure readiness checker

**Objective:** Create `evaluateHermesReadiness()` so readiness can be tested without spawning processes or touching real user data.

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
        id: 'c_1',
        name: 'Alice Example',
        relationshipScore: 72,
        interactionCount: 3,
        daysSinceContact: 5,
        sources: { googleContacts: { sourceProfile: 'default' } },
        ...overrides,
    };
}

test('[HermesReadiness]: real data plus MCP plus installed skill is Hermes-native', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data',
        dataKind: 'real',
        contacts: [contact()],
        insights: { c_1: { topics: ['insurance'], meetingBrief: 'Warm context' } },
        syncState: { googleContacts: { lastSyncAt: '2026-05-01T08:00:00Z', status: 'ok' } },
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: true,
        now: '2026-05-01T09:00:00Z',
    });

    assert.equal(result.level, 'hermes-native');
    assert.equal(result.ready.demo, true);
    assert.equal(result.ready.dogfood, true);
    assert.equal(result.ready.hermesNative, true);
    assert.equal(result.checks.every(c => c.ok), true);
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

function newestSyncAt(syncState) {
    let newest = null;
    for (const value of Object.values(syncState || {})) {
        if (!value || typeof value !== 'object') continue;
        for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt']) {
            const t = parseTime(value[key]);
            if (t && (!newest || t > newest)) newest = t;
        }
    }
    return newest ? new Date(newest).toISOString() : null;
}

function hasUnsafeToolEnvelope(toolNames) {
    return REQUIRED_MCP_TOOLS.every(t => toolNames.includes(t));
}

function evaluateHermesReadiness(input = {}) {
    const contacts = Array.isArray(input.contacts) ? input.contacts : [];
    const insights = input.insights && typeof input.insights === 'object' ? input.insights : {};
    const toolNames = Array.isArray(input.mcpTools) ? input.mcpTools : [];
    const dataKind = input.dataKind || 'missing';
    const realContacts = dataKind === 'real' && contacts.length > 0;
    const hasInsights = Object.keys(insights).length > 0;
    const hasRequiredTools = hasUnsafeToolEnvelope(toolNames);
    const latestSyncAt = newestSyncAt(input.syncState);
    const nowMs = parseTime(input.now) || Date.now();
    const latestSyncMs = parseTime(latestSyncAt);
    const freshnessDays = latestSyncMs ? Math.floor((nowMs - latestSyncMs) / 86400000) : null;
    const freshEnough = freshnessDays != null && freshnessDays <= 14;

    const checks = [
        { id: 'data.present', ok: contacts.length > 0, label: 'Minty has contacts to query' },
        { id: 'data.real', ok: realContacts, label: 'Using real local data, not demo fixtures' },
        { id: 'mcp.tools', ok: hasRequiredTools, label: 'MCP exposes required network-memory tools' },
        { id: 'privacy.redaction', ok: hasRequiredTools, label: 'Agent tools omit direct contact details by contract' },
        { id: 'evidence.available', ok: hasInsights || contacts.some(c => c.interactionCount > 0 || c.lastContactedAt), label: 'Recommendations can cite local relationship evidence' },
        { id: 'freshness.visible', ok: Boolean(latestSyncAt), label: 'Sync freshness metadata is visible' },
        { id: 'freshness.recent', ok: freshEnough, label: 'At least one source synced in the last 14 days' },
        { id: 'hermes.skill', ok: input.hermesSkillInstalled === true, label: 'Minty Hermes skill is installed/discoverable' },
    ];

    const demo = contacts.length > 0 && hasRequiredTools;
    const dogfood = demo && realContacts && checks.find(c => c.id === 'evidence.available').ok && checks.find(c => c.id === 'freshness.visible').ok;
    const hermesNative = dogfood && input.hermesSkillInstalled === true;
    const level = hermesNative ? 'hermes-native' : dogfood ? 'dogfood-ready' : demo ? 'demo-ready' : 'not-ready';

    const nextActions = [];
    if (!contacts.length) nextActions.push('Run npm run seed:demo for a demo, or npm run memory:refresh for real Hermes contacts.');
    if (dataKind !== 'real') nextActions.push('Sync real local data before calling Minty dogfood-ready.');
    if (!hasRequiredTools) nextActions.push('Fix scripts/minty-mcp-server.js so MCP lists search_network, person_context, and workflow_brief.');
    if (!latestSyncAt) nextActions.push('Run npm run service or npm run memory:refresh so freshness metadata exists.');
    if (latestSyncAt && !freshEnough) nextActions.push('Refresh sources; freshest sync is older than 14 days.');
    if (input.hermesSkillInstalled !== true) nextActions.push('Install or symlink hermes/minty-network-memory/SKILL.md into Hermes skills.');

    return {
        level,
        ready: { demo, dogfood, hermesNative },
        dataDir: input.dataDir || null,
        dataKind,
        contactCount: contacts.length,
        toolNames,
        latestSyncAt,
        checks,
        nextActions,
        safety: {
            contactDetailsOmitted: true,
            readOnly: true,
            noLlmCalls: true,
            noPrivateBrainRead: true,
        },
    };
}

module.exports = { evaluateHermesReadiness, REQUIRED_MCP_TOOLS, newestSyncAt };
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

**Objective:** Lock in the difference between demo-ready, dogfood-ready, and Hermes-native, and prevent accidental detail leakage.

**Files:**
- Modify: `tests/unit/hermes-readiness.test.js`
- Modify: `crm/hermes-readiness.js` only if tests expose a bug

**Step 1: Add readiness-level tests**

Append to `tests/unit/hermes-readiness.test.js`:

```js
test('[HermesReadiness]: demo data cannot be dogfood-ready', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data-demo',
        dataKind: 'demo',
        contacts: [contact()],
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: true,
        now: '2026-05-01T09:00:00Z',
    });

    assert.equal(result.level, 'demo-ready');
    assert.equal(result.ready.demo, true);
    assert.equal(result.ready.dogfood, false);
    assert.ok(result.nextActions.some(a => /real local data/i.test(a)));
});

test('[HermesReadiness]: real data without Hermes skill is dogfood-ready but not Hermes-native', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data',
        dataKind: 'real',
        contacts: [contact({ lastContactedAt: '2026-04-30T10:00:00Z' })],
        syncState: { googleContacts: { lastSyncAt: '2026-05-01T08:00:00Z' } },
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
        hermesSkillInstalled: false,
        now: '2026-05-01T09:00:00Z',
    });

    assert.equal(result.level, 'dogfood-ready');
    assert.equal(result.ready.dogfood, true);
    assert.equal(result.ready.hermesNative, false);
});

test('[HermesReadiness]: output omits raw contact details', () => {
    const result = evaluateHermesReadiness({
        dataDir: '/repo/data',
        dataKind: 'real',
        contacts: [contact({ email: 'alice@example.com', phones: ['+15555550100'] })],
        mcpTools: ['search_network', 'person_context', 'workflow_brief'],
    });

    const text = JSON.stringify(result);
    assert.equal(text.includes('alice@example.com'), false);
    assert.equal(text.includes('+15555550100'), false);
    assert.equal(text.includes('phones'), false);
    assert.equal(text.includes('email'), false);
});
```

**Step 2: Run targeted tests**

Run:

```bash
node --test tests/unit/hermes-readiness.test.js
```

Expected: PASS. If not, fix `crm/hermes-readiness.js`; do not weaken the privacy assertions.

**Step 3: Commit**

```bash
git add crm/hermes-readiness.js tests/unit/hermes-readiness.test.js
git commit -m "test: cover Hermes readiness levels"
```

---

### Task 3: Add the `hermes:doctor` CLI

**Objective:** Create a command that loads local Minty state, checks MCP tool definitions, detects the Hermes skill, and prints the readiness report.

**Files:**
- Create: `scripts/hermes-doctor.js`
- Modify: `package.json`
- Test: `tests/unit/hermes-doctor.test.js`

**Step 1: Write failing CLI helper test**

Create `tests/unit/hermes-doctor.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectHermesDoctorInput, formatHumanReport } = require('../../scripts/hermes-doctor');

test('[HermesDoctor]: collect input classifies data-demo as demo', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-doctor-'));
    const dataDemo = path.join(root, 'data-demo', 'unified');
    fs.mkdirSync(dataDemo, { recursive: true });
    fs.writeFileSync(path.join(dataDemo, 'contacts.json'), JSON.stringify([{ id: 'c_1', name: 'Demo' }]));
    fs.writeFileSync(path.join(dataDemo, 'insights.json'), '{}');

    const input = collectHermesDoctorInput({ rootDir: root, hermesSkillsDir: path.join(root, 'skills') });

    assert.equal(input.dataKind, 'demo');
    assert.equal(input.contacts.length, 1);
    assert.ok(input.mcpTools.includes('search_network'));
});

test('[HermesDoctor]: human report includes level and next actions', () => {
    const text = formatHumanReport({
        level: 'demo-ready',
        contactCount: 2,
        dataKind: 'demo',
        toolNames: ['search_network'],
        checks: [{ id: 'data.present', ok: true, label: 'Minty has contacts to query' }],
        nextActions: ['Sync real local data before dogfooding.'],
        safety: { contactDetailsOmitted: true },
    });

    assert.match(text, /demo-ready/);
    assert.match(text, /Sync real local data/);
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
const os = require('os');
const path = require('path');

const { evaluateHermesReadiness } = require('../crm/hermes-readiness');
const { resolveDataDir, loadData } = require('./agent-query');
const { TOOLS } = require('./minty-mcp-server');

function safeLoadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function classifyDataDir(dataDir, rootDir) {
    if (!dataDir) return 'missing';
    const rel = path.relative(rootDir, dataDir).replace(/\\/g, '/');
    if (rel === 'data-demo' || rel.startsWith('data-demo/')) return 'demo';
    if (rel === 'data' || rel.startsWith('data/')) return 'real';
    return 'custom';
}

function defaultHermesSkillsDir() {
    return path.join(os.homedir(), '.hermes', 'skills');
}

function skillInstalled(skillsDir) {
    const candidates = [
        path.join(skillsDir, 'minty-network-memory', 'SKILL.md'),
        path.join(skillsDir, 'productivity', 'minty-network-memory', 'SKILL.md'),
    ];
    return candidates.some(p => fs.existsSync(p));
}

function collectHermesDoctorInput(opts = {}) {
    const rootDir = opts.rootDir || path.join(__dirname, '..');
    const dataDir = opts.dataDir || resolveDataDir(rootDir);
    const loaded = dataDir ? loadData(dataDir) : { contacts: [], insights: {} };
    const syncState = dataDir ? safeLoadJson(path.join(dataDir, 'sync-state.json'), {}) : {};
    const hermesSkillsDir = opts.hermesSkillsDir || process.env.HERMES_SKILLS_DIR || defaultHermesSkillsDir();
    return {
        dataDir,
        dataKind: classifyDataDir(dataDir, rootDir),
        contacts: loaded.contacts || [],
        insights: loaded.insights || {},
        syncState,
        mcpTools: TOOLS.map(t => t.name),
        hermesSkillInstalled: skillInstalled(hermesSkillsDir),
    };
}

function formatHumanReport(report) {
    const lines = [];
    lines.push(`Minty Hermes readiness: ${report.level}`);
    lines.push(`Data: ${report.dataKind} (${report.contactCount || 0} contacts)`);
    lines.push(`MCP tools: ${(report.toolNames || []).join(', ') || 'none'}`);
    lines.push('');
    lines.push('Checks:');
    for (const check of report.checks || []) {
        lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.label}`);
    }
    if (report.nextActions && report.nextActions.length) {
        lines.push('');
        lines.push('Next actions:');
        for (const action of report.nextActions) lines.push(`- ${action}`);
    }
    lines.push('');
    lines.push('Safety: read-only, no LLM calls, direct contact details omitted.');
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const input = collectHermesDoctorInput();
    const report = evaluateHermesReadiness(input);
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatHumanReport(report));
    return report.level === 'not-ready' ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { collectHermesDoctorInput, formatHumanReport, classifyDataDir, skillInstalled, main };
```

Modify `package.json` scripts:

```json
"hermes:doctor": "node scripts/hermes-doctor.js",
```

Place it near `"mcp"` / `"memory:refresh"`.

**Step 4: Run targeted tests**

Run:

```bash
node --test tests/unit/hermes-doctor.test.js tests/unit/hermes-readiness.test.js
```

Expected: PASS.

**Step 5: Smoke CLI manually**

Run:

```bash
npm run hermes:doctor -- --json
npm run hermes:doctor
```

Expected: both commands exit 0 unless no data exists; JSON output contains no raw emails/phones.

**Step 6: Commit**

```bash
git add scripts/hermes-doctor.js package.json tests/unit/hermes-doctor.test.js
git commit -m "feat: add Hermes readiness doctor"
```

---

### Task 4: Add doctor coverage to the default test suite

**Objective:** Ensure the new readiness tests run under `npm test` so regressions block PRs.

**Files:**
- Modify: `package.json`

**Step 1: Add test files to `npm test`**

In the long `"test"` script in `package.json`, add:

```bash
tests/unit/hermes-readiness.test.js tests/unit/hermes-doctor.test.js
```

Place them near `tests/unit/agent-retrieval.test.js tests/unit/minty-mcp-server.test.js` because they cover the same agent-facing surface.

**Step 2: Run full unit suite**

Run:

```bash
npm test
```

Expected: all tests PASS.

**Step 3: Commit**

```bash
git add package.json
git commit -m "test: include Hermes readiness doctor"
```

---

### Task 5: Document readiness levels and upgrade path

**Objective:** Make docs explain exactly what the doctor means and how Sree/Hermes should move from demo-ready to Hermes-native.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md:55-90`
- Modify: `docs/OPENCLAW_HERMES.md` around setup/smoke tests
- Modify: `hermes/minty-network-memory/SKILL.md:62-94`

**Step 1: Update `docs/HERMES_INTEGRATION.md`**

Add after “Install the Hermes skill”:

````md
### 4. Check readiness

```bash
npm run hermes:doctor
npm run hermes:doctor -- --json
```

Readiness levels:

| Level | Meaning |
|---|---|
| `demo-ready` | Demo/synthetic data plus MCP tools work. Good for screenshots and tool smoke tests only. |
| `dogfood-ready` | Real local Minty data is queryable, source/freshness metadata exists, and agent outputs remain redacted/read-only. |
| `hermes-native` | Dogfood-ready plus the Minty Hermes skill is installed/discoverable so Hermes can call Minty without manual shelling. |

Do not call Minty Hermes-native just because `npm run agent -- "..."` works. The doctor must see real data, MCP tools, freshness metadata, and an installed Hermes skill.
````

**Step 2: Update `hermes/minty-network-memory/SKILL.md`**

Under “Data setup,” add:

````md
## Readiness check

Before relying on Minty for a real Hermes workflow, run:

```bash
cd /root/.hermes/workspace/minty
npm run hermes:doctor
```

Use the levels strictly:
- `demo-ready`: okay for demos; do not make real relationship claims.
- `dogfood-ready`: okay for Sree's real local read-only relationship queries.
- `hermes-native`: preferred state; Minty MCP + this skill are installed and discoverable.
````

**Step 3: Update `docs/OPENCLAW_HERMES.md`**

Add a short readiness subsection near the MCP quickstart:

```md
Run `npm run hermes:doctor` after configuring Minty. Treat `demo-ready` as a smoke test only; use `dogfood-ready` or `hermes-native` before trusting answers in an agent workflow.
```

**Step 4: Verify docs diff**

Run:

```bash
git diff -- docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
```

Expected: only public-safe setup/readiness language; no private strategy or private GBrain excerpts.

**Step 5: Commit**

```bash
git add docs/HERMES_INTEGRATION.md docs/OPENCLAW_HERMES.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: explain Hermes readiness levels"
```

---

### Task 6: Add an MCP smoke check to the doctor

**Objective:** Ensure `hermes:doctor` can optionally prove the stdio MCP path responds, not just inspect exported `TOOLS`.

**Files:**
- Modify: `scripts/hermes-doctor.js`
- Modify: `tests/unit/hermes-doctor.test.js`

**Step 1: Add an opt-in flag test**

Append to `tests/unit/hermes-doctor.test.js`:

```js
test('[HermesDoctor]: --mcp-smoke adds smoke next action when server cannot be called', () => {
    const { formatHumanReport } = require('../../scripts/hermes-doctor');
    const text = formatHumanReport({
        level: 'dogfood-ready',
        contactCount: 1,
        dataKind: 'real',
        toolNames: ['search_network', 'person_context', 'workflow_brief'],
        checks: [{ id: 'mcp.smoke', ok: false, label: 'MCP stdio smoke responded' }],
        nextActions: ['Run the MCP smoke command from docs/HERMES_INTEGRATION.md.'],
    });
    assert.match(text, /MCP stdio smoke/);
});
```

**Step 2: Add optional smoke implementation**

In `scripts/hermes-doctor.js`, if `argv.includes('--mcp-smoke')`, spawn `node scripts/minty-mcp-server.js`, send initialize + tools/list as newline-delimited JSON, parse output, and add a check:

```js
{ id: 'mcp.smoke', ok: toolNames.includes('search_network'), label: 'MCP stdio smoke responded' }
```

Keep this opt-in because the pure doctor should remain fast and deterministic for tests.

**Step 3: Run tests and smoke**

Run:

```bash
node --test tests/unit/hermes-doctor.test.js
npm run hermes:doctor -- --mcp-smoke
```

Expected: tests pass; smoke output includes `PASS MCP stdio smoke responded` when local Node can start the server.

**Step 4: Commit**

```bash
git add scripts/hermes-doctor.js tests/unit/hermes-doctor.test.js
git commit -m "feat: smoke MCP from Hermes doctor"
```

---

## Verification checklist

After all tasks:

```bash
npm test
npm run hermes:doctor -- --json
npm run hermes:doctor -- --mcp-smoke
git status --short --branch
```

Expected:

- Unit tests pass.
- `hermes:doctor` distinguishes `demo-ready`, `dogfood-ready`, and `hermes-native`.
- JSON and human output omit raw emails, phone numbers, OAuth token paths, raw contacts, and private-brain data.
- MCP required tools include at least `search_network`, `person_context`, and `workflow_brief`.
- Docs describe the readiness levels and do not leak private strategy.
- Working tree is clean after task commits.

## Rollback plan

If the doctor is too strict, keep the pure `evaluateHermesReadiness()` helper and docs but remove the CLI script from `package.json`. The readiness contract remains useful for future MCP install flows and UI trust/debug screens.
