/**
 * crm/hybrid-index.js — local deterministic hybrid relationship index.
 *
 * First shippable local layer: lexical query terms + allowlisted topic evidence
 * + source/event graph boosts. No embeddings, no external DB, no raw snippets.
 */

'use strict';

const { canonicalSafeSource, safeContactRef } = require('./source-events');
const { extractAllowedTopics } = require('./evidence-patches');

const STOPWORDS = new Set([
    'who', 'what', 'where', 'when', 'why', 'how', 'know', 'knows', 'known',
    'working', 'work', 'works', 'worked', 'with', 'about', 'help', 'helps',
    'person', 'people', 'contact', 'contacts', 'someone', 'anyone', 'find',
    'looking', 'look', 'network', 'connected', 'connection', 'connections',
    'the', 'and', 'for', 'into', 'in', 'on', 'to', 'of', 'do', 'i', 'me', 'my',
]);

function tokenize(value) {
    return String(value || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function collectEvidenceTopics(ev) {
    const topics = [];
    for (const t of Array.isArray(ev && ev.topics) ? ev.topics : []) {
        topics.push(...extractAllowedTopics(t));
    }
    for (const row of Array.isArray(ev && ev.topicEvidence) ? ev.topicEvidence : []) {
        topics.push(...extractAllowedTopics(row && row.topic));
    }
    return [...new Set(topics)].sort();
}

function buildHybridIndex({ contacts = [], contactEvidence = {}, sourceEvents = [] } = {}) {
    const safeContacts = Array.isArray(contacts) ? contacts.filter(c => c && c.id && !c.isGroup) : [];
    const eventsByContact = new Map();
    for (const e of Array.isArray(sourceEvents) ? sourceEvents : []) {
        const ref = e && (e.contactRef || (e.contactId ? safeContactRef(e.contactId) : null));
        if (!ref) continue;
        if (!eventsByContact.has(ref)) eventsByContact.set(ref, []);
        eventsByContact.get(ref).push(e);
    }
    return safeContacts.map(c => {
        const ref = safeContactRef(c.id);
        const ev = contactEvidence && typeof contactEvidence === 'object' ? (contactEvidence[c.id] || contactEvidence[ref]) : null;
        const topicTokens = collectEvidenceTopics(ev);
        const eventRows = eventsByContact.get(ref) || [];
        const sources = new Set();
        for (const s of Array.isArray(ev && ev.sources) ? ev.sources : []) sources.add(canonicalSafeSource(s));
        for (const row of Array.isArray(ev && ev.topicEvidence) ? ev.topicEvidence : []) {
            for (const s of Array.isArray(row && row.sources) ? row.sources : []) sources.add(canonicalSafeSource(s));
        }
        for (const e of eventRows) sources.add(canonicalSafeSource(e.source));
        const topicEvidenceCount = (Array.isArray(ev && ev.topicEvidence) ? ev.topicEvidence : [])
            .reduce((sum, row) => sum + Number(row && row.count || 0), 0);
        return {
            contactRef: ref,
            topicTokens,
            sources: [...sources].filter(Boolean).sort(),
            relationshipScore: Number(c.relationshipScore || 0),
            evidenceCount: Number(ev && ev.evidenceCount || 0) + topicEvidenceCount + eventRows.length,
            latestAt: ev && ev.latestAt || eventRows.map(e => e.timestamp).filter(Boolean).sort().at(-1) || null,
        };
    });
}

function queryHybridIndex(query, { index = [], limit = 10 } = {}) {
    const queryTopics = extractAllowedTopics(query);
    const terms = tokenize(query);
    if (!queryTopics.length && terms.length < 2) return [];
    const results = [];
    for (const row of Array.isArray(index) ? index : []) {
        if (!row || !(row.contactRef || row.id)) continue;
        const matchedTopics = (row.topicTokens || []).filter(t => queryTopics.includes(t));
        if (!matchedTopics.length) continue;
        const score = matchedTopics.length * 50 + Math.min(20, Number(row.evidenceCount || 0) * 3) + Math.min(10, Number(row.relationshipScore || 0) / 10);
        results.push({
            contactRef: row.contactRef || safeContactRef(row.id),
            id: row.id,
            score,
            matchedTopics,
            matchedProfileTerms: [],
            sources: row.sources || [],
            evidenceBacked: matchedTopics.length > 0 && (row.evidenceCount || 0) > 0,
        });
    }
    results.sort((a, b) => b.score - a.score || String(a.contactRef || a.id).localeCompare(String(b.contactRef || b.id)));
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    return results.slice(0, safeLimit);
}

module.exports = { tokenize, buildHybridIndex, queryHybridIndex };
