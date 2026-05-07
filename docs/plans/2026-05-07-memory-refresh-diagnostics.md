# Memory Refresh Diagnostics Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make `npm run memory:refresh` produce deterministic, privacy-safe refresh diagnostics so Hermes can explain exactly which step failed, what artifacts are stale or missing, and what safe command should run next.

**Architecture:** Keep the existing shell refresh entrypoint, but move diagnostic state and artifact checks into a pure CommonJS module (`crm/memory-refresh-diagnostics.js`) with unit tests. Add a small Node runner (`scripts/memory-refresh-diagnostics.js`) that reads command step results and local artifacts, writes a redacted JSON report under `data/unified/memory-refresh-status.json`, and lets `scripts/refresh-hermes-memory.sh` call it after each step without exposing token paths, raw contact data, emails, phones, message bodies, group names, or GBrain private paths.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `scripts/refresh-hermes-memory.sh`, `scripts/agent-query.js`, `scripts/build-contact-evidence.js`, `scripts/build-source-events.js`, `scripts/build-hybrid-index.js`, `scripts/export-gbrain-memory.js`, `data/sync-state.json`, `data/unified/*` artifacts, and `docs/HERMES_INTEGRATION.md`.

---

## Product framing

Minty's current agent-facing trust work is converging: `source_health` tells Hermes whether sources are fresh and evidence-bearing, the MCP envelope is locked down, and evals guard privacy/citation contracts. The next bottleneck is operational: when `npm run memory:refresh` fails halfway through, Sree/Hermes still has to infer from scrollback whether Google Contacts, Telegram live sync, merge, contact evidence, source events, hybrid index, GBrain export, or MCP registration broke.

That creates two bad outcomes:

1. Hermes may answer with stale network memory because a refresh failure was invisible or ambiguous.
2. The user sees a generic failed cron/report instead of a precise, safe next action.

This plan turns refresh failures into deterministic diagnostics. It complements, not duplicates:

- `2026-05-06-agent-source-health-mcp.md`: per-source query readiness before retrieval.
- `2026-05-06-hermes-readiness-doctor.md`: install/demo/dogfood/Hermes-native readiness.
- `2026-05-06-agent-workflow-evals.md`: eval gates for agent envelopes.

`memory-refresh-status.json` answers a narrower question: **did the refresh pipeline that feeds those surfaces actually complete, and which artifact should Hermes distrust until it is fixed?**

## Acceptance criteria

- `npm run memory:refresh` writes or updates `data/unified/memory-refresh-status.json` on both success and failure.
- The status report includes only safe metadata: step ids, status, timestamps, durations, exit codes, artifact presence/mtimes/counts, warnings, and suggested next commands.
- The report never includes emails, phones, OAuth token paths, private brain paths, raw contact ids, raw source rows, message bodies, group chat ids, group names, or shell environment values.
- Refresh steps become inspectable as a stable sequence: `google_contacts`, `telegram`, `merge`, `contact_evidence`, `source_events`, `hybrid_index`, `query_index`, `gbrain_export`, `gbrain_import`, `mcp_smoke`.
- A failed optional step (for example unavailable Hermes CLI) records `skipped`/`warning` instead of hiding earlier successful artifact generation.
- `source_health` and future `hermes:doctor` can read the status file later, but this plan does not add another MCP tool.

## Non-goals

- Do not run syncs from the diagnostic module; it is pure/read-only except the CLI writing the status JSON.
- Do not install Hermes skills, modify MCP config, import private brain broadly, push, deploy, or mutate provider state.
- Do not expose file paths outside repo-local `data/` in the report. Represent sensitive paths as booleans or labels only.
- Do not add runtime LLM calls or new npm dependencies.
- Do not replace `source_health`; this is pipeline/run diagnostics, not per-query source readiness.

---

### Task 1: Add pure refresh report builder

**Objective:** Create a pure module that converts step results and artifact observations into a redacted refresh status envelope.

**Files:**
- Create: `crm/memory-refresh-diagnostics.js`
- Create: `tests/unit/memory-refresh-diagnostics.test.js`
- Modify: `package.json` test script to include `tests/unit/memory-refresh-diagnostics.test.js`

**Step 1: Write failing test**

Create `tests/unit/memory-refresh-diagnostics.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRefreshStatus,
    redactDiagnosticValue,
} = require('../../crm/memory-refresh-diagnostics');

const NOW = '2026-05-07T20:00:00.000Z';

function step(id, status, extra = {}) {
    return {
        id,
        label: id,
        status,
        startedAt: '2026-05-07T19:59:00.000Z',
        finishedAt: '2026-05-07T19:59:02.000Z',
        durationMs: 2000,
        ...extra,
    };
}

test('[MemoryRefreshDiagnostics]: summarizes successful refresh without leaking private paths', () => {
    const report = buildRefreshStatus({
        generatedAt: NOW,
        steps: [
            step('google_contacts', 'ok'),
            step('telegram', 'ok'),
            step('merge', 'ok'),
            step('contact_evidence', 'ok'),
            step('source_events', 'ok'),
            step('hybrid_index', 'ok'),
            step('query_index', 'ok'),
            step('gbrain_export', 'ok'),
            step('gbrain_import', 'ok'),
            step('mcp_smoke', 'skipped', { warning: 'hermes CLI not available' }),
        ],
        artifacts: {
            contacts: { exists: true, count: 12, mtime: NOW, path: '/root/.hermes/workspace/minty/data/unified/contacts.json' },
            contactEvidence: { exists: true, count: 8, mtime: NOW },
            sourceEvents: { exists: true, count: 20, mtime: NOW },
            gbrainJsonl: { exists: true, count: 12, mtime: NOW, path: '/root/.hermes/workspace/minty/data/gbrain/relationship-memory.jsonl' },
        },
    });

    assert.equal(report.status, 'warning');
    assert.equal(report.generatedAt, NOW);
    assert.equal(report.steps.length, 10);
    assert.equal(report.artifacts.contacts.count, 12);
    assert.equal(report.artifacts.contacts.path, undefined, 'repo paths should not be serialized');
    assert.deepEqual(report.nextActions, ['Install or expose Hermes CLI, then rerun npm run memory:refresh to verify MCP registration.']);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('/root/.hermes'), false);
    assert.equal(serialized.includes('google_token'), false);
});

test('[MemoryRefreshDiagnostics]: failed required step marks downstream artifacts stale', () => {
    const report = buildRefreshStatus({
        generatedAt: NOW,
        steps: [
            step('google_contacts', 'ok'),
            step('telegram', 'failed', { exitCode: 1, error: 'TELEGRAM_API_HASH missing at /root/.hermes/workspace/minty/.env' }),
            step('merge', 'skipped'),
        ],
        artifacts: {
            contacts: { exists: true, count: 5, mtime: '2026-05-01T00:00:00.000Z' },
            sourceEvents: { exists: false },
        },
    });

    assert.equal(report.status, 'failed');
    assert.equal(report.failedStep, 'telegram');
    assert.ok(report.warnings.includes('sourceEvents_missing'));
    assert.equal(report.nextActions[0], 'Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.');

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('TELEGRAM_API_HASH'), false, 'secret env var names should be generalized');
    assert.equal(serialized.includes('/root/.hermes'), false, 'private paths should be redacted');
});

test('[MemoryRefreshDiagnostics]: redacts direct contact details and message-like strings', () => {
    const value = redactDiagnosticValue('alice@example.com +14155550100 raw message from private group /root/.hermes/google_token.json');
    assert.equal(value.includes('alice@example.com'), false);
    assert.equal(value.includes('+14155550100'), false);
    assert.equal(value.includes('raw message'), false);
    assert.equal(value.includes('/root/.hermes'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/memory-refresh-diagnostics.test.js
```

Expected: FAIL — `Cannot find module '../../crm/memory-refresh-diagnostics'`.

**Step 3: Write minimal implementation**

Create `crm/memory-refresh-diagnostics.js`:

```js
'use strict';

const SAFE_STEP_IDS = new Set([
    'google_contacts',
    'telegram',
    'merge',
    'contact_evidence',
    'source_events',
    'hybrid_index',
    'query_index',
    'gbrain_export',
    'gbrain_import',
    'mcp_smoke',
]);

const STEP_NEXT_ACTIONS = {
    google_contacts: 'Fix Google Contacts sync credentials or token profile selection, then rerun npm run memory:refresh.',
    telegram: 'Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.',
    merge: 'Fix source import output and rerun npm run merge, then npm run memory:refresh.',
    contact_evidence: 'Run npm run contact-evidence after merge succeeds, then rerun npm run memory:refresh.',
    source_events: 'Run npm run source-events after contact evidence succeeds, then rerun npm run memory:refresh.',
    hybrid_index: 'Run npm run hybrid-index after source events exist, then rerun npm run memory:refresh.',
    query_index: 'Run npm run index after merge succeeds, then rerun npm run memory:refresh.',
    gbrain_export: 'Run npm run gbrain:export after unified data exists, then rerun npm run memory:refresh.',
    gbrain_import: 'Install or repair gbrain-hermes/private brain import, then rerun npm run memory:refresh.',
    mcp_smoke: 'Install or expose Hermes CLI, then rerun npm run memory:refresh to verify MCP registration.',
};

function redactDiagnosticValue(value) {
    if (value == null) return value;
    const raw = String(value);
    let text = raw
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
        .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted-phone]')
        .replace(/\/root\/\.hermes\/[^\s"']+/g, '[redacted-private-path]')
        .replace(/\/[^\s"']*google_token[^\s"']*/gi, '[redacted-token-path]')
        .replace(/TELEGRAM_API_(ID|HASH)|TELEGRAM_SESSION|MINTY_GOOGLE_TOKEN_FILES/g, '[redacted-secret-name]')
        .replace(/raw message[^.\n]*/gi, '[redacted-message]')
        .replace(/group chat[^.\n]*/gi, '[redacted-group]');
    if (text.length > 180) text = text.slice(0, 177) + '...';
    return text;
}

function safeIso(value) {
    if (typeof value !== 'string') return null;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString();
}

function sanitizeStep(step) {
    const id = SAFE_STEP_IDS.has(step && step.id) ? step.id : 'unknown';
    const status = ['ok', 'failed', 'skipped', 'warning'].includes(step && step.status) ? step.status : 'warning';
    const out = {
        id,
        label: id,
        status,
        startedAt: safeIso(step && step.startedAt),
        finishedAt: safeIso(step && step.finishedAt),
    };
    const duration = Number(step && step.durationMs);
    if (Number.isFinite(duration) && duration >= 0) out.durationMs = Math.floor(duration);
    const exitCode = Number(step && step.exitCode);
    if (Number.isInteger(exitCode)) out.exitCode = exitCode;
    if (step && step.error) out.error = redactDiagnosticValue(step.error);
    if (step && step.warning) out.warning = redactDiagnosticValue(step.warning);
    return out;
}

function sanitizeArtifact(row) {
    const exists = Boolean(row && row.exists);
    const out = { exists };
    if (Number.isFinite(row && row.count)) out.count = Math.max(0, Math.floor(row.count));
    const mtime = safeIso(row && row.mtime);
    if (mtime) out.mtime = mtime;
    return out;
}

function buildRefreshStatus(input = {}) {
    const steps = Array.isArray(input.steps) ? input.steps.map(sanitizeStep) : [];
    const artifacts = {};
    for (const [name, row] of Object.entries(input.artifacts || {})) {
        artifacts[name] = sanitizeArtifact(row);
    }

    const failed = steps.find(s => s.status === 'failed');
    const warnings = [];
    for (const [name, row] of Object.entries(artifacts)) {
        if (!row.exists) warnings.push(`${name}_missing`);
    }
    for (const step of steps) {
        if (step.status === 'warning' || step.status === 'skipped') warnings.push(`${step.id}_${step.status}`);
    }

    const status = failed ? 'failed' : warnings.length ? 'warning' : 'ok';
    const nextActions = [];
    if (failed && STEP_NEXT_ACTIONS[failed.id]) nextActions.push(STEP_NEXT_ACTIONS[failed.id]);
    if (!failed) {
        for (const step of steps) {
            if ((step.status === 'warning' || step.status === 'skipped') && STEP_NEXT_ACTIONS[step.id]) {
                nextActions.push(STEP_NEXT_ACTIONS[step.id]);
                break;
            }
        }
    }
    if (!nextActions.length && warnings.some(w => w.endsWith('_missing'))) {
        nextActions.push('Rerun npm run memory:refresh so missing privacy-safe artifacts are rebuilt.');
    }

    return {
        schemaVersion: 1,
        generatedAt: safeIso(input.generatedAt) || new Date().toISOString(),
        status,
        failedStep: failed ? failed.id : null,
        steps,
        artifacts,
        warnings: [...new Set(warnings)].sort(),
        nextActions,
        safety: {
            redacted: true,
            directContactDetailsOmitted: true,
            privatePathsOmitted: true,
            rawMessagesOmitted: true,
            readOnlyDiagnostics: true,
        },
    };
}

module.exports = {
    SAFE_STEP_IDS,
    STEP_NEXT_ACTIONS,
    buildRefreshStatus,
    redactDiagnosticValue,
    sanitizeArtifact,
    sanitizeStep,
};
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/memory-refresh-diagnostics.test.js
```

Expected: PASS.

**Step 5: Add the test to the package test list**

Modify `package.json` script `test` and insert `tests/unit/memory-refresh-diagnostics.test.js` near `tests/unit/agent-source-health.test.js` / `tests/unit/gbrain-export.test.js`.

Run:

```bash
npm test -- --test-name-pattern='MemoryRefreshDiagnostics'
```

Expected: PASS. If Node's runner does not apply the pattern to the explicit script list in this repo, run the direct test command above and then `npm test` during final verification.

**Step 6: Commit**

```bash
git add crm/memory-refresh-diagnostics.js tests/unit/memory-refresh-diagnostics.test.js package.json
git commit -m "feat: add memory refresh diagnostics model"
```

---

### Task 2: Add artifact inspection and status writer CLI

**Objective:** Add a local CLI that reads repo artifacts, builds the safe status report, and writes `data/unified/memory-refresh-status.json`.

**Files:**
- Create: `scripts/memory-refresh-diagnostics.js`
- Create: `tests/unit/memory-refresh-diagnostics-cli.test.js`
- Modify: `package.json` scripts and test list

**Step 1: Write failing test**

Create `tests/unit/memory-refresh-diagnostics-cli.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    inspectArtifacts,
    loadStepsFile,
    writeRefreshStatus,
} = require('../../scripts/memory-refresh-diagnostics');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function writeJsonl(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('[MemoryRefreshDiagnosticsCLI]: inspects only artifact metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-refresh-diag-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), [
        { id: 'contact_secret', name: 'Alice', emails: ['alice@example.com'], phones: ['+141****0100'] },
    ]);
    writeJson(path.join(dir, 'unified', 'contact-evidence.json'), { contact_secret: { topics: ['private topic'] } });
    writeJson(path.join(dir, 'unified', 'source-events.json'), [{ id: 'event_secret', source: 'telegram' }]);
    writeJson(path.join(dir, 'unified', 'hybrid-index.json'), [{ contactRef: 'contact_secret' }]);
    writeJsonl(path.join(dir, 'gbrain', 'relationship-memory.jsonl'), [{ person: 'Alice' }]);

    const artifacts = inspectArtifacts(dir);
    assert.equal(artifacts.contacts.exists, true);
    assert.equal(artifacts.contacts.count, 1);
    assert.equal(artifacts.contactEvidence.count, 1);
    assert.equal(artifacts.sourceEvents.count, 1);
    assert.equal(artifacts.hybridIndex.count, 1);
    assert.equal(artifacts.gbrainJsonl.count, 1);
    assert.equal(JSON.stringify(artifacts).includes('alice@example.com'), false);
    assert.equal(JSON.stringify(artifacts).includes('contact_secret'), false);
});

test('[MemoryRefreshDiagnosticsCLI]: writes redacted status JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-refresh-diag-write-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    const stepsPath = path.join(dir, 'refresh-steps.json');
    writeJson(stepsPath, [
        { id: 'gbrain_import', status: 'failed', error: 'failed under /root/.hermes/private/brain for bob@example.com', exitCode: 1 },
    ]);

    const result = writeRefreshStatus({ dataDir: dir, stepsFile: stepsPath, generatedAt: '2026-05-07T20:10:00Z' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failedStep, 'gbrain_import');
    assert.ok(fs.existsSync(path.join(dir, 'unified', 'memory-refresh-status.json')));
    const serialized = fs.readFileSync(path.join(dir, 'unified', 'memory-refresh-status.json'), 'utf8');
    assert.equal(serialized.includes('/root/.hermes'), false);
    assert.equal(serialized.includes('bob@example.com'), false);
});

test('[MemoryRefreshDiagnosticsCLI]: missing steps file is safe empty input', () => {
    const steps = loadStepsFile('/tmp/does-not-exist-minty-refresh-steps.json');
    assert.deepEqual(steps, []);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/memory-refresh-diagnostics-cli.test.js
```

Expected: FAIL — `Cannot find module '../../scripts/memory-refresh-diagnostics'`.

**Step 3: Write minimal implementation**

Create `scripts/memory-refresh-diagnostics.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveDataDir } = require('./agent-query');
const { buildRefreshStatus } = require('../crm/memory-refresh-diagnostics');

function readJson(file, fallback) {
    if (!file || !fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function countJson(value) {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return 0;
}

function inspectJsonArtifact(file) {
    if (!fs.existsSync(file)) return { exists: false };
    const parsed = readJson(file, null);
    const stat = fs.statSync(file);
    return { exists: true, count: countJson(parsed), mtime: stat.mtime.toISOString() };
}

function inspectJsonlArtifact(file) {
    if (!fs.existsSync(file)) return { exists: false };
    const raw = fs.readFileSync(file, 'utf8');
    const count = raw.split(/\n/).filter(line => line.trim()).length;
    const stat = fs.statSync(file);
    return { exists: true, count, mtime: stat.mtime.toISOString() };
}

function inspectArtifacts(dataDir) {
    const unified = path.join(dataDir, 'unified');
    return {
        contacts: inspectJsonArtifact(path.join(unified, 'contacts.json')),
        interactions: inspectJsonArtifact(path.join(unified, 'interactions.json')),
        insights: inspectJsonArtifact(path.join(unified, 'insights.json')),
        contactEvidence: inspectJsonArtifact(path.join(unified, 'contact-evidence.json')),
        sourceEvents: inspectJsonArtifact(path.join(unified, 'source-events.json')),
        hybridIndex: inspectJsonArtifact(path.join(unified, 'hybrid-index.json')),
        syncState: inspectJsonArtifact(path.join(dataDir, 'sync-state.json')),
        gbrainJsonl: inspectJsonlArtifact(path.join(dataDir, 'gbrain', 'relationship-memory.jsonl')),
        gbrainMarkdown: fs.existsSync(path.join(dataDir, 'gbrain', 'relationship-memory.md'))
            ? { exists: true, mtime: fs.statSync(path.join(dataDir, 'gbrain', 'relationship-memory.md')).mtime.toISOString() }
            : { exists: false },
    };
}

function loadStepsFile(file) {
    const parsed = readJson(file, []);
    return Array.isArray(parsed) ? parsed : [];
}

function writeRefreshStatus(opts = {}) {
    const dataDir = opts.dataDir || resolveDataDir() || path.join(__dirname, '..', 'data');
    const steps = opts.steps || loadStepsFile(opts.stepsFile || path.join(dataDir, 'unified', '.memory-refresh-steps.json'));
    const report = buildRefreshStatus({
        generatedAt: opts.generatedAt || new Date().toISOString(),
        steps,
        artifacts: inspectArtifacts(dataDir),
    });
    const outPath = opts.outPath || path.join(dataDir, 'unified', 'memory-refresh-status.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    return report;
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--data-dir') opts.dataDir = path.resolve(argv[++i]);
        else if (arg === '--steps-file') opts.stepsFile = path.resolve(argv[++i]);
        else if (arg === '--out') opts.outPath = path.resolve(argv[++i]);
        else if (arg === '--json') opts.json = true;
    }
    return opts;
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    const report = writeRefreshStatus(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Minty memory refresh status: ${report.status}${report.failedStep ? ` (failed: ${report.failedStep})` : ''}`);
}

module.exports = {
    countJson,
    inspectArtifacts,
    loadStepsFile,
    parseArgs,
    writeRefreshStatus,
};
```

**Step 4: Add npm script and package test entry**

Modify `package.json`:

- Add script near `memory:refresh`:

```json
"memory:diagnostics": "node scripts/memory-refresh-diagnostics.js"
```

- Add `tests/unit/memory-refresh-diagnostics-cli.test.js` to the explicit `test` script near the diagnostics model test.

**Step 5: Run tests to verify pass**

Run:

```bash
node --test tests/unit/memory-refresh-diagnostics.test.js tests/unit/memory-refresh-diagnostics-cli.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/memory-refresh-diagnostics.js tests/unit/memory-refresh-diagnostics-cli.test.js package.json
git commit -m "feat: add memory refresh diagnostics CLI"
```

---

### Task 3: Instrument `memory:refresh` steps without breaking fail-fast behavior

**Objective:** Have `scripts/refresh-hermes-memory.sh` record each pipeline step and write status on exit, including failures.

**Files:**
- Modify: `scripts/refresh-hermes-memory.sh`
- Create: `tests/unit/refresh-hermes-memory-script.test.js`

**Step 1: Write failing script characterization test**

Create `tests/unit/refresh-hermes-memory-script.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'refresh-hermes-memory.sh');

test('[memory:refresh script]: records diagnostics on exit and wraps key commands', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(text.includes('record_step'), 'script should define record_step helper');
    assert.ok(text.includes('write_refresh_status'), 'script should write status on exit');
    assert.ok(text.includes('trap write_refresh_status EXIT'), 'script should emit status even after failure');
    for (const id of [
        'google_contacts',
        'telegram',
        'merge',
        'contact_evidence',
        'source_events',
        'hybrid_index',
        'query_index',
        'gbrain_export',
        'gbrain_import',
        'mcp_smoke',
    ]) {
        assert.ok(text.includes(`\"${id}\"`) || text.includes(`'${id}'`), `missing step id ${id}`);
    }
});

test('[memory:refresh script]: does not echo token paths into diagnostics', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.equal(/record_step[^\n]+google_token/.test(text), false, 'token paths must not be recorded in step errors');
    assert.equal(/record_step[^\n]+MINTY_GOOGLE_TOKEN_FILES/.test(text), false, 'token env values must not be recorded');
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/refresh-hermes-memory-script.test.js
```

Expected: FAIL — helper names are not present yet.

**Step 3: Add diagnostics helpers to the shell script**

Modify the top of `scripts/refresh-hermes-memory.sh` after `cd "$ROOT_DIR"`:

```bash
DATA_DIR="${CRM_DATA_DIR:-$ROOT_DIR/data}"
UNIFIED_DIR="$DATA_DIR/unified"
STEPS_FILE="$UNIFIED_DIR/.memory-refresh-steps.json"
mkdir -p "$UNIFIED_DIR"
printf '[]\n' > "$STEPS_FILE"

json_escape() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] || ""))' "$1"
}

append_step_json() {
  local json="$1"
  node - "$STEPS_FILE" "$json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const row = JSON.parse(process.argv[3]);
let rows = [];
try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (!Array.isArray(rows)) rows = [];
rows.push(row);
fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
NODE
}

record_step() {
  local id="$1"
  local status="$2"
  local started_at="$3"
  local exit_code="${4:-0}"
  local message="${5:-}"
  local finished_at
  finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  append_step_json "{\"id\":$(json_escape "$id"),\"status\":$(json_escape "$status"),\"startedAt\":$(json_escape "$started_at"),\"finishedAt\":$(json_escape "$finished_at"),\"exitCode\":$exit_code,\"error\":$(json_escape "$message")}"
}

run_required_step() {
  local id="$1"
  shift
  local started_at code
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$@"; then
    record_step "$id" "ok" "$started_at" 0 ""
  else
    # Assign separately from `local`; `local code=$?` would clobber the failing command exit code.
    code=$?
    record_step "$id" "failed" "$started_at" "$code" "command failed"
    return "$code"
  fi
}

run_optional_step() {
  local id="$1"
  shift
  local started_at code
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$@"; then
    record_step "$id" "ok" "$started_at" 0 ""
  else
    # Assign separately from `local`; `local code=$?` would clobber the failing command exit code.
    code=$?
    record_step "$id" "warning" "$started_at" "$code" "optional command failed or unavailable"
    return 0
  fi
}

write_refresh_status() {
  local original_status=$?
  local diagnostics_status=0
  node scripts/memory-refresh-diagnostics.js --data-dir "$DATA_DIR" --steps-file "$STEPS_FILE"
  diagnostics_status=$?
  if [ "$diagnostics_status" -ne 0 ]; then
    echo "Minty memory refresh diagnostics generation failed (DATA_DIR=$DATA_DIR STEPS_FILE=$STEPS_FILE)" >&2
    return "$diagnostics_status"
  fi
  return "$original_status"
}
trap write_refresh_status EXIT
```

Then wrap the existing commands:

- `npm run google-contacts:hermes` → `run_required_step "google_contacts" npm run google-contacts:hermes`
- `npm run telegram:live` success/fallback block should record one `telegram` step total:
  - live success: `record_step "telegram" "ok" "$started_at" 0 ""`
  - live failure + export success: `record_step "telegram" "warning" "$started_at" 0 "live sync failed; used Desktop export fallback"`
  - skipped due no credentials/export: `record_step "telegram" "skipped" "$started_at" 0 "no live credentials or Desktop export found"`
- `npm run merge` → `run_required_step "merge" npm run merge`
- `npm run contact-evidence` → `run_required_step "contact_evidence" npm run contact-evidence`
- `npm run source-events` → `run_required_step "source_events" npm run source-events`
- `npm run hybrid-index` → `run_required_step "hybrid_index" npm run hybrid-index`
- `npm run index` → `run_required_step "query_index" npm run index`
- `npm run gbrain:export -- --data-dir "$ROOT_DIR/data" --out-dir "$ROOT_DIR/data/gbrain"` → `run_required_step "gbrain_export" npm run gbrain:export -- --data-dir "$DATA_DIR" --out-dir "$DATA_DIR/gbrain"`
- `gbrain-hermes import ...` → `run_optional_step "gbrain_import" gbrain-hermes import /root/.hermes/private/brain --no-embed`
- `hermes mcp test minty` → `run_optional_step "mcp_smoke" hermes mcp test minty`

Keep echo output human-friendly, but do not echo raw token paths or environment values.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/refresh-hermes-memory-script.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/refresh-hermes-memory.sh tests/unit/refresh-hermes-memory-script.test.js
git commit -m "feat: record memory refresh diagnostics"
```

---

### Task 4: Surface refresh status in source health diagnostics

**Objective:** Let source readiness reports include the last refresh status summary without adding another MCP tool.

**Files:**
- Modify: `scripts/agent-query.js`
- Modify: `crm/agent-source-health.js`
- Modify: `tests/unit/agent-query-sync-state.test.js`
- Modify: `tests/unit/agent-source-health.test.js`
- Modify: `scripts/minty-mcp-server.js`
- Modify: `tests/unit/minty-mcp-server.test.js`

**Step 1: Write failing tests**

Append to `tests/unit/agent-query-sync-state.test.js`:

```js
test('[AgentQuery]: loadData loads redacted memory refresh status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-refresh-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unified', 'contacts.json'), '[]\n');
    fs.writeFileSync(path.join(dir, 'unified', 'memory-refresh-status.json'), JSON.stringify({
        status: 'failed',
        failedStep: 'telegram',
        nextActions: ['Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.'],
        safety: { redacted: true },
    }));

    const data = loadData(dir);
    assert.equal(data.memoryRefreshStatus.status, 'failed');
    assert.equal(data.memoryRefreshStatus.failedStep, 'telegram');
    assert.equal(JSON.stringify(data.memoryRefreshStatus).includes('/root/.hermes'), false);
});
test('[AgentQuery]: loadData redacts and validates memory refresh status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-refresh-redact-'));
    fs.mkdirSync(path.join(dir, 'unified'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unified', 'contacts.json'), '[]\n');
    fs.writeFileSync(path.join(dir, 'unified', 'memory-refresh-status.json'), JSON.stringify({
        status: 'failed',
        failedStep: '/root/.hermes/private/brain',
        generatedAt: '2026-05-07 20:00:00',
        nextActions: ['Fix token path /root/.hermes/google_token.json for alice@example.com and rerun.'],
        safety: { redacted: true },
    }));

    const data = loadData(dir);
    assert.equal(data.memoryRefreshStatus.failedStep, null);
    assert.equal(data.memoryRefreshStatus.generatedAt, null);
    assert.equal(JSON.stringify(data.memoryRefreshStatus).includes('/root/.hermes'), false);
    assert.equal(JSON.stringify(data.memoryRefreshStatus).includes('alice@example.com'), false);
});
```

Append to `tests/unit/agent-source-health.test.js`:

```js
test('[AgentSourceHealth]: includes memory refresh status summary', () => {
    const envelope = buildAgentSourceHealth({
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: {},
        memoryRefreshStatus: {
            status: 'failed',
            failedStep: 'telegram',
            generatedAt: '2026-05-07T20:00:00Z',
            nextActions: ['Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.'],
            safety: { redacted: true },
        },
    });

    assert.equal(envelope.refresh.status, 'failed');
    assert.equal(envelope.refresh.failedStep, 'telegram');
    assert.deepEqual(envelope.refresh.nextActions, ['Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.']);
    assert.equal(JSON.stringify(envelope.refresh).includes('/root/.hermes'), false);
});
```

Append to `tests/unit/minty-mcp-server.test.js` near existing `source_health` tests:

```js
it('source_health includes memory refresh status without private diagnostics', async () => {
    const resp = await handleMessage({
        jsonrpc: '2.0', id: 70, method: 'tools/call',
        params: { name: 'source_health', arguments: {} },
    }, {
        contacts: [],
        interactions: [],
        contactEvidence: {},
        sourceEvents: [],
        syncState: {},
        memoryRefreshStatus: {
            status: 'failed',
            failedStep: 'telegram',
            generatedAt: '2026-05-07T20:00:00Z',
            nextActions: ['Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.'],
            safety: { redacted: true },
        },
    });
    const parsed = JSON.parse(resp.result.content[0].text);
    assert.equal(parsed.refresh.status, 'failed');
    assert.equal(parsed.refresh.failedStep, 'telegram');
    assert.equal(JSON.stringify(parsed).includes('/root/.hermes'), false);
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/unit/agent-query-sync-state.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
```

Expected: FAIL — `memoryRefreshStatus` / `refresh` fields are missing.

**Step 3: Update `scripts/agent-query.js` loader**

In `loadData(dataDir)`, import the shared redactor and add a sanitized loader for `unified/memory-refresh-status.json`:

```js
const { redactDiagnosticValue } = require('../crm/memory-refresh-diagnostics');
const SAFE_REFRESH_STEP_IDS = new Set([
    'google_contacts',
    'telegram',
    'merge',
    'contact_evidence',
    'source_events',
    'hybrid_index',
    'query_index',
    'gbrain_export',
    'gbrain_import',
    'mcp_smoke',
]);

function safeRefreshIso(value) {
    if (typeof value !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    return new Date(t).toISOString();
}

function sanitizeMemoryRefreshStatus(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const failedStep = typeof parsed.failedStep === 'string' && SAFE_REFRESH_STEP_IDS.has(parsed.failedStep)
        ? parsed.failedStep
        : null;
    const generatedAt = safeRefreshIso(parsed.generatedAt);
    const nextActions = Array.isArray(parsed.nextActions)
        ? parsed.nextActions
            .filter(v => typeof v === 'string')
            .map(v => redactDiagnosticValue(v))
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const out = {
        status: ['ok', 'warning', 'failed'].includes(parsed.status) ? parsed.status : 'warning',
        failedStep,
        generatedAt,
        nextActions,
    };
    return out;
}

function loadRefreshStatus() {
    const p = path.join(dataDir, 'unified', 'memory-refresh-status.json');
    if (!fs.existsSync(p)) return null;
    try { return sanitizeMemoryRefreshStatus(JSON.parse(fs.readFileSync(p, 'utf8'))); }
    catch { return null; }
}
```

Then include `memoryRefreshStatus: loadRefreshStatus()` in the returned object.

**Step 4: Update `crm/agent-source-health.js`**

Inside the envelope returned by `buildAgentSourceHealth()`, add a `refresh` section:

```js
const refresh = data.memoryRefreshStatus && typeof data.memoryRefreshStatus === 'object'
    ? {
        status: data.memoryRefreshStatus.status || 'warning',
        failedStep: data.memoryRefreshStatus.failedStep || null,
        generatedAt: data.memoryRefreshStatus.generatedAt || null,
        nextActions: Array.isArray(data.memoryRefreshStatus.nextActions) ? data.memoryRefreshStatus.nextActions.slice(0, 3) : [],
    }
    : { status: 'unknown', failedStep: null, generatedAt: null, nextActions: ['Run npm run memory:refresh to generate refresh diagnostics.'] };
```

Then include `refresh` at top level. Do not include raw `steps`, raw artifact names with paths, or errors.

**Step 5: Pass refresh status through MCP**

In `scripts/minty-mcp-server.js`, inside `executeTool`, add:

```js
const memoryRefreshStatus = (data.memoryRefreshStatus && typeof data.memoryRefreshStatus === 'object' && !Array.isArray(data.memoryRefreshStatus)) ? data.memoryRefreshStatus : null;
```

Then pass it into `buildAgentSourceHealth`:

```js
{ contacts, interactions, contactEvidence, sourceEvents, syncState, memoryRefreshStatus }
```

**Step 6: Run tests to verify pass**

Run:

```bash
node --test tests/unit/agent-query-sync-state.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 7: Commit**

```bash
git add scripts/agent-query.js crm/agent-source-health.js scripts/minty-mcp-server.js tests/unit/agent-query-sync-state.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
git commit -m "feat: expose refresh diagnostics in source health"
```

---

### Task 5: Document the refresh diagnostic workflow

**Objective:** Make the status file and safe next actions discoverable to Hermes users without implying that Minty sends raw relationship memory to GBrain automatically.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Modify: `hermes/minty-network-memory/SKILL.md`

**Step 1: Update Hermes integration docs**

Add after the `source_health` tool description in `docs/HERMES_INTEGRATION.md`:

````md
## Memory refresh diagnostics

`npm run memory:refresh` writes a redacted status report to:

```text
data/unified/memory-refresh-status.json
```

The report is for Hermes/debugging only. It records step ids, status, timestamps, artifact counts, warnings, and safe next actions. It does **not** include emails, phones, token paths, private brain paths, raw contact ids, raw message bodies, group ids, or group names.

Use it when:

- `source_health` says a source is stale or empty;
- an agent answer seems based on old relationship memory;
- `npm run gbrain:export` did not update private relationship-memory artifacts;
- Hermes needs to decide whether to trust the latest Minty refresh before answering a network query.

Typical recovery loop:

```bash
npm run memory:refresh
npm run memory:diagnostics -- --json
npm run source-health   # if/when a CLI wrapper exists; otherwise call MCP source_health
```

`memory:refresh` is allowed to copy the privacy-safe `data/gbrain/relationship-memory.md` into the private brain when local `gbrain-hermes` is available. It must never export raw contacts, raw message bodies, direct contact details, token paths, or broad private-data dumps.
````

If `source-health` CLI does not exist, keep that line as a note or omit it; do not invent a script name in docs unless implemented.

**Step 2: Update Hermes skill guidance**

In `hermes/minty-network-memory/SKILL.md`, add a short “If retrieval looks stale” section:

````md
## If retrieval looks stale

Before guessing, ask Minty for source health. If the source-health envelope reports `refresh.status: failed` or `warning`, treat answers as stale until the listed safe next action is run.

Safe commands:

```bash
cd /root/.hermes/workspace/minty
npm run memory:refresh
npm run memory:diagnostics -- --json
```

Do not print or request token paths, emails, phones, raw message bodies, raw contact ids, private brain paths, group names, or group ids. Report only the failed step id, artifact counts/freshness, and safe next action.
````

**Step 3: Verify docs**

Run:

```bash
node --test tests/unit/memory-refresh-diagnostics.test.js tests/unit/memory-refresh-diagnostics-cli.test.js tests/unit/refresh-hermes-memory-script.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md hermes/minty-network-memory/SKILL.md
git commit -m "docs: document memory refresh diagnostics"
```

---

## Final verification

Run focused tests:

```bash
node --test tests/unit/memory-refresh-diagnostics.test.js tests/unit/memory-refresh-diagnostics-cli.test.js tests/unit/refresh-hermes-memory-script.test.js tests/unit/agent-query-sync-state.test.js tests/unit/agent-source-health.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

Run the package test suite if time allows:

```bash
npm test
```

Expected: PASS.

Run a demo refresh smoke without real private data if the environment is safe:

```bash
npm run seed:demo
CRM_DATA_DIR=./data-demo npm run memory:diagnostics -- --json
```

Expected: JSON prints `status`, `artifacts`, `warnings`, `nextActions`, and `safety`; it contains no emails, phones, raw ids, token paths, private brain paths, message bodies, group ids, or group names.

Run final repo checks:

```bash
git diff --check
git status --short --branch
git log --oneline -5
```

Expected: clean worktree after the task commits.

## Implementation notes for reviewers

- Review `scripts/refresh-hermes-memory.sh` carefully. The hard part is preserving fail-fast behavior while still writing the status file via `trap`.
- The shell script may know token paths internally to run syncs, but diagnostics must only record labels/status and generic failure messages.
- If any test needs synthetic contacts, use obvious fake PII sentinels and assert they do not serialize.
- If this plan conflicts with a future `hermes:doctor` implementation, keep this report as an input to the doctor rather than duplicating readiness logic.
