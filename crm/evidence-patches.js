/**
 * crm/evidence-patches.js — deterministic structured evidence patch layer.
 *
 * This is the local, schema-first replacement for dumping raw message snippets
 * into retrieval. Extraction is intentionally narrow and allowlisted until a
 * stronger local/LLM structured extractor is added.
 */

'use strict';

const { canonicalSafeSource, parseSafeTimestamp } = require('./source-events');

const TOPIC_PATTERNS = Object.freeze([
    { topic: 'defi', regex: /\b(defi|decentralized finance)\b/i },
    { topic: 'lending protocol', regex: /\b(lending protocols?|borrow(?:ing)? protocols?|credit protocols?)\b/i },
    { topic: 'custody', regex: /\b(custody|custodian|wallet custody|asset custody)\b/i },
    { topic: 'insurance', regex: /\b(insurance|underwriting|mga|broker)\b/i },
    { topic: 'fintech', regex: /\b(fintech|payments?|banking|compliance)\b/i },
    { topic: 'ai', regex: /\b(ai|artificial intelligence|machine learning|ml)\b/i },
    { topic: 'crypto', regex: /\b(crypto|web3|blockchain)\b/i },
    { topic: 'construction', regex: /\b(construction|contractor|jobsite|site safety)\b/i },
]);

const ALLOWED_TOPICS = new Set(TOPIC_PATTERNS.map(t => t.topic));

function sanitizeText(value) {
    return String(value || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
        .replace(/\+?\d[\d ().-]{6,}\d/g, ' ')
        .replace(/[^a-z0-9+\-\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractAllowedTopics(text) {
    const safe = sanitizeText(text);
    if (!safe) return [];
    const topics = [];
    for (const { topic, regex } of TOPIC_PATTERNS) {
        if (regex.test(safe)) topics.push(topic);
    }
    return [...new Set(topics)];
}

function validateEvidencePatch(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, reason: 'not_object' };
    if (!patch.contactId || typeof patch.contactId !== 'string') return { ok: false, reason: 'missing_contact_id' };
    if (!ALLOWED_TOPICS.has(patch.topic)) return { ok: false, reason: 'topic_not_allowed' };
    const source = canonicalSafeSource(patch.source);
    if (source === 'interaction' && String(patch.source || '').toLowerCase().replace(/[^a-z0-9]+/g, '') !== 'interaction') {
        return { ok: false, reason: 'unsafe_source' };
    }
    const confidence = Number(patch.confidence ?? 0.5);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, reason: 'invalid_confidence' };
    return { ok: true };
}

function extractEvidencePatchesFromEvent(event) {
    if (!event || typeof event !== 'object' || !event.contactId) return [];
    const source = canonicalSafeSource(event.source);
    const raw = [event.text, event.body, event.subject, event.summary, event.topic, event.topics]
        .flat()
        .filter(Boolean)
        .join(' ');
    const topics = extractAllowedTopics(raw);
    const timestamp = parseSafeTimestamp(event.timestamp);
    return topics.map(topic => ({
        contactId: String(event.contactId),
        topic,
        source,
        timestamp,
        confidence: Number.isFinite(Number(event.confidence)) ? Math.max(0, Math.min(1, Number(event.confidence))) : 0.5,
    }));
}

function applyEvidencePatches({ contacts = [], patches = [] } = {}) {
    const allowedContacts = new Set((Array.isArray(contacts) ? contacts : [])
        .filter(c => c && c.id && !c.isGroup)
        .map(c => c.id));
    const out = Object.create(null);
    for (const patch of Array.isArray(patches) ? patches : []) {
        const validation = validateEvidencePatch(patch);
        if (!validation.ok || !allowedContacts.has(patch.contactId)) continue;
        const source = canonicalSafeSource(patch.source);
        const timestamp = parseSafeTimestamp(patch.timestamp);
        if (!out[patch.contactId]) {
            out[patch.contactId] = {
                topics: [],
                sources: [],
                topicEvidence: [],
                evidenceCount: 0,
                latestAt: null,
                confidence: 0,
            };
        }
        const ev = out[patch.contactId];
        ev.evidenceCount += 1;
        ev.confidence = Math.max(ev.confidence || 0, Number(patch.confidence || 0.5));
        if (!ev.sources.includes(source)) ev.sources.push(source);
        if (!ev.topics.includes(patch.topic)) ev.topics.push(patch.topic);
        if (timestamp && (!ev.latestAt || timestamp > ev.latestAt)) ev.latestAt = timestamp;
        let row = ev.topicEvidence.find(r => r.topic === patch.topic);
        if (!row) {
            row = { topic: patch.topic, sources: [], count: 0, latestAt: null, confidence: 0 };
            ev.topicEvidence.push(row);
        }
        row.count += 1;
        row.confidence = Math.max(row.confidence || 0, Number(patch.confidence || 0.5));
        if (!row.sources.includes(source)) row.sources.push(source);
        if (timestamp && (!row.latestAt || timestamp > row.latestAt)) row.latestAt = timestamp;
    }
    for (const ev of Object.values(out)) {
        ev.topics.sort();
        ev.sources.sort();
        ev.topicEvidence.sort((a, b) => a.topic.localeCompare(b.topic));
    }
    return out;
}

module.exports = {
    TOPIC_PATTERNS,
    ALLOWED_TOPICS,
    sanitizeText,
    extractAllowedTopics,
    extractEvidencePatchesFromEvent,
    validateEvidencePatch,
    applyEvidencePatches,
};
