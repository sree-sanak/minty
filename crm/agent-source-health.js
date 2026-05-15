'use strict';

/**
 * crm/agent-source-health.js — privacy-safe source readiness summarizer.
 *
 * Pure functions. No file I/O, no LLM calls. Converts local contacts,
 * interactions, contact evidence, source events, and sync state into a
 * redacted source readiness envelope for agent/MCP preflight.
 */

const { canonicalSource: canonicalEvidenceSource } = require('./contact-evidence');
const { redactDirectContactDetails } = require('./privacy-envelope');

const KNOWN_SOURCES = ['email', 'googleContacts', 'linkedin', 'sms', 'telegram', 'whatsapp', 'slack'];
const KNOWN_SOURCE_KEYS = new Set(KNOWN_SOURCES.map(s => s.toLowerCase()));
const UNKNOWN_REFRESH_STATUS = Object.freeze({
    status: 'unknown',
    failedStep: null,
    generatedAt: null,
    warnings: [],
    nextActions: [],
});

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

function sanitizeDiagnosticText(value) {
    if (typeof value !== 'string') return null;
    let text = redactDirectContactDetails(value).slice(0, 500);
    text = text
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_TOKEN]')
        .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|session|credentials?|token)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_TOKEN]')
        .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|session|credentials?)\s*[=:]\s*"?[A-Za-z0-9._~+/=-][^\s"']*/gi, '[REDACTED_TOKEN]')
        .replace(/\b(?:raw-)?(?:token|secret|password|api[_-]?key|session|credentials?)[A-Za-z0-9._:-]*\b/gi, '[REDACTED_TOKEN]')
        .replace(/\braw-phone-[A-Za-z0-9._:-]+\b/gi, '[redacted phone]')
        .replace(/(?:^|\s)(?:~|\/|[A-Za-z]:\\)[^\n\r,;]*?(?:\.json|\.ya?ml|\.env|\.log|\.txt|\/[^\s,;]*)/g, match => {
            const prefix = /^\s/.test(match) ? ' ' : '';
            return `${prefix}[REDACTED_PATH]`;
        });
    text = text.replace(/\s+/g, ' ').trim();
    return text || null;
}

function safeString(value, max = 128) {
    return typeof value === 'string' && value.length <= max ? value : null;
}

function safeIsoTimestamp(value) {
    if (typeof value !== 'string' || value.length > 128) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString() === value || parsed.toISOString().replace('.000Z', 'Z') === value ? value : null;
}

function buildRefreshNextActions(status) {
    const failedStep = canonicalSource(status.failedStep) || safeString(status.failedStep, 64);
    if (failedStep === 'telegram') return ['Check Telegram importer credentials and recent export freshness.'];
    if (failedStep === 'email') return ['Check Gmail/email importer credentials and recent export freshness.'];
    if (failedStep === 'googleContacts') return ['Check Google Contacts importer credentials and recent export freshness.'];
    if (failedStep === 'linkedin') return ['Check LinkedIn export/session freshness, then rerun memory refresh.'];
    if (status.status === 'failed') return ['Inspect the local memory refresh job and rerun npm run memory:refresh after fixing the failed source.'];
    return [];
}

function sanitizeMemoryRefreshStatus(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...UNKNOWN_REFRESH_STATUS, warnings: [], nextActions: [] };
    const rawStatus = safeString(value.status, 32);
    const allowedStatus = new Set(['ok', 'success', 'warning', 'failed', 'error', 'unknown']);
    const status = allowedStatus.has(rawStatus) ? rawStatus : 'unknown';
    const rawFailedStep = safeString(value.failedStep, 64);
    const failedStep = rawFailedStep ? canonicalSource(rawFailedStep) : null;
    const warnings = Array.isArray(value.warnings)
        ? value.warnings.map(sanitizeDiagnosticText).filter(Boolean).slice(0, 5)
        : [];
    return {
        status,
        failedStep,
        generatedAt: safeIsoTimestamp(value.generatedAt),
        warnings,
        nextActions: buildRefreshNextActions({ status, failedStep }),
    };
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

function buildSourceAnswerability(healthEnvelope, opts = {}) {
    const explicit = opts.explicit === true;
    const sourceRows = healthEnvelope && healthEnvelope.sources && typeof healthEnvelope.sources === 'object' && !Array.isArray(healthEnvelope.sources)
        ? Object.entries(healthEnvelope.sources)
            .map(([rawSource, row]) => {
                const source = canonicalSource(rawSource);
                return source ? { ...(row && typeof row === 'object' ? row : {}), source } : null;
            })
            .filter(Boolean)
        : [];
    const invalidSource = Array.isArray(healthEnvelope && healthEnvelope.invalidSourceFilters)
        && healthEnvelope.invalidSourceFilters.length > 0;
    const queryEvidenceChecked = opts.queryEvidenceChecked === true;
    const queryMatchedSources = new Set((Array.isArray(opts.queryMatchedSources) ? opts.queryMatchedSources : [])
        .map(canonicalSource)
        .filter(Boolean));

    const perSource = sourceRows.map(row => {
        const warnings = new Set(Array.isArray(row.warnings) ? row.warnings.filter(w => typeof w === 'string' && w) : []);
        const hasQueryEvidence = queryMatchedSources.has(row.source);
        if (explicit && queryEvidenceChecked && !hasQueryEvidence) warnings.add('no_query_evidence');
        if (explicit && queryEvidenceChecked && hasQueryEvidence) {
            warnings.delete('no_query_evidence');
            // Query-level interaction/contact evidence is enough to answer even when
            // source availability is not present on contact profile metadata.
            warnings.delete('no_contacts');
        }
        const warningList = [...warnings].sort();
        let status = row.status === 'ready' ? 'ok' : row.status;
        if (warningList.includes('not_configured')) status = 'not_configured';
        else if (row.freshness === 'stale' || warningList.includes('no_recent_sync')) status = 'stale';
        else if (row.freshness === 'unknown') status = 'unknown';
        else if (!warningList.length && row.freshness === 'fresh') status = 'ok';
        return {
            source: row.source,
            status,
            freshness: row.freshness,
            answerable: status === 'ok' && warningList.length === 0,
            warnings: warningList,
        };
    }).sort((a, b) => a.source.localeCompare(b.source));

    const warnings = new Set(perSource.flatMap(row => row.warnings));
    if (invalidSource) warnings.add('invalid_source');
    if (explicit && !perSource.length) warnings.add('no_source_health');
    if (explicit && perSource.some(row => !row.answerable && row.warnings.some(w => w !== 'no_query_evidence'))) {
        warnings.add('source_unhealthy');
    }
    const answerableSources = perSource.filter(row => row.answerable).map(row => row.source);
    const blocked = explicit && (invalidSource || !perSource.length || perSource.some(row => !row.answerable));

    return {
        answerable: !blocked,
        status: blocked ? 'blocked' : 'answerable',
        sources: perSource.map(row => row.source),
        answerableSources,
        warnings: [...warnings].sort(),
        perSource,
        suggestedNextStep: blocked
            ? 'Call source_health for details, then refresh or repair the local source before answering from it.'
            : 'Proceed with source-filtered retrieval from answerable requested sources only.',
    };
}

function buildAgentSourceHealth(data = {}, options = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const interactions = Array.isArray(data.interactions) ? data.interactions : [];
    const sourceEvents = Array.isArray(data.sourceEvents) ? data.sourceEvents : [];
    const contactEvidence = data.contactEvidence && typeof data.contactEvidence === 'object' && !Array.isArray(data.contactEvidence)
        ? data.contactEvidence : {};
    const syncState = data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)
        ? data.syncState : {};
    const refresh = sanitizeMemoryRefreshStatus(data.memoryRefreshStatus);
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
        if (rawState.status === 'error' || rawState.lastError) warnings.push('sync_error');
        if (!lastSyncAt) warnings.push('not_configured');
        if (!contactCount) warnings.push('no_contacts');
        if (!evidenceContactCount && !interactionCount && !sourceEventCount) warnings.push('no_query_evidence');
        if (fresh === 'stale' || fresh === 'unknown') warnings.push('no_recent_sync');
        const ready = warnings.length === 0 && fresh === 'fresh';
        rows[source] = {
            status: warnings.includes('sync_error') ? 'error' : ready ? 'ready' : fresh === 'stale' ? 'stale' : warnings.length ? 'limited' : 'ready',
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

    const hasRefreshWarning = refresh.status === 'failed' || refresh.status === 'error' || refresh.status === 'warning';
    const hasWarning = hasRefreshWarning || Object.values(rows).some(r => r.warnings.length || r.status !== 'ready');
    return {
        status: hasWarning ? 'warning' : 'ok',
        sources: rows,
        refresh,
        invalidSourceFilters: [],
        querySourceFilter: Array.isArray(options.querySourceFilter) ? options.querySourceFilter : undefined,
        safety: { readOnly: true, contactDetailsOmitted: true, rawRowsOmitted: true, tokenPathsOmitted: true },
    };
}

module.exports = { buildAgentSourceHealth, buildSourceAnswerability, canonicalSource, normalizeSourceFilter, sanitizeMemoryRefreshStatus };
