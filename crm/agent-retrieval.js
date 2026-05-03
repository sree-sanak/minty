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
    const { contacts: rawContacts, insights: rawInsights, limit = 10 } = safeOpts;
    const contacts = Array.isArray(rawContacts) ? rawContacts.filter(c => !c.isGroup) : [];
    const insights = rawInsights && typeof rawInsights === 'object' ? rawInsights : {};

    // 1. Build in-memory index from contacts
    const index = contacts.map(c => buildIndexEntry(c));

    // 2. Parse and filter. If structured filters yield nothing, consider the
    //    full index but later keep only semantically evidenced matches. This
    //    avoids returning merely-warm-but-irrelevant contacts to agents.
    const parsed = parseQuery(q);
    let candidates = filterIndex(index, parsed);
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

    // 5. Blend matchScore with goal-scoring for keyword relevance.
    //    In fallback mode, require at least one semantic evidence reason so
    //    impossible queries do not return unrelated warm contacts.
    const semanticKinds = new Set(['role', 'location', 'company', 'topic', 'keyword']);
    const genericTerms = new Set(['contact', 'contacts', 'person', 'people', 'network', 'anyone', 'someone']);
    const hasSpecificFreeTerms = expandQuery(parsed).freeTerms
        .some(term => !genericTerms.has(term));
    const hasStructuredTerms = (parsed.roles || []).length > 0 || (parsed.locations || []).length > 0;
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
        safety: {
            contactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'rawContact'],
            noLlmCalls:  true,
            readOnly:    true,
        },
    };
}

module.exports = { queryNetwork, warmthLabel, confidenceLevel, suggestAction };
