---
name: minty-network-memory
description: Query Minty as private, read-only network memory inside Hermes workflows via local MCP tools.
version: 1.0.0
---

# Minty Network Memory — Hermes Skill

## When to use

Call Minty when a Hermes workflow needs to understand the user's private network:

- **Who do I know?** — find people by role, company, location, or topic
- **Person context** — get relationship history and evidence before reaching out
- **Workflow briefs** — get a concise brief of relevant people for a goal

## MCP configuration

Add to your Hermes agent's MCP config:

```yaml
mcp_servers:
  minty:
    command: "node"
    args: ["/root/.hermes/workspace/minty/scripts/minty-mcp-server.js"]
    timeout: 60
    connect_timeout: 20
```

## Available tools

### search_network
Search the network with natural language. Returns ranked contacts with evidence.

```json
{ "query": "investors in London who know about AI", "limit": 5 }
```

### person_context
Look up a specific person. Returns relationship context, warmth, and evidence.

```json
{ "person": "Alice Müller", "limit": 3 }
```

### workflow_brief
Generate a workflow brief for a goal. Returns top people, why each matters,
suggested next steps, and data freshness metadata.

```json
{ "goal": "Find EU crypto insurance distribution partners", "limit": 5 }
```

## Safety constraints

1. **Read-only.** Minty never sends messages, mutates contacts, or triggers outreach.
2. **No contact details.** Emails, phone numbers, and raw contact data are omitted by default.
3. **Source-backed.** Every result includes evidence from indexed local Minty data — do not invent relationship facts.
4. **No LLM calls in Minty.** The MCP server is deterministic and local; remember that Hermes may pass returned summaries to the configured model/provider.
5. **No outreach without explicit approval.** Suggested actions are advisory only.

## Data setup

Minty resolves data in this order:
1. `CRM_DATA_DIR` environment variable
2. `./data` (real user data from connected sources)
3. `./data-demo` (demo fixtures — run `npm run seed:demo` to generate)

## Example Hermes workflow

```
Hermes goal: "Prepare for EU crypto insurance expansion"

1. Call workflow_brief({ goal: "EU crypto insurance partners" })
   → Returns top 5 people with evidence and suggested actions

2. For each person, call person_context({ person: "Alice Müller" })
   → Deep context on relationship history

3. Draft outreach plan (Hermes composes, user approves before sending)
```
