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
    slack: 'slack',
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

function isDirectSlackInteraction(i) {
    if (canonicalSource(i && (i.source || i.channel)) !== 'slack') return false;
    const type = String(i.type || i.chatType || i.conversationType || i.threadType || '').toLowerCase();
    const channelId = String(i.channelId || i.channel_id || i.chatId || '').trim();
    if (channelId) return /^D[A-Z0-9]+$/.test(channelId);
    return ['dm', 'direct', 'direct_message', 'im'].includes(type);
}

function isNonPersonInteraction(i) {
    if (!i || typeof i !== 'object') return true;
    if (i.isGroup || i.isChannel || i.isBroadcast || i.isList || i.isMailingList || i.groupId || i.threadType === 'group') return true;
    if (Array.isArray(i.participants) && i.participants.length > 2) return true;
    const type = String(i.type || i.chatType || i.conversationType || i.threadType || '').toLowerCase();
    if (['group', 'channel', 'broadcast', 'list', 'mailing_list', 'mailing-list', 'distribution_list', 'distribution-list'].includes(type)) return true;
    if (canonicalSource(i.source || i.channel) === 'slack' && !isDirectSlackInteraction(i)) return true;
    return false;
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

function isPersonContact(c) {
    if (!c || !c.id || c.isGroup || c.isChannel || c.isBroadcast || c.isList || c.isMailingList) return false;
    const type = String(c.type || c.kind || c.contactType || c.threadType || '').toLowerCase();
    return !['group', 'channel', 'broadcast', 'list', 'mailing_list', 'mailing-list', 'distribution_list', 'distribution-list'].includes(type);
}

function buildNameIndex(contacts) {
    const map = new Map();
    for (const c of Array.isArray(contacts) ? contacts : []) {
        if (!isPersonContact(c)) continue;
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

function buildSourceActorIndex(contacts) {
    const map = new Map();
    for (const c of Array.isArray(contacts) ? contacts : []) {
        if (!isPersonContact(c)) continue;
        for (const [sourceName, src] of Object.entries(c.sources || {})) {
            if (!src || typeof src !== 'object') continue;
            const source = canonicalSource(sourceName);
            const ids = (source === 'slack'
                ? [src.userId, src.user_id, src.slackId, src.memberId]
                : [src.id, src.userId, src.user_id, src.slackId, src.memberId])
                .filter(v => v != null && String(v).trim());
            for (const id of ids) {
                const key = `${source}:${String(id).trim()}`;
                if (!map.has(key)) map.set(key, c.id);
            }
        }
    }
    return map;
}

function fallbackContactIdForInteraction(i, nameIndex, sourceActorIndex) {
    if (!i || isNonPersonInteraction(i)) return null;
    const direct = i && (i.contactId || i.contact_id || i.personId || i.participantContactId);
    if (direct) return direct;
    const source = canonicalSource(i.source || i.channel);
    const actorIds = [i.from, i.fromId, i.senderId, i.userId, i.user, i.authorId]
        .filter(v => v != null && String(v).trim());
    for (const actorId of actorIds) {
        const id = sourceActorIndex.get(`${source}:${String(actorId).trim()}`);
        if (id) return id;
    }
    const names = [i.chatName, i.fromName, i.senderName, i.recipientName, i.contactName];
    for (const name of names) {
        const id = nameIndex.get(normalizeTopic(name));
        if (id) return id;
    }
    return null;
}

function sourceList(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return [...value];
    if (typeof value === 'string') return [value];
    return [];
}

function buildContactEvidence({ contacts = [], interactions = [], insights = {} } = {}) {
    const ids = new Set((Array.isArray(contacts) ? contacts : []).filter(isPersonContact).map(c => c.id));
    const nameIndex = buildNameIndex(contacts);
    const sourceActorIndex = buildSourceActorIndex(contacts);
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
        const contactId = fallbackContactIdForInteraction(i, nameIndex, sourceActorIndex);
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
        : (Array.isArray(evidence.topics) ? evidence.topics.map(topic => ({ topic, sources: sourceList(evidence.sources), count: 1 })) : []);
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
        const rowSources = sourceList(row.sources);
        for (const source of (rowSources.length ? rowSources : sourceList(evidence.sources))) sources.add(canonicalSource(source));
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
