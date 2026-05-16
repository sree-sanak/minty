'use strict';

/**
 * crm/source-quality-workbench.js — privacy-safe source trust-gap summary.
 *
 * Pure functions only. Builds a compact review queue from existing local
 * source-health and identity primitives without exposing raw contacts,
 * messages, provider ids, paths, or credentials.
 */

const { buildAgentSourceHealth, canonicalSource, normalizeSourceFilter } = require('./agent-source-health');
const { proposeIdentityCandidates } = require('./identity-candidates');

function sortSources(sources) {
    return [...sources].sort((a, b) => a.localeCompare(b));
}

function hasConfiguredState(row) {
    return !!(row && row.lastSyncAt) || (row && Array.isArray(row.warnings) && !row.warnings.includes('not_configured'));
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

function sourceScopedContacts(contacts, options) {
    const rawFilters = [];
    if (options && options.source !== undefined) rawFilters.push(options.source);
    if (options && options.sources !== undefined) {
        if (Array.isArray(options.sources)) rawFilters.push(...options.sources);
        else rawFilters.push(options.sources);
    }
    if (!rawFilters.length) return contacts;
    const filter = normalizeSourceFilter(rawFilters);
    if (filter.invalid.length) return [];
    if (!filter.sources.length) return contacts;
    const selected = new Set(filter.sources);
    return contacts.filter(contact => [...contactSources(contact)].some(source => selected.has(source)));
}

function sourceRowsFromHealth(health) {
    const sources = health && health.sources && typeof health.sources === 'object' && !Array.isArray(health.sources)
        ? health.sources
        : {};
    return Object.entries(sources)
        .map(([source, row]) => ({ source: canonicalSource(source), ...(row && typeof row === 'object' ? row : {}) }))
        .filter(row => row.source)
        .sort((a, b) => a.source.localeCompare(b.source));
}

function evidenceHasTopics(evidence) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    if (Array.isArray(evidence.topics) && evidence.topics.some(t => typeof t === 'string' && t.trim())) return true;
    if (Array.isArray(evidence.topicEvidence) && evidence.topicEvidence.some(row => row && typeof row === 'object')) return true;
    return false;
}

function weakEvidenceSources(rows, contactEvidence) {
    const evidenceRows = contactEvidence && typeof contactEvidence === 'object' && !Array.isArray(contactEvidence)
        ? Object.values(contactEvidence)
        : [];
    return rows
        .filter(row => row.interactionCount > 0 || row.sourceEventCount > 0 || row.evidenceContactCount > 0)
        .filter(row => {
            if (!row.evidenceContactCount) return true;
            return evidenceRows.some(evidence => {
                const evidenceSources = Array.isArray(evidence && evidence.sources) ? evidence.sources : [];
                const sourceMatch = evidenceSources.map(canonicalSource).includes(row.source);
                return sourceMatch && !evidenceHasTopics(evidence);
            });
        })
        .map(row => ({
            ref: `source:${row.source}:evidence`,
            source: row.source,
            severity: 'watch',
            evidenceContactCount: row.evidenceContactCount || 0,
            interactionCount: row.interactionCount || 0,
            warning: 'weak_or_missing_contact_evidence',
            action: 'Review source events or contact evidence so agents can cite why this source is relevant.',
        }));
}

function staleOrUnhealthySources(rows) {
    return rows
        .filter(row => row.status === 'error' || row.status === 'stale' || row.freshness === 'stale' || (Array.isArray(row.warnings) && row.warnings.includes('sync_error')))
        .map(row => ({
            ref: `source:${row.source}:health`,
            source: row.source,
            severity: row.status === 'error' || (row.warnings || []).includes('sync_error') ? 'fix' : 'watch',
            status: row.status || 'limited',
            freshness: row.freshness || 'unknown',
            warnings: sortSources((Array.isArray(row.warnings) ? row.warnings : []).filter(Boolean)),
            action: 'Refresh or repair this local source before relying on it for source-specific answers.',
        }));
}

function ingestionGaps(rows) {
    return rows
        .filter(row => hasConfiguredState(row))
        .filter(row => (row.contactCount || 0) === 0 && (row.interactionCount || 0) === 0 && (row.evidenceContactCount || 0) === 0 && (row.sourceEventCount || 0) === 0)
        .map(row => ({
            ref: `source:${row.source}:ingestion`,
            source: row.source,
            severity: 'setup',
            warning: 'configured_without_usable_records',
            contactCount: 0,
            interactionCount: 0,
            action: 'Check importer output and run merge so this source contributes usable network memory.',
        }));
}

function ambiguousIdentityClusters(contacts) {
    return proposeIdentityCandidates(contacts)
        .filter(candidate => candidate && candidate.requiresReview)
        .slice(0, 20)
        .map((candidate, index) => ({
            ref: `identity:${index + 1}`,
            severity: 'review',
            candidateCount: Array.isArray(candidate.contactIds) ? candidate.contactIds.length : 0,
            reasonKinds: sortSources((Array.isArray(candidate.reasons) ? candidate.reasons : [])
                .map(reason => reason && reason.kind)
                .filter(kind => typeof kind === 'string' && kind)),
            action: 'Review ambiguous identity match before trusting cross-source context.',
        }));
}

function makeBucket(label, description, items) {
    return {
        label,
        description,
        count: items.length,
        items,
    };
}

function buildSourceQualityWorkbench(data = {}, options = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const contactsForIdentityReview = sourceScopedContacts(contacts, options);
    const contactEvidence = data.contactEvidence && typeof data.contactEvidence === 'object' && !Array.isArray(data.contactEvidence)
        ? data.contactEvidence
        : {};
    const health = buildAgentSourceHealth(data, options);
    const rows = sourceRowsFromHealth(health);

    const buckets = {
        ambiguousIdentityClusters: makeBucket(
            'Ambiguous identity clusters',
            'Potential duplicate people that need local review before cross-source context is trusted.',
            ambiguousIdentityClusters(contactsForIdentityReview),
        ),
        weakEvidenceSources: makeBucket(
            'Weak source evidence',
            'Sources with records but weak or missing agent-citable evidence.',
            weakEvidenceSources(rows, contactEvidence),
        ),
        staleOrUnhealthySources: makeBucket(
            'Stale or unhealthy sources',
            'Sources that should be refreshed or repaired before source-specific answers.',
            staleOrUnhealthySources(rows),
        ),
        ingestionGaps: makeBucket(
            'Ingestion gaps',
            'Configured sources that currently have no usable merged records.',
            ingestionGaps(rows),
        ),
    };
    const totalOpenItems = Object.values(buckets).reduce((sum, bucket) => sum + bucket.count, 0);
    return {
        status: totalOpenItems ? 'needs_review' : 'clear',
        summary: {
            totalOpenItems,
            sourcesReviewed: rows.length,
            generatedFrom: ['source_health', 'identity_candidates', 'contact_evidence'],
        },
        buckets,
        emptyState: totalOpenItems ? null : 'No source-quality trust gaps found for the selected local sources.',
        safety: {
            readOnly: true,
            contactDetailsOmitted: true,
            rawRowsOmitted: true,
            opaqueRefsOnly: true,
            tokenPathsOmitted: true,
        },
    };
}

module.exports = { buildSourceQualityWorkbench };
