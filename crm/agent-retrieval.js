/**
 * crm/agent-retrieval.js — Pure agent-facing network retrieval module.
 *
 * Combines network-query (parse + filter) and query-reasons (evidence) into a
 * single function that returns a stable, agent-friendly JSON envelope.
 *
 * No file I/O, no LLM calls, no side effects.
 * Caller supplies contacts + insights; this module does the rest.
 */

'use strict';

const { parseQuery, filterIndex, buildIndexEntry } = require('./network-query');
const { annotateResults, expandQuery } = require('./query-reasons');
const { scoreContactForGoal } = require('./utils');

// ---------------------------------------------------------------------------
// Warmth label from relationship score
// ---------------------------------------------------------------------------

function warmthLabel(score) {
    if (score >= 70) return 'strong';
    if (score >= 50) return 'warm';
    if (score >= 30) return 'cool';
    return 'cold';
}

// ---------------------------------------------------------------------------
// Confidence heuristic — how much evidence backs this result
// ---------------------------------------------------------------------------

function confidenceLevel(matchScore, relationshipScore) {
    const combined = (matchScore || 0) + (relationshipScore || 0) * 0.3;
    if (combined >= 60) return 'high';
    if (combined >= 30) return 'medium';
    return 'low';
}

// ---------------------------------------------------------------------------
// Suggested next action — contextual, safe, read-only
// ---------------------------------------------------------------------------

function suggestAction(result, intent) {
    const days = result.daysSinceContact;
    const warmth = warmthLabel(result.relationshipScore || 0);

    if (intent === 'intro') {
        if (warmth === 'strong' || warmth === 'warm') {
            return 'Ask for a warm intro — you have an active relationship.';
        }
        return 'Re-establish contact before requesting an intro.';
    }

    if (intent === 'reconnect' || (days != null && days > 60)) {
        return 'Send a low-pressure check-in referencing your last conversation.';
    }

    if (warmth === 'strong') {
        return 'Reach out directly — strong existing relationship.';
    }
    if (warmth === 'warm') {
        return 'Reference shared context or recent interaction to re-engage.';
    }
    if (warmth === 'cool') {
        return 'Find mutual connection or shared interest before reaching out.';
    }
    return 'Research shared context before cold outreach.';
}

// ---------------------------------------------------------------------------
// Privacy-safe interaction evidence
// ---------------------------------------------------------------------------

function normalizeNameKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const SAFE_SOURCE_LABELS = Object.freeze({
    telegram: 'Telegram evidence',
    whatsapp: 'WhatsApp evidence',
    email: 'Email evidence',
    sms: 'SMS evidence',
    linkedin: 'LinkedIn evidence',
    googlecontacts: 'Google Contacts evidence',
});

function canonicalSource(source) {
    const key = String(source || 'interaction').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return SAFE_SOURCE_LABELS[key] ? key : 'interaction';
}

function sourceLabel(source) {
    return SAFE_SOURCE_LABELS[canonicalSource(source)] || 'Interaction evidence';
}

function collectSearchedSources(contacts, interactions) {
    const sources = new Set();
    for (const c of contacts) {
        for (const [source, payload] of Object.entries(c.sources || {})) {
            const nonEmpty = payload && typeof payload === 'object' && Object.values(payload).some(v =>
                v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
            );
            if (nonEmpty) sources.add(canonicalSource(source));
        }
        for (const ch of c.activeChannels || []) sources.add(canonicalSource(ch));
    }
    for (const i of interactions) {
        const s = i && (i.source || i.channel);
        if (s) sources.add(canonicalSource(s));
    }
    return [...sources].sort();
}

const INTERACTION_TERM_STOPWORDS = new Set([
    'who', 'what', 'where', 'when', 'why', 'how', 'know', 'knows', 'known',
    'working', 'work', 'works', 'worked', 'with', 'about', 'help', 'helps',
    'person', 'people', 'contact', 'contacts', 'someone', 'anyone', 'find',
    'looking', 'look', 'network', 'connected', 'connection', 'connections',
]);

function buildInteractionTerms(parsed) {
    const query = expandQuery(parsed);
    return [...new Set([...(query.expandedTerms || []), ...(query.freeTerms || [])])]
        .map(t => String(t || '').toLowerCase().trim())
        .filter(t => t.length >= 3 && !INTERACTION_TERM_STOPWORDS.has(t));
}

function buildDirectInteractionTerms(parsed) {
    const query = expandQuery(parsed);
    return [...new Set(query.freeTerms || [])]
        .map(t => String(t || '').toLowerCase().trim())
        .filter(t => t.length >= 3 && !INTERACTION_TERM_STOPWORDS.has(t));
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEvidenceText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function interactionTermMatches(text, term) {
    const normalizedText = normalizeEvidenceText(text);
    const normalizedTerm = normalizeEvidenceText(term);
    if (!normalizedText || !normalizedTerm) return false;
    const words = normalizedTerm.split(' ').map(w => `${escapeRegExp(w)}s?`);
    return new RegExp(`(^| )${words.join(' ')}( |$)`).test(normalizedText);
}

function isNonPersonInteraction(i) {
    if (!i || typeof i !== 'object') return true;
    if (i.isGroup || i.isChannel || i.isBroadcast || i.groupId) return true;
    const threadType = String(i.threadType || '').toLowerCase();
    if (['group', 'channel', 'broadcast', 'mailing_list', 'mailing-list'].includes(threadType)) return true;
    if (Array.isArray(i.participants) && i.participants.length > 2) return true;
    const type = String(i.type || i.chatType || i.conversationType || '').toLowerCase();
    return ['group', 'channel', 'broadcast', 'mailing_list', 'mailing-list'].includes(type);
}

function isPersonalInteractionNameFallback(i) {
    if (isNonPersonInteraction(i)) return false;
    const type = String(i.type || i.chatType || i.conversationType || '').toLowerCase();
    if (!type) return false;
    return ['personal', 'direct', 'dm', 'one_to_one', 'one-to-one', 'private'].includes(type);
}

function buildInteractionEvidence(contacts, interactions, parsed) {
    const evidenceByContactId = Object.create(null);
    const rawInteractions = Array.isArray(interactions) ? interactions : [];
    if (!rawInteractions.length || !contacts.length) return evidenceByContactId;

    const byId = new Set(contacts.map(c => c.id));
    const byName = new Map();
    for (const c of contacts) {
        const key = normalizeNameKey(c.name);
        if (key) byName.set(key, c.id);
    }

    const terms = buildInteractionTerms(parsed);
    const directTerms = buildDirectInteractionTerms(parsed);
    if (!terms.length) return evidenceByContactId;

    for (const i of rawInteractions) {
        if (!i || typeof i !== 'object') continue;
        if (isNonPersonInteraction(i)) continue;
        const text = [i.body, i.subject, i.summary, i.topic, i.topics, i.raw?.text]
            .flat()
            .filter(Boolean)
            .join(' ');
        if (!text) continue;
        const matched = terms.filter(t => interactionTermMatches(text, t)).slice(0, 3);
        const directMatched = directTerms.filter(t => interactionTermMatches(text, t));
        if (!matched.length) continue;
        if (!directMatched.length && matched.length < 2) continue;

        let contactId = i.contactId || i.contact_id || i.personId || i.participantContactId;
        if (!byId.has(contactId) && isPersonalInteractionNameFallback(i)) {
            const candidates = [i.chatName, i.from, i.to, i.senderName, i.recipientName]
                .map(normalizeNameKey)
                .filter(Boolean);
            contactId = candidates.map(k => byName.get(k)).find(Boolean);
        }
        if (!byId.has(contactId)) continue;

        const source = canonicalSource(i.source || i.channel || 'interaction');
        if (!evidenceByContactId[contactId]) {
            evidenceByContactId[contactId] = { sources: new Set(), count: 0 };
        }
        evidenceByContactId[contactId].sources.add(source);
        evidenceByContactId[contactId].count += 1;
    }

    return evidenceByContactId;
}

function interactionReasonFor(contactId, evidenceByContactId) {
    const ev = evidenceByContactId[contactId];
    if (!ev) return null;
    const sources = [...ev.sources].sort();
    const label = sources.length === 1 ? sourceLabel(sources[0]) : 'Cross-source interaction evidence';
    const sourceCount = sources.filter(s => s !== 'interaction').length || sources.length;
    return {
        kind: 'interaction',
        label,
        detail: `${ev.count} matching interaction${ev.count === 1 ? '' : 's'} across ${sourceCount} source type${sourceCount === 1 ? '' : 's'}`,
    };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Query the network for agent consumption.
 *
 * @param {string} query - Natural language query
 * @param {object} opts
 * @param {object[]} opts.contacts - Full contact objects (from contacts.json)
 * @param {object}   opts.insights - insights keyed by contact id
 * @param {number}   [opts.limit=10] - Max results to return
 * @returns {{ query: string, intent: string, results: object[], safety: object }}
 */
const MAX_QUERY_LENGTH = 1000;

function queryNetwork(query, opts = {}) {
    const q = typeof query === 'string' ? query.slice(0, MAX_QUERY_LENGTH) : '';
    const safeOpts = opts != null && typeof opts === 'object' ? opts : {};
    const { contacts: rawContacts, insights: rawInsights, interactions: rawInteractions, limit = 10 } = safeOpts;
    const contacts = Array.isArray(rawContacts) ? rawContacts.filter(c => !c.isGroup) : [];
    const insightSource = rawInsights && typeof rawInsights === 'object' ? rawInsights : {};
    const insights = Object.create(null);
    for (const id of Object.keys(insightSource)) insights[id] = insightSource[id];
    const interactions = Array.isArray(rawInteractions) ? rawInteractions : [];

    // 1. Build in-memory index from contacts
    const index = contacts.map(c => buildIndexEntry(c));

    // 2. Parse and filter. If the query has specific free-text terms, scan the
    //    full index so low-warmth but semantically relevant contacts are not
    //    excluded before evidence scoring. Structured role/location queries keep
    //    the fast prefilter.
    const parsed = parseQuery(q);
    const interactionEvidenceByContactId = buildInteractionEvidence(contacts, interactions, parsed);
    const interactionEvidenceIds = new Set(Object.keys(interactionEvidenceByContactId));
    const genericTerms = new Set(['contact', 'contacts', 'person', 'people', 'network', 'anyone', 'someone']);
    const queryTerms = expandQuery(parsed);
    const hasSpecificFreeTerms = [...(queryTerms.freeTerms || []), ...(queryTerms.expandedTerms || [])]
        .some(term => !genericTerms.has(term));
    const hasStructuredTerms = (parsed.roles || []).length > 0 || (parsed.locations || []).length > 0;
    let candidates = (hasSpecificFreeTerms && !hasStructuredTerms) ? index.slice() : filterIndex(index, parsed);
    if (interactionEvidenceIds.size) {
        const candidateIds = new Set(candidates.map(c => c.id));
        for (const entry of index) {
            if (interactionEvidenceIds.has(entry.id) && !candidateIds.has(entry.id)) {
                candidates.push(entry);
                candidateIds.add(entry.id);
            }
        }
    }
    const usedFallback = candidates.length === 0 && index.length > 0;
    if (usedFallback) {
        candidates = index.slice();
    }

    // 3. Build contactsById for reasons engine. Use a null-prototype map so
    // contact ids like "__proto__" remain data, not inherited object behavior.
    const contactsById = Object.create(null);
    for (const c of contacts) contactsById[c.id] = c;

    // 4. Annotate with evidence/reasons
    const annotated = annotateResults(parsed, candidates, {
        contactsById,
        insightsByContactId: insights,
    });
    for (const r of annotated) {
        const interactionReason = interactionReasonFor(r.id, interactionEvidenceByContactId);
        if (interactionReason) {
            r.reasons = [...(r.reasons || []), interactionReason];
            r.matchScore = (r.matchScore || 0) + 35;
        }
    }

    // 5. Blend matchScore with goal-scoring for keyword relevance.
    //    In fallback mode, require at least one semantic evidence reason so
    //    impossible queries do not return unrelated warm contacts.
    const semanticKinds = new Set(['role', 'location', 'company', 'topic', 'keyword', 'interaction']);
    const requireSemanticEvidence = usedFallback || (hasSpecificFreeTerms && !hasStructuredTerms);
    const evidenced = annotated.filter(r =>
        !requireSemanticEvidence || (r.reasons || []).some(reason => semanticKinds.has(reason.kind))
    );
    for (const r of evidenced) {
        const contact = contactsById[r.id];
        const goalScore = contact ? scoreContactForGoal(contact, q) : 0;
        r.matchScore = (r.matchScore || 0) + goalScore;
    }

    // 6. Sort by blended score descending
    evidenced.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

    // 7. Shape into stable agent envelope
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;
    const results = evidenced.slice(0, safeLimit).map(r => ({
        id:                r.id,
        name:              r.name,
        title:             r.title || null,
        company:           r.company || null,
        city:              r.city || null,
        relevance:         r.matchScore || 0,
        relationshipScore: r.relationshipScore || 0,
        warmth:            warmthLabel(r.relationshipScore || 0),
        confidence:        confidenceLevel(r.matchScore, r.relationshipScore),
        evidence:          (r.reasons || []).map(reason => ({
            kind:   reason.kind,
            label:  reason.label,
            detail: reason.detail || null,
        })),
        evidenceBacked:    (r.reasons || []).length > 0,
        suggestedAction:   suggestAction(r, parsed.intent),
        daysSinceContact:  r.daysSinceContact ?? null,
        interactionCount:  r.interactionCount || 0,
    }));

    return {
        query: q,
        intent: parsed.intent,
        results,
        diagnostics: {
            searchedSources: collectSearchedSources(contacts, interactions),
            contactsConsidered: contacts.length,
            candidatesConsidered: candidates.length,
            resultsReturned: results.length,
            usedFallback,
            interactionEvidenceContacts: Object.keys(interactionEvidenceByContactId).length,
        },
        safety: {
            contactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'rawContact'],
            noLlmCalls:  true,
            readOnly:    true,
        },
    };
}

module.exports = { queryNetwork, warmthLabel, confidenceLevel, suggestAction };
