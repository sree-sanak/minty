---
name: minty-network-memory
description: Query Minty as private, read-only network memory inside Hermes workflows via local MCP tools.
version: 1.0.0
---

# Minty Network Memory — Hermes Skill

## When to use

Call Minty when a Hermes workflow needs private, read-only relationship memory:

- **Search the network** — `search_network` for people by role, company, source, location, topic, or goal.
- **Person context** — `person_context` before meetings, follow-ups, introductions, or relationship-sensitive decisions.
- **Workflow brief** — `workflow_brief` when Sree has a goal and needs the highest-leverage people plus safe next steps.
- **Goal next actions** — `goal_next_actions` when Sree has active goal pipeline work and needs the next safe follow-up or warm-intro ask without triggering outreach.
- **Source readiness** — `source_health` before source-specific questions, after low-evidence results, or when freshness matters.
- **Meeting prep** — `meeting_prep` for source-backed upcoming calendar briefs without exposing raw event, attendee, location, or join-link data.

Never answer source-specific relationship questions from vibes. If Sree asks "who did I talk to on Telegram/Email/Slack/etc.", call `source_health` before source-specific retrieval, then use `search_network` with `source` / `sources` filters only if the source is fresh and evidence-bearing.

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

### goal_next_actions
Recommend goal-based next actions. Returns read-only action briefs that prioritize active pipeline follow-ups before new asks, may suggest warm-intro requests from shared group context, and explicitly reports `noOutreachTriggered`.

```json
{ "goal": "raise seed", "limit": 5 }
```

### source_health
Check which Minty sources are fresh, evidence-bearing, stale, empty, or unsafe before relying on source-specific answers.

```json
{ "source": "telegram" }
{ "sources": ["telegram", "slack"] }
{ "query": "who from Telegram knows DeFi?" }
```

### meeting_prep
Prepare for an upcoming calendar meeting. Returns opaque event/contact refs, redacted attendee context, citations, freshness, and safety metadata. Requires fresh Calendar sync state and `MINTY_REF_SECRET` or `MINTY_MCP_REF_SECRET`; if either is missing, return the degraded/error state instead of fabricating context.

```json
{ "horizonHours": 48 }
{ "person": "Alice Müller", "horizonHours": 48 }
```

## Readiness levels

- **Demo-ready:** `npm run seed:demo`, `npm run mcp`, and `npm run agent -- "investors in London"` work against synthetic data.
- **Dogfood-ready:** `npm run memory:refresh` succeeds against real local data, `source_health` reports fresh/evidence-bearing sources, and outputs omit direct contact details.
- **Hermes-native:** this skill is installed and the Minty MCP server is registered, so Hermes can call `search_network`, `person_context`, `workflow_brief`, `goal_next_actions`, `source_health`, and `meeting_prep` without shelling into the repo.

Use `npm run hermes:doctor` to inspect readiness before claiming Minty is usable in a Hermes workflow. Use `npm run gbrain:export` only for privacy-safe durable-memory export, not raw contact/message dumps.

## Source health preflight

Before source-specific queries (`telegram`, `gmail/email`, `linkedin`, `whatsapp`, `sms`, `slack`) call `source_health` if freshness or coverage matters. If the source is stale/empty, say so instead of answering from vibes. For stale or low-evidence results, call `source_health` before deciding whether to retry with `source` / `sources` filters or return an honest empty/low-confidence answer.

## Agent surface maintenance contract

`scripts/minty-mcp-server.js` is the source of truth for exposed MCP tools. Any PR that adds, removes, or renames a tool must update the docs and skill in the same PR: `tests/unit/minty-mcp-server.test.js`, `docs/HERMES_INTEGRATION.md`, `hermes/minty-network-memory/SKILL.md`, and the docs drift test in `tests/unit/agent-surface-docs.test.js`.

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

To make Minty useful inside Hermes with real contacts immediately, sync contacts from an existing Hermes Google Workspace token:

```bash
cd /root/.hermes/workspace/minty
npm run memory:refresh
```

For a manual step-by-step refresh:

```bash
cd /root/.hermes/workspace/minty
npm run google-contacts:hermes
npm run merge
npm run gbrain:export
```

For multiple Google profiles:

```bash
MINTY_GOOGLE_TOKEN_FILES="work=/...json" npm run google-contacts:hermes
npm run merge
npm run gbrain:export
```

`npm run memory:refresh` is Sree's personal Hermes dogfood loop: sync Google Contacts, rebuild unified network data, export privacy-safe GBrain relationship memory, import it into private GBrain when available, and smoke-test the Minty MCP server. Generated real data under `data/` and GBrain exports are private local files and must not be committed.

## Example Hermes workflow

```
Hermes goal: "Prepare for EU crypto insurance expansion"

0. If the goal depends on a source, call source_health({ source: "telegram" })
   → Confirms freshness/evidence before source-specific answers

1. Call workflow_brief({ goal: "EU crypto insurance partners" })
   → Returns top 5 people with evidence and suggested actions

2. For each person, call person_context({ person: "Alice Müller" })
   → Deep context on relationship history

3. Draft outreach plan (Hermes composes, user approves before sending)
```
