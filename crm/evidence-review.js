'use strict';

const { safeContactRef, canonicalSafeSource, parseSafeTimestamp } = require('./source-events');
const { extractAllowedTopics } = require('./evidence-patches');

const CONTACT_REF_RE = /^contact:[a-p]{16}$/;
const OVERRIDE_KEY_SEP = '\0';

function overrideKey(contactRef, topic) {
    return `${contactRef}${OVERRIDE_KEY_SEP}${topic}`;
}

function isPersonContact(contact) {
    if (!contact || typeof contact !== 'object' || !contact.id) return false;
    if (contact.isGroup || contact.isChannel || contact.isBroadcast || contact.isList || contact.isMailingList) return false;
    const type = String(contact.type || contact.kind || contact.contactType || contact.threadType || '').toLowerCase();
    return !['group', 'channel', 'broadcast', 'list', 'mailing_list', 'mailing-list', 'distribution_list', 'distribution-list'].includes(type);
}

function normalizeDecision(value) {
    if (value === 'suppress') return 'suppressed';
    if (value === 'suppressed') return 'suppressed';
    return 'active';
}

function normalizeOverrides(overrides = {}) {
    const map = new Map();
    for (const row of Array.isArray(overrides && overrides.suppressions) ? overrides.suppressions : []) {
        if (!row || typeof row !== 'object') continue;
        const contactRef = typeof row.contactRef === 'string' ? row.contactRef : '';
        if (!CONTACT_REF_RE.test(contactRef)) continue;
        const topic = extractAllowedTopics(row.topic)[0];
        if (!topic) continue;
        const decision = normalizeDecision(row.decision);
        if (decision !== 'suppressed') continue;
        map.set(overrideKey(contactRef, topic), {
            decision,
            reviewedAt: parseSafeTimestamp(row.reviewedAt),
        });
    }
    return map;
}

function safeSources(value, fallback = []) {
    const raw = Array.isArray(value) && value.length ? value : fallback;
    return [...new Set(raw.map(canonicalSafeSource).filter(Boolean))].sort();
}

function safeEvidenceCount(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
}

function safeConfidence(value, fallback = null) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function topicRowsForContact(contact, evidence, overrideMap) {
    const ref = safeContactRef(contact.id);
    const topicEvidence = Array.isArray(evidence && evidence.topicEvidence) ? evidence.topicEvidence : [];
    const sourceFallback = safeSources(evidence && evidence.sources);
    const rows = [];

    for (const row of topicEvidence) {
        const topic = extractAllowedTopics(row && row.topic)[0];
        if (!topic) continue;
        const override = overrideMap.get(overrideKey(ref, topic)) || {};
        rows.push({
            contactRef: ref,
            contactName: contact.name || 'Unknown person',
            topic,
            sources: safeSources(row && row.sources, sourceFallback),
            evidenceCount: safeEvidenceCount(row && row.count, 0),
            confidence: safeConfidence(row && row.confidence, safeConfidence(evidence && evidence.confidence)),
            latestAt: parseSafeTimestamp((row && row.latestAt) || (evidence && (evidence.latestAt || evidence.lastEvidenceAt || evidence.updatedAt))),
            decision: override.decision || 'active',
            reviewedAt: override.reviewedAt || null,
        });
    }

    for (const rawTopic of Array.isArray(evidence && evidence.topics) ? evidence.topics : []) {
        const topic = extractAllowedTopics(rawTopic)[0];
        if (!topic || rows.some(r => r.topic === topic)) continue;
        const override = overrideMap.get(overrideKey(ref, topic)) || {};
        rows.push({
            contactRef: ref,
            contactName: contact.name || 'Unknown person',
            topic,
            sources: sourceFallback,
            evidenceCount: safeEvidenceCount(evidence && (evidence.evidenceCount || evidence.interactionCount), 0),
            confidence: safeConfidence(evidence && evidence.confidence),
            latestAt: parseSafeTimestamp(evidence && (evidence.latestAt || evidence.lastEvidenceAt || evidence.updatedAt)),
            decision: override.decision || 'active',
            reviewedAt: override.reviewedAt || null,
        });
    }

    return rows;
}

function buildEvidenceReviewRows({ contacts = [], contactEvidence = {}, overrides = {}, limit = 100 } = {}) {
    const evidence = contactEvidence && typeof contactEvidence === 'object' ? contactEvidence : {};
    const overrideMap = normalizeOverrides(overrides);
    const rows = [];
    for (const contact of Array.isArray(contacts) ? contacts : []) {
        if (!isPersonContact(contact)) continue;
        const ref = safeContactRef(contact.id);
        const ev = evidence[contact.id] || evidence[ref];
        if (!ev || typeof ev !== 'object') continue;
        rows.push(...topicRowsForContact(contact, ev, overrideMap));
    }
    rows.sort((a, b) =>
        (b.decision === 'active') - (a.decision === 'active') ||
        Number(b.evidenceCount || 0) - Number(a.evidenceCount || 0) ||
        String(b.latestAt || '').localeCompare(String(a.latestAt || '')) ||
        String(a.contactName || '').localeCompare(String(b.contactName || '')) ||
        String(a.topic || '').localeCompare(String(b.topic || ''))
    );
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    return {
        status: rows.length ? 'ok' : 'empty',
        rows: rows.slice(0, safeLimit),
        safety: {
            contactDetailsOmitted: true,
            rawMessagesOmitted: true,
            rawContactIdsOmitted: true,
            readOnly: true,
        },
    };
}

function topicSuppressed(overrideMap, ref, topic) {
    return overrideMap.get(overrideKey(ref, topic))?.decision === 'suppressed';
}

function applyEvidenceOverrides({ contactEvidence = {}, overrides = {} } = {}) {
    const evidence = contactEvidence && typeof contactEvidence === 'object' ? contactEvidence : {};
    const overrideMap = normalizeOverrides(overrides);
    const out = {};
    if (overrideMap.size === 0) {
        for (const [key, ev] of Object.entries(evidence)) {
            out[key] = ev && typeof ev === 'object' ? { ...ev } : ev;
        }
        return out;
    }
    for (const [key, ev] of Object.entries(evidence)) {
        if (!ev || typeof ev !== 'object') continue;
        const ref = key.startsWith('contact:') ? key : safeContactRef(key);
        const topicRows = Array.isArray(ev.topicEvidence) ? ev.topicEvidence : [];
        const keptTopicRows = topicRows
            .map(row => ({ row, topic: extractAllowedTopics(row && row.topic)[0] }))
            .filter(({ topic }) => topic && !topicSuppressed(overrideMap, ref, topic))
            .map(({ row, topic }) => ({ ...row, topic }));
        const keptTopics = [...new Set([
            ...keptTopicRows.map(row => row.topic),
            ...(Array.isArray(ev.topics) ? ev.topics : [])
                .map(topic => extractAllowedTopics(topic)[0])
                .filter(topic => topic && !topicSuppressed(overrideMap, ref, topic)),
        ])].sort();
        if (!keptTopics.length) continue;
        const sources = keptTopicRows.length
            ? safeSources(keptTopicRows.flatMap(row => Array.isArray(row.sources) ? row.sources : []))
            : safeSources(ev.sources);
        const evidenceCount = keptTopicRows.length
            ? keptTopicRows.reduce((sum, row) => sum + safeEvidenceCount(row.count, 0), 0)
            : safeEvidenceCount(ev.evidenceCount || ev.interactionCount, 0);
        out[key] = {
            ...ev,
            topics: keptTopics,
            topicEvidence: keptTopicRows,
            sources,
            evidenceCount,
        };
    }
    return out;
}

function updateEvidenceOverride({ overrides = {}, contactRef, topic, decision, now = new Date().toISOString() } = {}) {
    if (!CONTACT_REF_RE.test(String(contactRef || ''))) throw new Error('invalid contactRef');
    const safeTopic = extractAllowedTopics(topic)[0];
    if (!safeTopic) throw new Error('invalid topic');
    if (!['suppress', 'restore'].includes(decision)) throw new Error('invalid decision');
    const reviewedAt = parseSafeTimestamp(now) || new Date().toISOString();
    const suppressions = (Array.isArray(overrides && overrides.suppressions) ? overrides.suppressions : [])
        .filter(row => !(row && row.contactRef === contactRef && extractAllowedTopics(row.topic)[0] === safeTopic));
    if (decision === 'suppress') {
        suppressions.push({ contactRef, topic: safeTopic, decision: 'suppress', reviewedAt });
    }
    suppressions.sort((a, b) => String(a.contactRef).localeCompare(String(b.contactRef)) || String(a.topic).localeCompare(String(b.topic)));
    return { suppressions };
}

module.exports = {
    buildEvidenceReviewRows,
    normalizeOverrides,
    applyEvidenceOverrides,
    updateEvidenceOverride,
};
