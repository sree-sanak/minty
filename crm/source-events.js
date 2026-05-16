/**
 * crm/source-events.js — privacy-safe canonical source event abstraction.
 *
 * Converts local source records into aggregate-safe relationship-memory events.
 * Events preserve provenance, type, timestamp, contact attribution, and signal
 * shape, but never raw text, contact details, names, emails, phones, URLs, or
 * arbitrary channel/thread labels.
 */

'use strict';

const crypto = require('node:crypto');

const SAFE_SOURCE_LABELS = Object.freeze({
    telegram: 'telegram',
    whatsapp: 'whatsapp',
    email: 'email',
    gmail: 'email',
    sms: 'sms',
    linkedin: 'linkedin',
    slack: 'slack',
    slackchannel: 'slack',
    slackdm: 'slack',
    slackdirectmessage: 'slack',
    discord: 'discord',
    discorddm: 'discord',
    discorddirectmessage: 'discord',
    discorddirectgroup: 'discord',
    discordgroupdm: 'discord',
    googlecontacts: 'googlecontacts',
    googlecontact: 'googlecontacts',
    google: 'googlecontacts',
    calendar: 'calendar',
    interaction: 'interaction',
});

function canonicalSafeSource(source) {
    const key = String(source || 'interaction').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return SAFE_SOURCE_LABELS[key] || 'interaction';
}

function safeContactRef(contactId) {
    const hex = crypto.createHash('sha256').update(String(contactId || '')).digest('hex').slice(0, 16);
    const alphabetic = hex.replace(/[0-9a-f]/g, ch => 'abcdefghijklmnop'[parseInt(ch, 16)]);
    return `contact:${alphabetic}`;
}

function parseSafeTimestamp(value) {
    if (!value) return null;
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    const year = d.getUTCFullYear();
    if (year < 1990 || year > 2100) return null;
    return d.toISOString();
}

function hasMeaningfulPayload(payload) {
    return !!(payload && typeof payload === 'object' && Object.values(payload).some(v =>
        v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
    ));
}

function eventTypeForInteraction(i) {
    const raw = String(i.type || i.kind || i.eventType || '').toLowerCase();
    if (raw.includes('call')) return 'call';
    if (raw.includes('meeting') || raw.includes('calendar')) return 'meeting';
    if (raw.includes('intro')) return 'intro';
    return 'message';
}

function isGroupLike(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.isGroup || value.isChannel || value.isBroadcast || value.groupId) return true;
    if (Array.isArray(value.participants) && value.participants.length > 2) return true;
    const type = String(value.type || value.chatType || value.conversationType || '').toLowerCase();
    return ['group', 'channel', 'broadcast', 'mailing_list', 'mailing-list'].includes(type);
}

function textSignal(i) {
    return [i.body, i.subject, i.summary, i.topic, i.topics, i.text]
        .flat()
        .filter(Boolean)
        .join(' ')
        .trim();
}

function buildSourceEvents({ contacts = [], interactions = [], insights = {} } = {}) {
    const safeContacts = Array.isArray(contacts) ? contacts : [];
    const byId = new Map(safeContacts.filter(c => c && c.id && !isGroupLike(c)).map(c => [c.id, c]));
    const events = [];

    for (const c of safeContacts) {
        if (!c || !c.id || isGroupLike(c)) continue;
        const sources = Object.entries(c.sources || {})
            .filter(([, payload]) => hasMeaningfulPayload(payload))
            .map(([source]) => canonicalSafeSource(source))
            .filter(source => source !== 'interaction')
            .sort();
        for (const source of [...new Set(sources)]) {
            events.push({
                id: `profile:${events.length}:${source}`,
                type: 'profile',
                source,
                contactRef: safeContactRef(c.id),
                timestamp: parseSafeTimestamp(c.updatedAt || c.lastSyncedAt || c.createdAt),
                confidence: 1,
                hasTextSignal: false,
                attributed: true,
            });
        }
    }

    const rawInteractions = Array.isArray(interactions) ? interactions : [];
    for (let idx = 0; idx < rawInteractions.length; idx += 1) {
        const i = rawInteractions[idx];
        if (!i || typeof i !== 'object') continue;
        if (isGroupLike(i)) continue;
        const contactId = i.contactId || i.contact_id || i.personId || i.participantContactId || null;
        if (contactId && !byId.has(contactId)) {
            const rawContact = safeContacts.find(c => c && c.id === contactId);
            if (rawContact && isGroupLike(rawContact)) continue;
        }
        const attributed = contactId != null && byId.has(contactId);
        const source = canonicalSafeSource(i.source || i.channel || 'interaction');
        events.push({
            id: `interaction:${idx}`,
            type: attributed ? eventTypeForInteraction(i) : 'unattributed_interaction',
            source,
            contactRef: attributed ? safeContactRef(contactId) : null,
            timestamp: parseSafeTimestamp(i.timestamp || i.date || i.createdAt || i.lastContactedAt),
            confidence: attributed ? 0.8 : 0.2,
            hasTextSignal: !!textSignal(i),
            attributed,
        });
    }

    const insightSource = insights && typeof insights === 'object' ? insights : {};
    for (const [contactId, insight] of Object.entries(insightSource)) {
        if (!byId.has(contactId) || !insight || typeof insight !== 'object') continue;
        const hasSignal = [insight.summary, insight.notes, insight.topics, insight.keywords].flat().some(Boolean);
        if (!hasSignal) continue;
        events.push({
            id: `insight:${events.length}`,
            type: 'insight',
            source: 'interaction',
            contactRef: safeContactRef(contactId),
            timestamp: parseSafeTimestamp(insight.updatedAt || insight.generatedAt || insight.lastSeenAt),
            confidence: 0.6,
            hasTextSignal: true,
            attributed: true,
        });
    }

    return events.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function countBy(items, fn) {
    const out = Object.create(null);
    for (const item of items) {
        const key = fn(item);
        if (!key) continue;
        out[key] = (out[key] || 0) + 1;
    }
    return out;
}

function summarizeSourceCoverage({ contacts = [], sourceEvents = [], matchingContactIds = [] } = {}) {
    const safeContacts = Array.isArray(contacts) ? contacts.filter(c => c && !isGroupLike(c)) : [];
    const events = Array.isArray(sourceEvents) ? sourceEvents.filter(e => e && typeof e === 'object' && !Array.isArray(e)) : [];
    const matchIds = new Set(Array.isArray(matchingContactIds) ? matchingContactIds : []);
    const matchRefs = new Set([...matchIds].map(safeContactRef));
    const profileContactsBySource = Object.create(null);
    for (const c of safeContacts) {
        for (const [source, payload] of Object.entries(c.sources || {})) {
            if (hasMeaningfulPayload(payload)) {
                const s = canonicalSafeSource(source);
                if (s !== 'interaction') profileContactsBySource[s] = (profileContactsBySource[s] || 0) + 1;
            }
        }
    }
    const eventCountsBySource = countBy(events, e => canonicalSafeSource(e.source));
    const matchingSources = new Set();
    for (const e of events) {
        const ref = e && (e.contactRef || (e.contactId ? safeContactRef(e.contactId) : null));
        if (ref && matchRefs.has(ref)) matchingSources.add(canonicalSafeSource(e.source));
    }
    const availableSources = new Set([...Object.keys(profileContactsBySource), ...Object.keys(eventCountsBySource)]);
    const attributedEvents = events.filter(e => e && e.attributed !== false && (e.contactRef || e.contactId)).length;
    return {
        availableSources: [...availableSources].sort(),
        matchingSources: [...matchingSources].sort(),
        missingCoreSources: ['email', 'calendar', 'telegram', 'linkedin'].filter(s => !availableSources.has(s)),
        profileContactsBySource,
        eventCountsBySource,
        totalEvents: events.length,
        attributedEvents,
        unattributedEvents: events.length - attributedEvents,
        matchingContacts: matchIds.size,
    };
}

module.exports = {
    SAFE_SOURCE_LABELS,
    canonicalSafeSource,
    safeContactRef,
    parseSafeTimestamp,
    hasMeaningfulPayload,
    buildSourceEvents,
    summarizeSourceCoverage,
};
