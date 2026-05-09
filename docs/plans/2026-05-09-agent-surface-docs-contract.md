# Agent Surface Docs Contract Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Prevent Minty's Hermes skill and integration docs from drifting behind the actual MCP/server interface, so agents know which source-backed private-network tools are safe to call.

**Architecture:** Keep the MCP server as the source of truth. Add a small test-only contract that imports `TOOLS` from `scripts/minty-mcp-server.js` and verifies the agent-facing documentation surfaces mention every registered tool and every supported npm command that Hermes depends on. Update `docs/HERMES_INTEGRATION.md` and `hermes/minty-network-memory/SKILL.md` to describe the current four-tool surface, source-filter inputs, readiness doctor, memory refresh status, and the rule that future MCP tools must update docs in the same PR.

**Tech Stack:** Plain Node.js CommonJS, Node built-in test runner, existing `scripts/minty-mcp-server.js`, `package.json`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`, `tests/unit/`.

---

## Product framing

Minty's product wedge is Hermes/OpenClaw/MCP-native private network memory, not a separate CRM UI. The repo has been correctly adding trustworthy agent surfaces: `search_network`, `person_context`, `workflow_brief`, `source_health`, source filters, `npm run hermes:doctor`, `npm run memory:refresh`, and privacy-safe GBrain export. But the Hermes skill is now already slightly behind the actual interface: it describes only the original three workflows in its trigger section, only gives a thin `source_health` note, and has no automated guard that catches future drift.

That matters because Hermes will follow the skill. If the skill does not mention `source_health`, source filters, readiness status, or future tools like `intro_paths`/`meeting_prep`, Sree's agents will keep shelling around Minty or answering from incomplete context. This plan turns the docs/skill into a tested part of the product contract.

This complements existing plans rather than duplicating them:

- `2026-05-06-hermes-readiness-doctor.md` builds readiness diagnostics.
- `2026-05-06-agent-source-health-mcp.md` builds source-readiness preflight.
- `2026-05-07-agent-intro-paths-mcp.md` and `2026-04-30-agent-meeting-prep-mcp.md` add new activation tools.
- This plan prevents those agent-facing surfaces from becoming invisible or stale in the Hermes skill/docs.

## Success criteria

- A new unit test fails if any MCP tool in `TOOLS` is missing from `docs/HERMES_INTEGRATION.md` or `hermes/minty-network-memory/SKILL.md`.
- The same test fails if required Hermes workflow commands (`npm run mcp`, `npm run agent`, `npm run memory:refresh`, `npm run hermes:doctor`, `npm run gbrain:export`) disappear from both docs surfaces.
- The Hermes skill explicitly tells agents to call `source_health` before source-specific or stale/low-evidence queries.
- The Hermes skill documents `source`/`sources` filters for `search_network` and the three readiness levels: demo-ready, dogfood-ready, Hermes-native.
- `docs/HERMES_INTEGRATION.md` states that adding/removing an MCP tool requires updating the skill/docs and the exact tool-list assertion in `tests/unit/minty-mcp-server.test.js`.
- No runtime behavior changes; docs/tests only.

## Non-goals

- Do not add a new MCP tool in this plan.
- Do not change `TOOLS`, privacy envelopes, source-health behavior, or data loaders.
- Do not install/symlink the skill into a live Hermes config automatically.
- Do not read or export real contacts, emails, phones, messages, source handles, or private data.
- Do not modify cron jobs, providers, deployment settings, or external systems.

---

### Task 1: Add an agent-surface documentation contract test

**Objective:** Make the actual MCP tool registry drive a failing docs/skill drift test.

**Files:**
- Create: `tests/unit/agent-surface-docs.test.js`
- Read-only dependency: `scripts/minty-mcp-server.js`
- Read-only dependency: `package.json`
- Test command reference: `package.json:67` (`npm test` list)

**Step 1: Write failing test**

Create `tests/unit/agent-surface-docs.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOOLS } = require('../../scripts/minty-mcp-server');
const pkg = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const DOC_PATHS = [
    'docs/HERMES_INTEGRATION.md',
    'hermes/minty-network-memory/SKILL.md',
];

function readDoc(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function assertDocContainsAll(docText, relPath, requiredTerms) {
    for (const term of requiredTerms) {
        assert.ok(
            docText.includes(term),
            `${relPath} must mention ${term}`
        );
    }
}

test('[AgentSurfaceDocs]: Hermes docs and skill mention every MCP tool', () => {
    const toolNames = TOOLS.map(tool => tool.name).sort();
    assert.deepEqual(toolNames, ['person_context', 'search_network', 'source_health', 'workflow_brief']);

    for (const relPath of DOC_PATHS) {
        const doc = readDoc(relPath);
        assertDocContainsAll(doc, relPath, toolNames);
    }
});

test('[AgentSurfaceDocs]: Hermes docs and skill mention required workflow commands', () => {
    const requiredScripts = ['mcp', 'agent', 'memory:refresh', 'hermes:doctor', 'gbrain:export'];
    for (const script of requiredScripts) {
        assert.ok(pkg.scripts[script], `package.json must define npm script ${script}`);
    }

    const requiredCommands = requiredScripts.map(script => `npm run ${script}`);
    for (const relPath of DOC_PATHS) {
        const doc = readDoc(relPath);
        assertDocContainsAll(doc, relPath, requiredCommands);
    }
});

test('[AgentSurfaceDocs]: Hermes skill includes source-health and readiness operating rules', () => {
    const skill = readDoc('hermes/minty-network-memory/SKILL.md');
    for (const phrase of [
        'call `source_health` before source-specific',
        '`source` / `sources` filters',
        'Demo-ready',
        'Dogfood-ready',
        'Hermes-native',
        'Never answer source-specific relationship questions from vibes',
    ]) {
        assert.ok(skill.includes(phrase), `skill must include operating rule: ${phrase}`);
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: FAIL because the current Hermes skill does not mention `npm run hermes:doctor`, `npm run agent`, `npm run mcp`, the readiness levels, or the exact source-health operating rule.

**Step 3: Commit**

Do not commit the failing test separately unless the implementer wants an explicit RED commit. If committing RED:

```bash
git add tests/unit/agent-surface-docs.test.js
git commit -m "test: define Hermes agent surface docs contract"
```

---

### Task 2: Update the Hermes skill to match the current MCP/readiness surface

**Objective:** Make the installed skill teach Hermes the real safe operating loop: preflight source health, query with filters, check readiness, and refresh memory when local data is stale.

**Files:**
- Modify: `hermes/minty-network-memory/SKILL.md`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Keep the failing test from Task 1**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: FAIL for missing skill terms.

**Step 2: Update the skill**

Edit `hermes/minty-network-memory/SKILL.md` so these sections exist. Preserve the frontmatter and the existing setup commands, but replace the current `## When to use`, `## Available tools`, and `## Source health preflight` sections with:

```md
## When to use

Call Minty when a Hermes workflow needs private, read-only relationship memory:

- **Search the network** — `search_network` for people by role, company, source, location, topic, or goal.
- **Person context** — `person_context` before meetings, follow-ups, introductions, or relationship-sensitive decisions.
- **Workflow brief** — `workflow_brief` when Sree has a goal and needs the highest-leverage people plus safe next steps.
- **Source readiness** — `source_health` before source-specific questions, after low-evidence results, or when freshness matters.

Never answer source-specific relationship questions from vibes. If Sree asks "who did I talk to on Telegram/Email/Slack/etc.", call `source_health` first, then use `search_network` with `source` / `sources` filters only if the source is fresh and evidence-bearing.

## Available tools

### search_network
Search the network with natural language. Returns ranked contacts with evidence, warmth, confidence, source diagnostics, and suggested safe next actions.

```json
{ "query": "investors in London who know about AI", "limit": 5 }
```

Use `source` / `sources` filters for source-specific questions:

```json
{ "query": "people I discussed Telegram bots with", "source": "telegram", "limit": 5 }
```

### person_context
Look up a specific person. Returns relationship context, warmth, evidence, and safe diagnostics.

```json
{ "person": "Alice Müller", "limit": 3 }
```

### workflow_brief
Generate a goal-first brief. Returns top people, why each matters, data freshness, and safe next steps. This is the default tool for "who can help me with X right now?".

```json
{ "goal": "Find EU crypto insurance distribution partners", "limit": 5 }
```

### source_health
Check which Minty sources are fresh, evidence-bearing, stale, empty, or unsafe before relying on source-specific answers.

```json
{ "source": "telegram" }
```

## Readiness levels

- **Demo-ready:** `npm run seed:demo`, `npm run mcp`, and `npm run agent -- "investors in London"` work against synthetic data.
- **Dogfood-ready:** `npm run memory:refresh` succeeds against real local data, `source_health` reports fresh/evidence-bearing sources, and outputs omit direct contact details.
- **Hermes-native:** this skill is installed and the Minty MCP server is registered, so Hermes can call `search_network`, `person_context`, `workflow_brief`, and `source_health` without shelling into the repo.

Use `npm run hermes:doctor` to inspect readiness before claiming Minty is usable in a Hermes workflow.
```

Keep the existing safety constraints, data setup, and example workflow, but add `source_health` as step 0 before the example `workflow_brief` when the goal depends on a specific source.

**Step 3: Run test to verify pass**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add hermes/minty-network-memory/SKILL.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: align Hermes skill with MCP surface"
```

---

### Task 3: Update the integration guide with drift rules and readiness commands

**Objective:** Make public agent-integration docs explain the current commands and prevent future MCP tool additions from leaving docs/tests stale.

**Files:**
- Modify: `docs/HERMES_INTEGRATION.md`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Confirm current test state**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

Expected: PASS after Task 2, or FAIL only if `docs/HERMES_INTEGRATION.md` lacks required command mentions.

**Step 2: Update `docs/HERMES_INTEGRATION.md`**

Add this subsection after `## Smoke tests`:

````md
### Readiness doctor

Before telling an agent that Minty is ready, run:

```bash
npm run hermes:doctor
```

Interpret readiness at three levels:

- **Demo-ready:** demo fixtures plus `npm run mcp` / `npm run agent` return plausible source-backed results.
- **Dogfood-ready:** real local data is refreshed with `npm run memory:refresh`, source health is fresh/evidence-bearing, and outputs omit direct contact details.
- **Hermes-native:** the MCP server is registered and the `minty-network-memory` skill is installed so Hermes can call tools directly.
````

Then add this subsection after `## Available tools`:

````md
## Agent surface maintenance contract

`scripts/minty-mcp-server.js` is the source of truth for MCP tools. Any PR that adds, removes, or renames a tool must update all three places in the same change:

1. `tests/unit/minty-mcp-server.test.js` exact tool-list assertion.
2. `docs/HERMES_INTEGRATION.md` available-tools section.
3. `hermes/minty-network-memory/SKILL.md` available-tools and operating rules.

Run the docs contract before committing:

```bash
node --test tests/unit/agent-surface-docs.test.js
```
````

Make sure the guide mentions all required commands literally: `npm run mcp`, `npm run agent`, `npm run memory:refresh`, `npm run hermes:doctor`, and `npm run gbrain:export`.

**Step 3: Run targeted tests**

Run:

```bash
node --test tests/unit/agent-surface-docs.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/HERMES_INTEGRATION.md tests/unit/agent-surface-docs.test.js
git commit -m "docs: document Minty agent surface contract"
```

---

### Task 4: Wire the docs contract into the normal unit suite

**Objective:** Ensure future builders run the drift check with `npm test`, not only manually.

**Files:**
- Modify: `package.json:67`
- Test: `tests/unit/agent-surface-docs.test.js`

**Step 1: Write failing check**

Run:

```bash
node - <<'NODE'
const pkg = require('./package.json');
if (!pkg.scripts.test.includes('tests/unit/agent-surface-docs.test.js')) {
  console.error('agent-surface-docs.test.js missing from npm test');
  process.exit(1);
}
NODE
```

Expected: FAIL before this task.

**Step 2: Add the test file to `npm test`**

In `package.json`, add `tests/unit/agent-surface-docs.test.js` near the other agent/MCP tests in the long `scripts.test` command. Do not reorder unrelated scripts and do not change dependencies.

**Step 3: Verify targeted suite**

Run:

```bash
node - <<'NODE'
const pkg = require('./package.json');
if (!pkg.scripts.test.includes('tests/unit/agent-surface-docs.test.js')) process.exit(1);
NODE
node --test tests/unit/agent-surface-docs.test.js tests/unit/minty-mcp-server.test.js
```

Expected: PASS.

**Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json tests/unit/agent-surface-docs.test.js
git commit -m "test: include agent surface docs contract"
```

---

## Final verification

After all tasks:

```bash
git status --short
node --test tests/unit/agent-surface-docs.test.js tests/unit/minty-mcp-server.test.js
npm test
```

Expected:

- Working tree clean except intentional follow-up branches.
- Targeted tests pass.
- Full unit suite passes.
- The skill and integration docs mention every current MCP tool and required Hermes command.

## Implementation notes

- Keep this docs/test contract narrow. It should catch missing names and commands, not parse Markdown deeply.
- When future plans add `intro_paths`, `meeting_prep`, or `goal_actions`, builders should first update `tests/unit/minty-mcp-server.test.js` exact tool-list assertion, then this docs contract will force docs/skill updates automatically.
- Do not weaken the test by checking only one docs surface. Hermes uses the skill; humans and external agents use `docs/HERMES_INTEGRATION.md`.
- If a tool is intentionally internal and should not appear in the skill, it probably should not be exposed through MCP `tools/list` in the first place.
