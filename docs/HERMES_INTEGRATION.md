# Hermes Integration Guide

> The broader OpenClaw/Hermes/MCP quickstart now lives in [OPENCLAW_HERMES.md](./OPENCLAW_HERMES.md). This file keeps the Hermes-specific setup details.

Minty provides private network memory to Hermes via a local MCP server.
Hermes can query your network, get person context, and generate workflow briefs
through a deterministic local server that makes no external calls. The server
returns redacted, evidence-backed summaries; end-to-end data residency still
depends on the Hermes model/provider configuration that receives those summaries.

## Setup

### 1. Seed demo data or sync real Hermes contacts

```bash
cd /root/.hermes/workspace/minty

# Demo fixtures
npm run seed:demo

# Real contacts from an existing Hermes Google Workspace OAuth token
npm run google-contacts:hermes
npm run merge
npm run gbrain:export
```

For multiple Hermes Google profiles:

```bash
MINTY_GOOGLE_TOKEN_FILES="work=/...json" \
  npm run google-contacts:hermes
npm run merge
npm run gbrain:export
```

`npm run gbrain:export` writes privacy-safe relationship-memory JSONL and Markdown under `data/gbrain/` for private-brain ingestion. It intentionally omits direct emails, phone numbers, and raw contact records.

### 2. Register the MCP server

Add to your Hermes agent or Claude Code MCP config:

```yaml
mcp_servers:
  minty:
    command: "node"
    args: ["/root/.hermes/workspace/minty/scripts/minty-mcp-server.js"]
    timeout: 60
    connect_timeout: 20
```

### 3. Install the Hermes skill

Copy or symlink `hermes/minty-network-memory/SKILL.md` into your Hermes skills directory.

## Smoke tests

### Readiness doctor

Before telling an agent that Minty is ready, run:

```bash
npm run hermes:doctor
```

Interpret readiness at three levels:

- **Demo-ready:** demo fixtures plus `npm run mcp` / `npm run agent` return plausible source-backed results.
- **Dogfood-ready:** real local data is refreshed with `npm run memory:refresh`, source health is fresh/evidence-bearing, and outputs omit direct contact details.
- **Hermes-native:** the MCP server is registered and the `minty-network-memory` skill is installed so Hermes can call tools directly.

### Test the MCP server directly

```bash
# List tools using standard MCP newline-delimited JSON-RPC
python3 - <<'PY' | node scripts/minty-mcp-server.js
import json
messages = [
    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke"}}},
    {"jsonrpc":"2.0","method":"notifications/initialized","params":{}},
    {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}},
]
for msg in messages:
    print(json.dumps(msg, separators=(",", ":")))
PY

# Or run the unit tests
node --test tests/unit/minty-mcp-server.test.js

# Run the package MCP entrypoint
npm run mcp
```

### Test via agent CLI

```bash
npm run seed:demo
npm run agent -- "investors in London"
npm run agent -- "who can help with crypto insurance"
```

### Full test suite

```bash
npm test
```

## Privacy model

| Property | Guarantee |
|---|---|
| Data location | All data stays on disk in `./data` or `./data-demo` |
| Network calls | Zero — no LLM APIs, no telemetry, no external requests |
| Contact details | Emails, phones, raw contact objects omitted from all outputs |
| Mutations | None — read-only access to unified contact store |
| Outreach | Never triggered; suggested actions are advisory only |

## Available tools

### search_network
Natural-language network search. Input: `{ query, limit?, source?, sources? }`.
Returns ranked results with relationship scores, warmth labels, evidence, source diagnostics, and suggested actions. Use `source` / `sources` filters after `source_health` when the user asks source-specific questions.

### person_context
Person lookup. Input: `{ person, limit? }`.
Returns matching contacts with context — no emails/phones.

### workflow_brief
Goal-oriented brief. Input: `{ goal, limit? }`.
Returns top people, why each matters, next steps, and data freshness metadata.

### goal_next_actions
Goal-action planner. Input: `{ goal?, limit? }`.
Returns privacy-safe read-only action briefs that prioritize active pipeline follow-ups before new asks, may suggest warm-intro requests from group context, and explicitly reports that no outreach was triggered. It never exposes raw goal ids, contact ids, emails, phones, private message bodies, or side-effect arguments.

### source_health
Source readiness preflight. Input: `{ source?, sources?, query? }`.
Returns redacted source rows with freshness, counts, evidence coverage, warnings, and safe next-step commands. Use it before source-specific questions like "who did I talk to on Telegram?" and when a query returns low evidence. Never answer source-specific relationship questions from vibes.

### meeting_prep
Upcoming-meeting prep. Input: `{ horizonHours?, person? }`.
Returns the next matched calendar meeting with opaque `eventRef`, redacted attendee relationship context, citations, freshness, and safety metadata. It requires fresh Calendar sync state plus `MINTY_REF_SECRET` or `MINTY_MCP_REF_SECRET` for opaque refs. It never exposes raw event ids, attendee emails, join links, descriptions, locations, or contact ids, and it never mutates Calendar or sends outreach.

## Agent surface maintenance contract

`scripts/minty-mcp-server.js` is the source of truth for MCP tools. Any PR that adds, removes, or renames a tool must update all four places in the same change:

1. `tests/unit/minty-mcp-server.test.js` exact tool-list assertion.
2. `docs/HERMES_INTEGRATION.md` available-tools section.
3. `hermes/minty-network-memory/SKILL.md` available-tools and operating rules.
4. `tests/unit/agent-surface-docs.test.js` docs drift assertions when the contract changes.

Run the docs contract before committing:

```bash
node --test tests/unit/agent-surface-docs.test.js
```

## Example queries

| Query | What you get |
|---|---|
| `"investors in London"` | London-based investor contacts ranked by relationship strength |
| `"Alice Müller"` | Context on Alice — warmth, topics, evidence, last contact |
| `"Find EU crypto insurance partners"` | Brief with top people, evidence, and safe next steps |

## Memory refresh diagnostics

`npm run memory:refresh` writes a privacy-safe status report to
`data/unified/memory-refresh-status.json` on every run — both success and
failure. The report contains only safe metadata:

- **Step results**: step id, status (`ok`/`failed`/`skipped`/`warning`),
  timestamps, durations, exit codes.
- **Artifact presence**: whether each unified output file exists, record
  counts, last-modified times.
- **Warnings and next actions**: which steps need attention and what to run.
- **Safety envelope**: confirms that emails, phones, private paths, raw
  contact ids, message bodies, and credential values are redacted.

The status file is useful for Hermes agents to understand data freshness
without accessing raw contact data. It never contains private information.

Stable step ids: `google_contacts`, `telegram`, `merge`, `contact_evidence`,
`source_events`, `hybrid_index`, `query_index`, `gbrain_export`,
`gbrain_import`, `mcp_smoke`.

## Evidence review workbench

Minty includes a local evidence review workbench in the Review screen and API:

- `GET /api/evidence/review` returns redacted topic-evidence rows only: contact label, opaque `contactRef`, allowlisted topic, confidence/count/freshness, and safe source labels.
- `POST /api/evidence/review/:contactRef/:topic` accepts `{ "decision": "suppress" }` or `{ "decision": "restore" }` and writes only `data/unified/evidence-overrides.json`.
- Suppressed topics are filtered before agent retrieval (`scripts/agent-query.js`) and hybrid index generation (`scripts/build-hybrid-index.js`).

The workbench is a trust/debug surface for Hermes/OpenClaw memory, not a CRM workflow. It never exposes raw contact ids, emails, phones, message bodies, source event ids, group names, URLs, or arbitrary user-authored topics.

## Architecture

```
Hermes → MCP stdio → minty-mcp-server.js → agent-retrieval.js → unified data
                                          ↑ no network, no LLM
```

The MCP server loads data via `resolveDataDir()` + `loadData()` from `scripts/agent-query.js`,
then delegates to `queryNetwork()` from `crm/agent-retrieval.js` — the same pure, deterministic
engine used by the CLI.
