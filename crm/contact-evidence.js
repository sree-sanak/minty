/**
 * crm/contact-evidence.js — privacy-safe per-contact topic evidence.
 *
 * Pure functions. No file I/O, no LLM calls. Turns source interactions and
 * batch insights into compact evidence envelopes agents can retrieve without
 * exposing raw messages, subjects, chat names, emails, phones, or snippets.
 */

'use strict';

const { safeContactRef } = require('./source-events');

const SAFE_SOURCE_LABELS = Object.freeze({
    telegram: 'telegram',
    whatsapp: 'whatsapp',
    email: 'email',
    sms: 'sms',
    linkedin: 'linkedin',
    googlecontacts: 'googleContacts',
});

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'had',
    'are', 'was', 'were', 'you', 'your', 'our', 'their', 'they', 'them', 'who',
    'what', 'when', 'where', 'why', 'how', 'know', 'knows', 'known', 'work',
    'works', 'worked', 'working', 'talked', 'discussed', 'mentioned', 'about',
    'follow', 'followup', 'follow-up', 'chat', 'call', 'meeting', 'message',
    'person', 'people', 'contact', 'contacts', 'someone', 'anyone', 'please',
    'thanks', 'hello', 'hi', 're', 'fw', 'fwd', 'subject', 'summary', 'body',
]);

const TOPIC_PATTERNS = [
    { topic: 'defi', patterns: [/\bdefi\b/i, /\bdecentralized finance\b/i] },
    { topic: 'lending protocol', patterns: [/\blending protocols?\b/i, /\bborrowing protocols?\b/i] },
    { topic: 'protocol', patterns: [/\bprotocols?\b/i] },
    { topic: 'crypto', patterns: [/\bcrypto\b/i, /\bweb3\b/i, /\bblockchain\b/i, /\bdigital assets?\b/i] },
    { topic: 'insurance', patterns: [/\binsurance\b/i, /\binsurtech\b/i, /\bunderwriting\b/i, /\breinsurance\b/i] },
    { topic: 'risk', patterns: [/\brisk\b/i, /\brisks\b/i] },
    { topic: 'compliance', patterns: [/\bcompliance\b/i, /\baml\b/i, /\bkyc\b/i, /\bfinancial crime\b/i] },
    { topic: 'custody', patterns: [/\bcustody\b/i, /\bcustodian\b/i] },
    { topic: 'payments', patterns: [/\bpayments?\b/i, /\bbilling\b/i, /\bcheckout\b/i] },
    { topic: 'ai', patterns: [/\bai\b/i, /\bml\b/i, /\bmachine learning\b/i, /\bllm\b/i] },
    { topic: 'startup', patterns: [/\bstartup\b/i, /\bstartups\b/i, /\bfounder\b/i, /\bco-?founder\b/i] },
];

function canonicalSource(source) {
    const key = String(source || 'interaction').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return SAFE_SOURCE_LABELS[key] || 'interaction';
}

function isNonPersonInteraction(i) {
    if (!i || typeof i !== 'object') return true;
    if (i.isGroup || i.isChannel || i.isBroadcast || i.groupId || i.threadType === 'group') return true;
    if (Array.isArray(i.participants) && i.participants.length > 2) return true;
    const type = String(i.type || i.chatType || i.conversationType || '').toLowerCase();
    return ['group', 'channel', 'broadcast', 'mailing_list', 'mailing-list'].includes(type);
}

function textForEvidence(i) {
    return [i.body, i.subject, i.summary, i.topic, i.topics]
        .flat()
        .filter(Boolean)
        .join(' ');
}

function normalizeTopic(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\b\S+@\S+\.\S+\b/g, ' ')
        .replace(/\+?\d[\d\s().-]{6,}\d/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isAllowedTopic(topic) {
    const t = normalizeTopic(topic);
    return TOPIC_PATTERNS.some(pattern => normalizeTopic(pattern.topic) === t);
}

function extractTopics(text) {
    const normalized = String(text || '');
    const topics = new Set();
    for (const { topic, patterns } of TOPIC_PATTERNS) {
        if (patterns.some(re => re.test(normalized))) topics.add(topic);
    }
    return [...topics].slice(0, 24);
}

function addTopic(acc, topic, source, timestamp) {
    const t = normalizeTopic(topic);
    if (!t || t.length < 2 || STOPWORDS.has(t) || !isAllowedTopic(t)) return;
    if (!acc.topicCounts[t]) acc.topicCounts[t] = { count: 0, sources: new Set(), lastEvidenceAt: null };
    acc.topicCounts[t].count += 1;
    acc.topicCounts[t].sources.add(source);
    if (timestamp && (!acc.topicCounts[t].lastEvidenceAt || timestamp > acc.topicCounts[t].lastEvidenceAt)) {
        acc.topicCounts[t].lastEvidenceAt = timestamp;
    }
}

function validTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getUTCFullYear() > 2100) return null;
    return date.toISOString();
}

function buildNameIndex(contacts) {
    const map = new Map();
    for (const c of Array.isArray(contacts) ? contacts : []) {
        if (!c || !c.id || c.isGroup) continue;
        const names = [c.name, c.displayName, c.fullName];
        for (const src of Object.values(c.sources || {})) {
            if (src && typeof src === 'object') names.push(src.name, src.displayName, src.fullName);
        }
        for (const name of names) {
            const n = normalizeTopic(name);
            if (n && n.length >= 3 && !map.has(n)) map.set(n, c.id);
        }
    }
    return map;
}

function fallbackContactIdForInteraction(i, nameIndex) {
    if (!i) return null;
    const direct = i && (i.contactId || i.contact_id || i.personId || i.participantContactId);
    if (direct) return direct;
    if (isNonPersonInteraction(i)) return null;
    const names = [i.chatName, i.fromName, i.senderName, i.recipientName, i.contactName];
    for (const name of names) {
        const id = nameIndex.get(normalizeTopic(name));
        if (id) return id;
    }
    return null;
}

function buildContactEvidence({ contacts = [], interactions = [], insights = {} } = {}) {
    const ids = new Set((Array.isArray(contacts) ? contacts : []).filter(c => c && c.id && !c.isGroup).map(c => c.id));
    const nameIndex = buildNameIndex(contacts);
    const byContact = Object.create(null);

    function ensure(contactId) {
        if (!ids.has(contactId)) return null;
        const ref = safeContactRef(contactId);
        if (!byContact[ref]) {
            byContact[ref] = {
                contactRef: ref,
                sources: new Set(),
                sourceCounts: Object.create(null),
                topicCounts: Object.create(null),
                interactionCount: 0,
                lastEvidenceAt: null,
            };
        }
        return byContact[ref];
    }

    for (const i of Array.isArray(interactions) ? interactions : []) {
        if (!i || typeof i !== 'object' || isNonPersonInteraction(i)) continue;
        const contactId = fallbackContactIdForInteraction(i, nameIndex);
        const acc = ensure(contactId);
        if (!acc) continue;
        const text = textForEvidence(i);
        if (!text) continue;
        const topics = extractTopics(text);
        if (!topics.length) continue;
        const source = canonicalSource(i.source || i.channel);
        const ts = validTimestamp(i.timestamp || i.date || i.createdAt || i.startedAt);
        acc.sources.add(source);
        acc.sourceCounts[source] = (acc.sourceCounts[source] || 0) + 1;
        acc.interactionCount += 1;
        if (ts && (!acc.lastEvidenceAt || ts > acc.lastEvidenceAt)) acc.lastEvidenceAt = ts;
        for (const topic of topics) addTopic(acc, topic, source, ts);
    }

    for (const [contactId, insight] of Object.entries(insights && typeof insights === 'object' ? insights : {})) {
        const acc = ensure(contactId);
        if (!acc || !insight || typeof insight !== 'object') continue;
        const source = 'interaction';
        const ts = validTimestamp(insight.analyzedAt || insight.updatedAt || insight.createdAt);
        for (const topic of Array.isArray(insight.topics) ? insight.topics : []) {
            acc.sources.add(source);
            addTopic(acc, topic, source, ts);
        }
        if (ts && (!acc.lastEvidenceAt || ts > acc.lastEvidenceAt)) acc.lastEvidenceAt = ts;
    }

    const out = {};
    for (const [contactRef, acc] of Object.entries(byContact)) {
        const topicRows = Object.entries(acc.topicCounts)
            .map(([topic, meta]) => ({ topic, count: meta.count, sources: [...meta.sources].sort(), lastEvidenceAt: meta.lastEvidenceAt }))
            .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
        if (!topicRows.length) continue;
        out[contactRef] = {
            contactRef,
            topics: topicRows.slice(0, 20).map(r => r.topic),
            topicEvidence: topicRows.slice(0, 20),
            sources: [...acc.sources].sort(),
            sourceCounts: { ...acc.sourceCounts },
            interactionCount: acc.interactionCount,
            lastEvidenceAt: acc.lastEvidenceAt,
            confidence: Math.min(1, Math.round((0.35 + Math.min(acc.interactionCount, 5) * 0.1 + Math.min(acc.sources.size, 3) * 0.1) * 100) / 100),
        };
    }
    return out;
}

function termMatchesTopic(term, topic) {
    const t = normalizeTopic(term);
    const p = normalizeTopic(topic);
    if (!t || !p) return false;
    return p === t || p.includes(t) || t.includes(p);
}

function matchContactEvidence(evidence, terms = []) {
    if (!evidence || typeof evidence !== 'object') return { matched: false, score: 0, topics: [], sources: [] };
    const queryTerms = [...new Set((Array.isArray(terms) ? terms : []).map(normalizeTopic).filter(Boolean))];
    if (!queryTerms.length) return { matched: false, score: 0, topics: [], sources: [] };
    const rawTopicRows = Array.isArray(evidence.topicEvidence)
        ? evidence.topicEvidence
        : (Array.isArray(evidence.topics) ? evidence.topics.map(topic => ({ topic, sources: evidence.sources || [], count: 1 })) : []);
    const topicRows = [];
    for (const row of rawTopicRows) {
        for (const topic of extractTopics(row.topic)) {
            topicRows.push({ ...row, topic });
        }
    }
    const matchedRows = [];
    for (const row of topicRows) {
        if (queryTerms.some(term => termMatchesTopic(term, row.topic))) matchedRows.push(row);
    }
    if (!matchedRows.length) return { matched: false, score: 0, topics: [], sources: [] };
    const sources = new Set();
    let count = 0;
    for (const row of matchedRows) {
        count += row.count || 1;
        for (const source of row.sources || evidence.sources || []) sources.add(canonicalSource(source));
    }
    const score = 25 + Math.min(30, matchedRows.length * 8 + count * 3) + Math.round((evidence.confidence || 0) * 10);
    return {
        matched: true,
        score,
        topics: matchedRows.slice(0, 5).map(r => r.topic),
        sources: [...sources].sort(),
        evidenceCount: count,
        lastEvidenceAt: evidence.lastEvidenceAt || null,
    };
}

module.exports = {
    buildContactEvidence,
    matchContactEvidence,
    extractTopics,
    canonicalSource,
    isNonPersonInteraction,
};
