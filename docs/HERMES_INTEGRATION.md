# Hermes Integration Guide

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
```

For multiple Hermes Google profiles:

```bash
MINTY_GOOGLE_TOKEN_FILES="work=/root/.hermes/google_token.json,personal=/root/.hermes/google-personal/google_token.json" \
  npm run google-contacts:hermes
npm run merge
```

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
Natural-language network search. Input: `{ query, limit? }`.
Returns ranked results with relationship scores, warmth labels, evidence, and suggested actions.

### person_context
Person lookup. Input: `{ person, limit? }`.
Returns matching contacts with context — no emails/phones.

### workflow_brief
Goal-oriented brief. Input: `{ goal, limit? }`.
Returns top people, why each matters, next steps, and data freshness metadata.

## Example queries

| Query | What you get |
|---|---|
| `"investors in London"` | London-based investor contacts ranked by relationship strength |
| `"Alice Müller"` | Context on Alice — warmth, topics, evidence, last contact |
| `"Find EU crypto insurance partners"` | Brief with top people, evidence, and safe next steps |

## Architecture

```
Hermes → MCP stdio → minty-mcp-server.js → agent-retrieval.js → unified data
                                          ↑ no network, no LLM
```

The MCP server loads data via `resolveDataDir()` + `loadData()` from `scripts/agent-query.js`,
then delegates to `queryNetwork()` from `crm/agent-retrieval.js` — the same pure, deterministic
engine used by the CLI.
