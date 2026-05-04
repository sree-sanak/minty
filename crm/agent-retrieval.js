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
const { matchContactEvidence } = require('./contact-evidence');
const { buildSourceEvents, summarizeSourceCoverage, safeContactRef } = require('./source-events');
const { buildHybridIndex, queryHybridIndex } = require('./hybrid-index');

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
    if (key === 'gmail') return 'email';
    if (key === 'googlecontact' || key === 'google') return 'googlecontacts';
    return SAFE_SOURCE_LABELS[key] ? key : 'interaction';
}

function normalizeSourceFilter(value) {
    const raw = Array.isArray(value) ? value : (value == null ? [] : [value]);
    return [...new Set(raw
        .map(canonicalSource)
        .filter(s => s && s !== 'interaction'))]
        .sort();
}

function hasMeaningfulPayload(payload) {
    return !!(payload && typeof payload === 'object' && Object.values(payload).some(v =>
        v != null && v !== '' && !(Array.isArray(v) && v.length === 0)
    ));
}

function contactSources(contact) {
    const sources = new Set();
    if (!contact || typeof contact !== 'object') return [];
    for (const [source, payload] of Object.entries(contact.sources || {})) {
        const canonical = canonicalSource(source);
        if (canonical !== 'interaction' && hasMeaningfulPayload(payload)) {
            sources.add(canonical);
        }
    }
    for (const source of contact.activeChannels || []) {
        const canonical = canonicalSource(source);
        if (canonical !== 'interaction') sources.add(canonical);
    }
    return [...sources].sort();
}

function contactMatchesSourceFilter(contact, sourceFilter) {
    if (!sourceFilter.length) return true;
    const sources = new Set(contactSources(contact));
    return sourceFilter.some(s => sources.has(s));
}

function interactionMatchesSourceFilter(interaction, sourceFilter) {
    if (!sourceFilter.length) return true;
    return sourceFilter.includes(canonicalSource(interaction && (interaction.source || interaction.channel)));
}

function evidenceSources(evidence) {
    const sources = new Set();
    for (const s of evidence && Array.isArray(evidence.sources) ? evidence.sources : []) {
        const canonical = canonicalSource(s);
        if (canonical !== 'interaction') sources.add(canonical);
    }
    for (const row of evidence && Array.isArray(evidence.topicEvidence) ? evidence.topicEvidence : []) {
        for (const s of Array.isArray(row.sources) ? row.sources : []) {
            const canonical = canonicalSource(s);
            if (canonical !== 'interaction') sources.add(canonical);
        }
    }
    return [...sources].sort();
}

function evidenceMatchesSourceFilter(evidence, sourceFilter) {
    if (!sourceFilter.length) return true;
    const sources = new Set(evidenceSources(evidence));
    return sourceFilter.some(s => sources.has(s));
}

function filterSourceEvents(sourceEvents, sourceFilter) {
    if (!sourceFilter.length || !Array.isArray(sourceEvents)) return sourceEvents;
    return sourceEvents.filter(e => sourceFilter.includes(canonicalSource(e && e.source)));
}

function matchedSourcesForContact(contact, sourceFilter, interactionEvidence, contactEvidenceMatch, hybridMatch) {
    const sources = new Set(contactSources(contact));
    for (const s of interactionEvidence && interactionEvidence.sources ? interactionEvidence.sources : []) sources.add(canonicalSource(s));
    for (const s of contactEvidenceMatch && contactEvidenceMatch.sources ? contactEvidenceMatch.sources : []) sources.add(canonicalSource(s));
    for (const s of hybridMatch && hybridMatch.sources ? hybridMatch.sources : []) sources.add(canonicalSource(s));
    const safe = [...sources].filter(s => s && s !== 'interaction');
    const filtered = sourceFilter.length ? safe.filter(s => sourceFilter.includes(s)) : safe;
    return [...new Set(filtered)].sort();
}

function sourceLabel(source) {
    return SAFE_SOURCE_LABELS[canonicalSource(source)] || 'Interaction evidence';
}

function collectSearchedSources(contacts, interactions, contactEvidence) {
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
    for (const ev of Object.values(contactEvidence && typeof contactEvidence === 'object' ? contactEvidence : {})) {
        for (const s of ev && Array.isArray(ev.sources) ? ev.sources : []) sources.add(canonicalSource(s));
        for (const row of ev && Array.isArray(ev.topicEvidence) ? ev.topicEvidence : []) {
            for (const s of Array.isArray(row.sources) ? row.sources : []) sources.add(canonicalSource(s));
        }
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
    if (['personal', 'direct', 'dm', 'one_to_one', 'one-to-one', 'private'].includes(type)) return true;
    // Telegram exports ordinary one-to-one chat rows as type="message" without a
    // contactId. After group/channel guards above, an exact chatName/from match is
    // safe enough for attribution and avoids treating "telegram" as dead data.
    return canonicalSource(i.source || i.channel) === 'telegram' && type === 'message';
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

function contactEvidenceReasonFor(contactId, matchesByContactId) {
    const match = matchesByContactId[contactId];
    if (!match || !match.matched) return null;
    const sources = (match.sources || []).map(canonicalSource).sort();
    const label = sources.length === 1 ? sourceLabel(sources[0]) : 'Cross-source topic evidence';
    const topicCount = (match.topics || []).length;
    const sourceCount = sources.filter(s => s !== 'interaction').length || sources.length || 1;
    return {
        kind: 'contact_evidence',
        label,
        detail: `${topicCount || 1} matching topic${topicCount === 1 ? '' : 's'} across ${sourceCount} source type${sourceCount === 1 ? '' : 's'}`,
    };
}

function hybridReasonFor(contactId, matchesByContactId) {
    const match = matchesByContactId[contactId];
    if (!match) return null;
    const topics = Array.isArray(match.matchedTopics) ? match.matchedTopics : [];
    if (!topics.length) return null;
    const sources = (match.sources || []).map(canonicalSource).sort();
    const label = sources.length === 1 ? sourceLabel(sources[0]) : 'Hybrid relationship evidence';
    return {
        kind: 'hybrid_evidence',
        label,
        detail: `${topics.length} topic anchor${topics.length === 1 ? '' : 's'} matched in local hybrid index`,
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
    const { contacts: rawContacts, insights: rawInsights, interactions: rawInteractions, contactEvidence: rawContactEvidence, sourceEvents: rawSourceEvents, hybridIndex: rawHybridIndex, limit = 10 } = safeOpts;
    const sourceFilter = normalizeSourceFilter(safeOpts.sources !== undefined ? safeOpts.sources : safeOpts.source);
    const contacts = (Array.isArray(rawContacts) ? rawContacts.filter(c => !c.isGroup) : [])
        .filter(c => contactMatchesSourceFilter(c, sourceFilter));
    const insightSource = rawInsights && typeof rawInsights === 'object' ? rawInsights : {};
    const insights = Object.create(null);
    for (const id of Object.keys(insightSource)) insights[id] = insightSource[id];
    const interactions = (Array.isArray(rawInteractions) ? rawInteractions : [])
        .filter(i => interactionMatchesSourceFilter(i, sourceFilter));
    const sourceEvents = filterSourceEvents(Array.isArray(rawSourceEvents)
        ? rawSourceEvents
        : buildSourceEvents({ contacts, interactions, insights }), sourceFilter);
    const contactIds = new Set(contacts.map(c => c.id));
    const contactEvidence = Object.create(null);
    const evidenceSource = rawContactEvidence && typeof rawContactEvidence === 'object' ? rawContactEvidence : {};
    for (const c of contacts) {
        const ref = safeContactRef(c.id);
        const ev = evidenceSource[c.id] || evidenceSource[ref];
        if (ev && evidenceMatchesSourceFilter(ev, sourceFilter)) contactEvidence[c.id] = ev;
    }

    // 1. Build in-memory index from contacts
    const index = contacts.map(c => buildIndexEntry(c));

    // 2. Parse and filter. If the query has specific free-text terms, scan the
    //    full index so low-warmth but semantically relevant contacts are not
    //    excluded before evidence scoring. Structured role/location queries keep
    //    the fast prefilter.
    const parsed = parseQuery(q);
    const queryTerms = expandQuery(parsed);
    const interactionEvidenceByContactId = buildInteractionEvidence(contacts, interactions, parsed);
    const interactionEvidenceIds = new Set(Object.keys(interactionEvidenceByContactId));
    const contactEvidenceMatches = Object.create(null);
    const queryTermsForEvidence = [...new Set([...(queryTerms.freeTerms || []), ...(queryTerms.expandedTerms || [])])];
    for (const id of Object.keys(contactEvidence)) {
        const match = matchContactEvidence(contactEvidence[id], queryTermsForEvidence);
        if (match.matched) contactEvidenceMatches[id] = match;
    }
    const contactEvidenceIds = new Set(Object.keys(contactEvidenceMatches));
    const hybridIndex = Array.isArray(rawHybridIndex)
        ? rawHybridIndex
        : buildHybridIndex({ contacts, contactEvidence, sourceEvents });
    const contactIdByRef = new Map(contacts.map(c => [safeContactRef(c.id), c.id]));
    const hybridMatches = Object.create(null);
    for (const match of queryHybridIndex(q, { index: hybridIndex, limit: 50 })) {
        const id = match.id && contactIds.has(match.id) ? match.id : contactIdByRef.get(match.contactRef);
        if (id) hybridMatches[id] = match;
    }
    const hybridMatchIds = new Set(Object.keys(hybridMatches));
    const genericTerms = new Set(['contact', 'contacts', 'person', 'people', 'network', 'anyone', 'someone']);
    const hasSpecificFreeTerms = [...(queryTerms.freeTerms || []), ...(queryTerms.expandedTerms || [])]
        .some(term => !genericTerms.has(term));
    const hasStructuredTerms = (parsed.roles || []).length > 0 || (parsed.locations || []).length > 0;
    let candidates = (hasSpecificFreeTerms && !hasStructuredTerms) ? index.slice() : filterIndex(index, parsed);
    const candidateIds = new Set(candidates.map(c => c.id));
    if (interactionEvidenceIds.size || contactEvidenceIds.size || hybridMatchIds.size) {
        for (const entry of index) {
            if ((interactionEvidenceIds.has(entry.id) || contactEvidenceIds.has(entry.id) || hybridMatchIds.has(entry.id)) && !candidateIds.has(entry.id)) {
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
        const contactEvidenceReason = contactEvidenceReasonFor(r.id, contactEvidenceMatches);
        if (contactEvidenceReason) {
            r.reasons = [...(r.reasons || []), contactEvidenceReason];
            r.matchScore = (r.matchScore || 0) + (contactEvidenceMatches[r.id].score || 30);
        }
        const hybridReason = hybridReasonFor(r.id, hybridMatches);
        if (hybridReason) {
            r.reasons = [...(r.reasons || []), hybridReason];
            r.matchScore = (r.matchScore || 0) + Math.min(45, hybridMatches[r.id].score || 20);
        }
    }

    // 5. Blend matchScore with goal-scoring for keyword relevance.
    //    In fallback mode, require at least one semantic evidence reason so
    //    impossible queries do not return unrelated warm contacts.
    const semanticKinds = new Set(['role', 'location', 'company', 'topic', 'keyword', 'interaction', 'contact_evidence', 'hybrid_evidence']);
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
    const results = evidenced.slice(0, safeLimit).map(r => {
        const contact = contactsById[r.id];
        return {
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
        matchedSources:    matchedSourcesForContact(contact, sourceFilter, interactionEvidenceByContactId[r.id], contactEvidenceMatches[r.id], hybridMatches[r.id]),
        suggestedAction:   suggestAction(r, parsed.intent),
        daysSinceContact:  r.daysSinceContact ?? null,
        interactionCount:  r.interactionCount || 0,
        };
    });

    const matchingContactIds = results.map(r => r.id);
    const sourceCoverage = summarizeSourceCoverage({ contacts, sourceEvents, matchingContactIds });

    return {
        query: q,
        intent: parsed.intent,
        results,
        diagnostics: {
            searchedSources: collectSearchedSources(contacts, interactions, contactEvidence),
            contactsConsidered: contacts.length,
            candidatesConsidered: candidates.length,
            resultsReturned: results.length,
            usedFallback,
            sourceFilter,
            interactionEvidenceContacts: Object.keys(interactionEvidenceByContactId).length,
            contactEvidenceContacts: Object.keys(contactEvidenceMatches).length,
            hybridEvidenceContacts: Object.keys(hybridMatches).length,
            sourceCoverage,
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
