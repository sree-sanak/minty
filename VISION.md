# Vision

## Today

Minty is a **local-first, always-on relationship intelligence service**. It runs as a background daemon on your machine, continuously watching your communication sources (WhatsApp, Gmail, LinkedIn, Telegram, SMS, Google Contacts), consolidating contacts, resolving identities across channels, and exposing a live relationship index to AI agents and humans alike. No accounts, no cloud, no API fees.

The core loop is:
1. **Watch** — continuously sync data from sources you already use
2. **Resolve** — cross-source identity resolution collapses a person into a single record
3. **Index** — unified contacts, interactions, and relationship signals stay fresh
4. **Serve** — agents (via MCP/CLI) and humans (via web UI) query the live index

## Architecture: Minty + GBrain

Minty and GBrain serve complementary roles in a local-first personal intelligence stack:

| | **Minty** | **GBrain** |
|---|---|---|
| **Role** | Live relationship index — the changing layer | Durable private memory — the persistent layer |
| **Owns** | Source freshness, identity resolution, interaction timelines, relationship scoring, source provenance | Curated summaries, long-term knowledge, cross-domain memory |
| **Data shape** | Raw streams, live sync state, mutable contact records | Privacy-safe envelopes, immutable memory entries |
| **Update cadence** | Continuous (real-time WhatsApp, 10-min Gmail, file watchers) | Periodic export from Minty (privacy-filtered, opt-in) |

**Boundary rules:**
- Minty never sends raw contact details (emails, phones, message bodies) to GBrain.
- GBrain receives curated, privacy-safe relationship summaries via `npm run gbrain:export`.
- Minty owns freshness and provenance — if an agent needs "who did I talk to this week," it asks Minty directly.
- GBrain owns durability — if an agent needs "what do I know about this person across all domains," it asks GBrain.

## Where it's going

### Near term (v0.x)
- **Always-on service mode** — `npm run service` starts the sync daemon without a web UI, suitable for headless/server use
- **Better matching accuracy** — more signals, more heuristics, learned overrides
- **More sources** — Discord, iMessage, Slack DMs
- **Richer timeline** — attachments, link previews, inline reactions
- **CLI parity** — everything the web UI does, available from the terminal

### Medium term (v1.x)
- **Local AI layer** — bring-your-own-LLM for relationship summaries, "who should I follow up with" suggestions. Runs against local JSON, no data leaves.
- **Periodic GBrain export** — opt-in scheduled push of privacy-safe relationship memory to GBrain/Hermes
- **Natural language search** — "who did I meet at that conference in March"
- **Stale data detection** — warn when a contact hasn't been updated from any source in a year

### Long term
- **Goal-oriented UX** — the core bet is that a CRM shouldn't be a maintenance tool ("keep relationships warm"), it should be a goal-achievement tool ("help me find an intro to X via my network")
- **Graph-level features** — shortest-path intro finding, company clustering, network-wide queries
- **Collaborative editing** — trusted contacts can update their own records (e2e encrypted)
- **Paid enrichment tier** — optional hosted enrichment (company data, role changes) for users who want it; the free local-first experience stays complete

## Non-goals

- **SaaS core.** Minty runs on your machine. If there's ever a hosted version, it'll be in a separate `ee/` directory under a commercial license — the free self-hosted experience stays complete.
- **External LLM API calls at runtime.** We don't want to silently spend your money or send your data to OpenAI/Anthropic without explicit opt-in.
- **TypeScript.** Plain Node.js CJS, minimal dependencies, zero build step.
- **Mobile / browser extension.** Desktop web UI only for v1.
- **Replacing LinkedIn.** Minty is a personal tool, not a social network.
- **Social graph sharing.** Your network graph is private. No publishing, no "see who knows who" social features. Privacy is non-negotiable.

## Why open source

Two reasons:
1. **Your data should be yours.** Closed-source personal CRMs are fundamentally at odds with that principle — you can't audit what they do with your contacts.
2. **The moat isn't the code.** The moat is execution, UX polish, and — eventually — a great hosted version for people who don't want to self-host. The code itself is more valuable open than closed.

If you fork Minty and build something great, genuinely: good. That's the point.
