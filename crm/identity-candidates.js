/**
 * crm/identity-candidates.js — conservative identity review candidates.
 *
 * Exact identifiers can be marked auto-eligible; fuzzy/name/org overlap remains
 * review-only. Output is privacy-safe: no emails, phones, source IDs, or names.
 */

'use strict';

const { isPersonContact } = require('./person-contact');

const GENERIC_ORG_TOKENS = new Set(['labs', 'lab', 'inc', 'ltd', 'llc', 'limited', 'company', 'group', 'capital', 'ventures', 'founder', 'ceo', 'cto']);

function normalize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function emailKeys(c) {
    return [c.email, c.emails, c.sources?.googleContacts?.email, c.sources?.email?.email, c.sources?.linkedin?.email]
        .flat()
        .filter(Boolean)
        .map(e => String(e).toLowerCase().trim())
        .filter(e => e.includes('@'));
}

function phoneKeys(c) {
    return [c.phone, c.phones, c.sources?.googleContacts?.phone, c.sources?.sms?.phone, c.sources?.whatsapp?.phone]
        .flat()
        .filter(Boolean)
        .map(p => String(p).replace(/\D+/g, ''))
        .filter(p => p.length >= 7);
}

function sourceKeys(c) {
    const out = [];
    for (const [source, payload] of Object.entries(c.sources || {})) {
        if (!payload || typeof payload !== 'object') continue;
        for (const field of ['id', 'userId', 'profileId', 'memberId', 'handle', 'username']) {
            if (payload[field]) out.push(`${source}:${String(payload[field]).toLowerCase()}`);
        }
    }
    return out;
}

function nameParts(name) {
    return normalize(name).split(' ').filter(Boolean);
}

function orgTokens(c) {
    return normalize([c.company, c.organization, c.title, c.headline].filter(Boolean).join(' '))
        .split(' ')
        .filter(t => t.length >= 3 && !GENERIC_ORG_TOKENS.has(t));
}

function pairKey(a, b) {
    return [a, b].sort().join('\u0000');
}

function addCandidate(map, a, b, candidate) {
    if (!a || !b || a === b) return;
    const key = pairKey(a, b);
    if (!map.has(key)) map.set(key, { contactIds: [a, b].sort(), ...candidate });
}

function exactCandidates(contacts, out) {
    const indexes = [new Map(), new Map(), new Map()];
    const keyFns = [emailKeys, phoneKeys, sourceKeys];
    const labels = ['exact_email', 'exact_phone', 'exact_source_id'];
    for (let i = 0; i < indexes.length; i += 1) {
        const idx = indexes[i];
        for (const c of contacts) {
            for (const key of keyFns[i](c)) {
                if (!idx.has(key)) idx.set(key, []);
                idx.get(key).push(c.id);
            }
        }
        for (const ids of idx.values()) {
            const unique = [...new Set(ids)].sort();
            if (unique.length !== 2) continue;
            addCandidate(out, unique[0], unique[1], {
                decision: 'auto_exact',
                requiresReview: false,
                score: 100,
                reasons: [{ kind: labels[i], detail: 'Exact private identifier match; identifier omitted.' }],
            });
        }
    }
}

function fuzzyCandidates(contacts, out) {
    for (let i = 0; i < contacts.length; i += 1) {
        for (let j = i + 1; j < contacts.length; j += 1) {
            const a = contacts[i];
            const b = contacts[j];
            if (out.has(pairKey(a.id, b.id))) continue;
            const ap = nameParts(a.name);
            const bp = nameParts(b.name);
            if (ap.length < 2 || bp.length < 2) continue;
            const sameLast = ap.at(-1) === bp.at(-1);
            const firstClose = ap[0] === bp[0] || ap[0].slice(0, 4) === bp[0].slice(0, 4);
            const orgOverlap = orgTokens(a).filter(t => orgTokens(b).includes(t));
            if (sameLast && firstClose && orgOverlap.length) {
                addCandidate(out, a.id, b.id, {
                    decision: 'possible',
                    requiresReview: true,
                    score: 72,
                    reasons: [
                        { kind: 'name_similarity', detail: 'Similar full-name shape; names omitted.' },
                        { kind: 'org_overlap', detail: `${orgOverlap.length} distinctive organization/title token overlap${orgOverlap.length === 1 ? '' : 's'}.` },
                    ],
                });
            }
        }
    }
}

function proposeIdentityCandidates(contacts = []) {
    const safe = (Array.isArray(contacts) ? contacts : []).filter(isPersonContact);
    const out = new Map();
    exactCandidates(safe, out);
    fuzzyCandidates(safe, out);
    return [...out.values()].sort((a, b) => b.score - a.score || a.contactIds.join(':').localeCompare(b.contactIds.join(':')));
}

module.exports = { proposeIdentityCandidates };
