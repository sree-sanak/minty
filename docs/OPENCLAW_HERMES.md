# OpenClaw + Hermes Integration

Minty is built to be a local relationship-memory backend for agent runtimes like OpenClaw and Hermes. It exposes your unified network through a read-only MCP server and a simple CLI, so agents can answer questions like “who can help with this?” without receiving raw contact dumps.

## What agents get

| Interface | Use it for | Command |
|---|---|---|
| MCP stdio server | OpenClaw, Hermes, Claude Code, Cursor, and other MCP-capable agents | `npm run mcp` |
| CLI JSON output | Shell tools, cron jobs, custom agent skills | `npm run agent -- "investors in London"` |
| GBrain export | Private-brain ingestion for Hermes-style memory workflows | `npm run gbrain:export` |

The MCP server is deterministic and local. It makes no LLM calls, no telemetry calls, and no outreach actions.

## Quick start with demo data

```bash
git clone https://github.com/zalatar242/minty.git
cd minty
npm install
npm run seed:demo
CRM_DATA_DIR=./data-demo npm run agent -- "who can help with crypto insurance"
```

Expected shape:

```json
{
  "query": "who can help with crypto insurance",
  "intent": "find",
  "results": [
    {
      "name": "...",
      "relevance": 87,
      "warmth": "warm",
      "evidence": [{ "kind": "...", "label": "..." }],
      "suggestedAction": "..."
    }
  ],
  "safety": {
    "contactDetailsOmitted": true,
    "noLlmCalls": true,
    "readOnly": true
  }
}
```

## Register Minty as an MCP server

Minty uses standard MCP over stdio. Any client that can launch a local command can run it.

### Generic MCP config

```json
{
  "mcpServers": {
    "minty": {
      "command": "node",
      "args": ["/absolute/path/to/minty/scripts/minty-mcp-server.js"],
      "env": {
        "CRM_DATA_DIR": "/absolute/path/to/minty/data-demo"
      }
    }
  }
}
```

Use `CRM_DATA_DIR=/absolute/path/to/minty/data` for real local data, or omit it and Minty will try `./data` then `./data-demo` from the repository root.

### Hermes config

Hermes can register the same stdio server:

```yaml
mcp_servers:
  minty:
    command: "node"
    args: ["/absolute/path/to/minty/scripts/minty-mcp-server.js"]
    env:
      CRM_DATA_DIR: "/absolute/path/to/minty/data"
    timeout: 60
    connect_timeout: 20
```

### OpenClaw config

OpenClaw setups vary by distribution, but the integration point is the same: add a local MCP server named `minty` with command `node` and args pointing at `scripts/minty-mcp-server.js`. If your OpenClaw build uses a JSON MCP registry, use the generic MCP config above. If it exposes a dashboard form, use:

- **Name:** `minty`
- **Transport:** stdio / local command
- **Command:** `node`
- **Args:** `/absolute/path/to/minty/scripts/minty-mcp-server.js`
- **Env:** `CRM_DATA_DIR=/absolute/path/to/minty/data`

## MCP tools

### `search_network`

Natural-language network search.

Input:

```json
{ "query": "investors in London", "limit": 5 }
```

Returns ranked people with warmth, source-backed evidence, relationship score, data confidence, and a suggested next action.

### `person_context`

Lookup by person name or partial name.

Input:

```json
{ "person": "Alice Müller", "limit": 3 }
```

Returns matching people and relationship context without raw emails, phone numbers, or full contact records.

### `workflow_brief`

Goal-oriented relationship brief.

Input:

```json
{ "goal": "find EU crypto insurance partners", "limit": 8 }
```

Returns top people, why they matter, next steps, and freshness metadata.

## Privacy contract

| Property | Minty behavior |
|---|---|
| Data location | Reads local JSON from `./data` or `CRM_DATA_DIR` |
| Network calls | None from the MCP server or CLI |
| Contact details | Emails, phones, and raw contact objects omitted from agent outputs |
| Mutations | None; the MCP tools are read-only |
| Outreach | Never triggered; suggested actions are advisory |

Important boundary: Minty can keep the retrieval layer local and redacted. Once an agent sends the returned summary to a hosted model/provider, that downstream privacy depends on the agent runtime and model configuration.

## Smoke test the MCP server

```bash
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
```

Run the focused test too:

```bash
node --test tests/unit/minty-mcp-server.test.js tests/unit/agent-retrieval.test.js
```

## Production setup notes

- Run Minty on the same machine as OpenClaw/Hermes when possible.
- Keep `CRM_DATA_DIR` pointed at a private local directory.
- Use the web UI for imports and trust-building; use MCP/CLI for agent workflows.
- Prefer `workflow_brief` for high-level tasks and `person_context` when the agent already has a name.
