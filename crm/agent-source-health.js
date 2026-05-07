'use strict';

/**
 * crm/agent-source-health.js — privacy-safe source readiness summarizer.
 *
 * Pure functions. No file I/O, no LLM calls. Converts local contacts,
 * interactions, contact evidence, source events, and sync state into a
 * redacted source readiness envelope for agent/MCP preflight.
 */

const { canonicalSource: canonicalEvidenceSource } = require('./contact-evidence');

const KNOWN_SOURCES = ['email', 'googleContacts', 'linkedin', 'sms', 'telegram', 'whatsapp', 'slack'];
const KNOWN_SOURCE_KEYS = new Set(KNOWN_SOURCES.map(s => s.toLowerCase()));

function canonicalSource(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return null;
    if (key === 'gmail') return 'email';
    if (key === 'googlecontact' || key === 'googlecontacts' || key === 'google') return 'googleContacts';
    const evidenceLabel = canonicalEvidenceSource(value);
    if (evidenceLabel && evidenceLabel !== 'interaction' && KNOWN_SOURCE_KEYS.has(evidenceLabel.toLowerCase())) return evidenceLabel;
    return null;
}

function normalizeSourceFilter(value) {
    if (value == null || value === '') return { sources: [], invalid: [] };
    const raw = Array.isArray(value) ? value : [value];
    const sources = new Set();
    const invalid = new Set();
    for (const item of raw) {
        const source = canonicalSource(item);
        if (source) sources.add(source);
        else invalid.add('invalid');
    }
    return { sources: [...sources].sort(), invalid: [...invalid].sort() };
}

function parseTime(value) {
    const t = Date.parse(value || '');
    return Number.isNaN(t) ? null : t;
}

function freshness(lastSyncAt, now) {
    const last = parseTime(lastSyncAt);
    if (!last) return 'unknown';
    const ageDays = Math.floor(((parseTime(now) || Date.now()) - last) / 86400000);
    if (ageDays <= 2) return 'fresh';
    if (ageDays <= 14) return 'aging';
    return 'stale';
}

function hasPayload(value) {
    return !!(value && typeof value === 'object' && Object.values(value).some(v =>
        v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
    ));
}

function contactSources(contact) {
    const out = new Set();
    for (const [source, payload] of Object.entries((contact && contact.sources) || {})) {
        const canonical = canonicalSource(source);
        if (canonical && hasPayload(payload)) out.add(canonical);
    }
    const activeChannels = Array.isArray(contact && contact.activeChannels) ? contact.activeChannels : [];
    for (const channel of activeChannels) {
        const canonical = canonicalSource(channel);
        if (canonical) out.add(canonical);
    }
    return out;
}

function evidenceSources(evidence) {
    const out = new Set();
    const sources = Array.isArray(evidence && evidence.sources) ? evidence.sources : [];
    for (const source of sources) {
        const canonical = canonicalSource(source);
        if (canonical) out.add(canonical);
    }
    const topicEvidence = Array.isArray(evidence && evidence.topicEvidence) ? evidence.topicEvidence : [];
    for (const row of topicEvidence) {
        const rowSources = Array.isArray(row && row.sources) ? row.sources : [];
        for (const source of rowSources) {
            const canonical = canonicalSource(source);
            if (canonical) out.add(canonical);
        }
    }
    return out;
}

function buildAgentSourceHealth(data = {}, options = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const interactions = Array.isArray(data.interactions) ? data.interactions : [];
    const sourceEvents = Array.isArray(data.sourceEvents) ? data.sourceEvents : [];
    const contactEvidence = data.contactEvidence && typeof data.contactEvidence === 'object' && !Array.isArray(data.contactEvidence)
        ? data.contactEvidence : {};
    const syncState = data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)
        ? data.syncState : {};
    const rawFilters = [];
    if (options.source !== undefined) rawFilters.push(options.source);
    if (options.sources !== undefined) {
        if (Array.isArray(options.sources)) rawFilters.push(...options.sources);
        else rawFilters.push(options.sources);
    }
    const filter = normalizeSourceFilter(rawFilters.length ? rawFilters : undefined);
    if (filter.invalid.length) {
        return {
            status: 'error',
            sources: {},
            invalidSourceFilters: filter.invalid,
            safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true },
        };
    }

    const discovered = new Set(KNOWN_SOURCES);
    for (const source of Object.keys(syncState)) {
        const canonical = canonicalSource(source);
        if (canonical) discovered.add(canonical);
    }
    const selected = filter.sources.length ? filter.sources : [...discovered].sort();
    const rows = {};

    for (const source of selected) {
        const contactCount = contacts.filter(c => contactSources(c).has(source)).length;
        const interactionCount = interactions.filter(i => canonicalSource(i && (i.source || i.channel)) === source).length;
        const sourceEventCount = sourceEvents.filter(e => canonicalSource(e && e.source) === source).length;
        const evidenceContactCount = Object.values(contactEvidence).filter(ev => evidenceSources(ev).has(source)).length;
        const rawState = syncState[source] || syncState[source.toLowerCase()] || syncState[source === 'email' ? 'gmail' : source] || syncState[source === 'googleContacts' ? 'googlecontacts' : source] || {};
        const lastSyncAt = rawState.lastSyncAt || rawState.lastSyncedAt || rawState.updatedAt || rawState.lastSync || null;
        const fresh = freshness(lastSyncAt, options.now);
        const warnings = [];
        if (!lastSyncAt) warnings.push('not_configured');
        if (!contactCount) warnings.push('no_contacts');
        if (!evidenceContactCount && !interactionCount && !sourceEventCount) warnings.push('no_query_evidence');
        if (fresh === 'stale' || fresh === 'unknown') warnings.push('no_recent_sync');
        const ready = warnings.length === 0 && fresh === 'fresh';
        rows[source] = {
            status: ready ? 'ready' : fresh === 'stale' ? 'stale' : warnings.length ? 'limited' : 'ready',
            freshness: fresh,
            contactCount,
            interactionCount,
            evidenceContactCount,
            sourceEventCount,
            lastSyncAt,
            warnings,
            suggestedNextStep: warnings.length ? 'Run npm run service or npm run memory:refresh, then retry the source-specific query.' : 'Safe to use for source-specific retrieval.',
        };
    }

    const hasWarning = Object.values(rows).some(r => r.warnings.length || r.status !== 'ready');
    return {
        status: hasWarning ? 'warning' : 'ok',
        sources: rows,
        invalidSourceFilters: [],
        querySourceFilter: Array.isArray(options.querySourceFilter) ? options.querySourceFilter : undefined,
        safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true, tokenPathsOmitted: true },
    };
}

module.exports = { buildAgentSourceHealth, canonicalSource, normalizeSourceFilter };
