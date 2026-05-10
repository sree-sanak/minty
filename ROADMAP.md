# Roadmap

This is the short, public-facing roadmap. For the deeper "why" behind Minty's direction, see [docs/PHILOSOPHY.md](./docs/PHILOSOPHY.md) and [VISION.md](./VISION.md).

Dates are directional, not promises. Priorities shift with real user feedback.

---

## Now (v0.3.x — source-quality and agent trust)

- 🧭 **Source readiness before answers** — make `source_health`, service status, and Hermes doctor output clear enough for agents to know when Minty is demo-ready, dogfood-ready, or stale.
- 🔍 **Evidence-backed retrieval** — keep `search_network`, `person_context`, and `workflow_brief` tied to source-attributed evidence, citations, confidence, freshness, and honest empty states.
- 🔒 **Privacy-safe agent envelopes** — preserve the no-direct-email/phone/raw-message contract across CLI, MCP, API, and GBrain export surfaces.
- 🧪 **Deterministic trust evals** — run synthetic agent-workflow checks that catch private-data leaks, missing evidence, and misleading fallback answers before PRs land.
- 🖼️ **Demo/readiness polish** — replace stale screenshot placeholders and keep the README quickstart aligned with the current OpenClaw/Hermes/MCP path.

## Next (v0.4 — source depth and activation workflows)

- 🔗 **More source coverage** — add high-signal local importers such as Discord DMs/direct groups and macOS iMessage without changing the local-first privacy model.
- 🧩 **Source-quality workbench** — review ambiguous identity matches, weak evidence, stale sources, and ingestion gaps from the UI without exposing raw dumps to agents.
- 🧠 **GBrain bridge hardening** — make `npm run gbrain:export` preserve opaque contact references, safe source labels, citations, freshness, and redaction boundaries.
- 🤝 **Goal activation primitives** — expose safe meeting prep, intro paths, and next-action briefs from existing relationship evidence; no sending or outreach automation.
- 🎯 **Matching accuracy v2** — improve learned overrides, fuzzy last-name handling, and cross-source scoring while keeping provenance visible.

## Later (v0.5 – v1.0)

- 🪟 **Desktop app wrapper** — Tauri or Electron for one-click install and background service management.
- 🌐 **Browser extension** — capture local context as you browse LinkedIn / email, with explicit user control and no hosted tracking.
- 🔍 **Full-text search** (SQLite FTS5) — replace the in-memory index once datasets get large.
- 🎨 **Plugin API** for custom data sources — standardised importer interface with privacy and provenance requirements.
- 🌍 **i18n** — UI translations, non-English name/phone matching, and source labels that remain safe for agent output.
- ⚡ **Performance at scale** — tuned for 20k+ contacts without UX or retrieval-quality regressions.
- 📊 **Shared network overlays** — optional, opt-in comparison with a trusted peer's graph only after the private single-user trust contract is solid.

## Commercial (ee/ — TBD)

Reserved for possible future enterprise packaging under a separate commercial license. See [ee/README.md](./ee/README.md).

Candidates:
- SSO/SAML
- Team admin, audit logs, RBAC

---

## Out of scope (not coming, by design)

These are explicit non-goals. See [VISION.md](./VISION.md) for the longer list.

- Social media tracking (Twitter/Instagram follows)
- Paid third-party contact enrichment as a core feature
- Team / shared CRM (multiple users editing one graph)
- Outreach automation or bulk messaging
- TypeScript migration
- External runtime LLM API calls in the core product

---

## Want to help?

Priorities move in response to actual users. Open an issue with a concrete use case — that's more valuable than a "+1" on a GitHub Projects board. See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR.
