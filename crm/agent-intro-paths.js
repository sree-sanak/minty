'use strict';

const { queryNetwork } = require('./agent-retrieval');
const { findIntroPaths } = require('./people-graph');
const { agentSafetyEnvelope, redactDirectContactDetails } = require('./privacy-envelope');

function buildAgentIntroPaths(data = {}, opts = {}) {
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(isUsableContact) : [];
    const groupMemberships = isPlainObject(data.groupMemberships) ? data.groupMemberships : {};
    const targetQuery = safeInput(opts.target);
    const goalQuery = safeInput(opts.goal);
    const limit = clampLimit(opts.limit, 5);
    const safety = { ...agentSafetyEnvelope({ omittedFields: ['groupNames', 'groupIds', 'rawSyncState'] }), noOutreachTriggered: true };

    if (!targetQuery && !goalQuery) return empty('missing_input', 'Provide target or goal to find intro paths.', safety, { target: targetQuery, goal: goalQuery }, data);
    if (!contacts.length || Object.keys(groupMemberships).length === 0) return empty('no_group_graph', 'No local group graph is available for intro paths.', safety, { target: targetQuery, goal: goalQuery }, data);

    const targets = targetQuery
        ? findTargetMatches(contacts, targetQuery)
        : goalTargetMatches(data, goalQuery, limit * 3);

    if (!targets.length) {
        return empty(targetQuery ? 'no_target_matches' : 'no_goal_targets', 'No matching target with local evidence was found.', safety, { target: targetQuery, goal: goalQuery }, data);
    }

    const paths = [];
    for (const target of targets) {
        const introPaths = findIntroPaths(target.id, contacts, groupMemberships, { maxPaths: limit, maxGroupSize: 80 });
        for (const path of introPaths) {
            paths.push(safePath(target, path, paths.length, contacts));
            if (paths.length >= limit) break;
        }
        if (paths.length >= limit) break;
    }

    if (!paths.length) return empty('no_path', 'No safe warm intro path was found for the matched target.', safety, { target: targetQuery, goal: goalQuery }, data);

    return {
        status: 'ok',
        query: cleanQuery({ target: targetQuery, goal: goalQuery }, data),
        paths,
        safety,
    };
}

function findTargetMatches(contacts, query) {
    const terms = tokenize(query);
    if (!terms.length) return [];
    return contacts.filter(contact => {
        const text = targetSearchText(contact);
        return terms.every(term => text.includes(term));
    });
}

function goalTargetMatches(data, goal, limit) {
    const result = queryNetwork(goal, {
        contacts: Array.isArray(data.contacts) ? data.contacts : [],
        interactions: Array.isArray(data.interactions) ? data.interactions : [],
        insights: isPlainObject(data.insights) ? data.insights : {},
        contactEvidence: isPlainObject(data.contactEvidence) ? data.contactEvidence : {},
        sourceEvents: Array.isArray(data.sourceEvents) ? data.sourceEvents : undefined,
        hybridIndex: Array.isArray(data.hybridIndex) ? data.hybridIndex : undefined,
        syncState: isPlainObject(data.syncState) ? data.syncState : {},
        nowForTests: data.nowForTests,
        limit,
    });
    const ids = new Set((result.results || []).map(r => r.id).filter(id => typeof id === 'string'));
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(isUsableContact) : [];
    if (ids.size === 0) {
        const terms = tokenize(goal);
        const evidence = isPlainObject(data.contactEvidence) ? data.contactEvidence : {};
        return contacts.filter(contact => {
            const evidenceText = Array.isArray(evidence[contact.id])
                ? evidence[contact.id].map(item => [item && item.label, item && item.detail, item && item.kind].filter(Boolean).join(' ')).join(' ')
                : '';
            const text = `${targetSearchText(contact)} ${evidenceText}`.toLowerCase();
            return terms.every(term => text.includes(term));
        }).slice(0, limit);
    }
    return contacts.filter(contact => ids.has(contact.id));
}

function safePath(target, path, index, contacts) {
    const sharedGroups = Array.isArray(path.sharedGroupsWithTarget) ? path.sharedGroupsWithTarget : [];
    const count = sharedGroups.length;
    const smallestSize = sharedGroups.reduce((min, group) => Math.min(min, Number(group.size) || Infinity), Infinity);
    const intermediaryScore = Number(path.intermediaryScore) || 0;
    const intermediary = Array.isArray(contacts) ? contacts.find(c => c && c.id === path.intermediaryId) : null;
    const freshnessDays = safeDays(path.intermediaryDaysSinceContact) ?? safeDays(path.daysSinceContact) ?? safeDays(intermediary && intermediary.daysSinceContact);
    const sharedContext = {
        kind: 'private_group_membership',
        count,
        sizeBucket: sizeBucket(Number.isFinite(smallestSize) ? smallestSize : 0),
    };
    const drivers = ['local_group_evidence'];
    if (intermediaryScore >= 70) drivers.unshift('warm_intermediary');
    if (sharedContext.sizeBucket === 'small') drivers.splice(drivers.includes('warm_intermediary') ? 1 : 0, 0, 'small_shared_context');
    return {
        target: safePerson(target),
        intermediary: safeIntermediary(path),
        sharedContext,
        confidence: confidence(intermediaryScore, sharedContext.sizeBucket, count),
        confidenceDrivers: [...new Set(drivers)],
        freshness: freshnessSummary(freshnessDays),
        citations: [{ ref: `result:${index + 1}:cite:1`, source: 'group', field: 'sharedContext', matchType: 'co_membership', provenance: 'derived-local' }],
        sourceSummary: '1 local group citation; warm intro evidence',
    };
}

function safePerson(contact) {
    return {
        name: redact(contact.name),
        ...(title(contact) ? { title: redact(title(contact)) } : {}),
        ...(company(contact) ? { company: redact(company(contact)) } : {}),
        warmth: warmthLabel(contact.relationshipScore),
    };
}

function safeIntermediary(path) {
    return {
        name: redact(path.intermediaryName),
        ...(path.intermediaryTitle ? { title: redact(path.intermediaryTitle) } : {}),
        ...(path.intermediaryCompany ? { company: redact(path.intermediaryCompany) } : {}),
        warmth: warmthLabel(path.intermediaryScore),
    };
}

function empty(reasonCode, reason, safety, query, data) {
    return { status: 'empty', reasonCode, reason, query: cleanQuery(query, data), paths: [], safety };
}

function cleanQuery(query, data = {}) {
    const out = {};
    if (query && query.target) out.target = sanitizeSelector(query.target, data);
    if (query && query.goal) out.goal = sanitizeSelector(query.goal, data);
    return out;
}

function isUsableContact(contact) {
    return contact && typeof contact === 'object' && !Array.isArray(contact)
        && typeof contact.id === 'string' && typeof contact.name === 'string' && contact.name.trim()
        && !contact.isGroup && !contact.isChannel && !contact.isBroadcast && !contact.isList && !contact.isMailingList;
}

function targetSearchText(contact) {
    return [
        contact.name,
        title(contact),
        company(contact),
        contact.apollo && contact.apollo.headline,
    ].filter(Boolean).join(' ').toLowerCase();
}

function title(contact) {
    return contact.apollo?.headline || contact.sources?.linkedin?.position || contact.sources?.linkedin?.title || contact.sources?.googleContacts?.title || null;
}

function company(contact) {
    return contact.sources?.linkedin?.company || contact.sources?.googleContacts?.org || null;
}

function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(term => term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term);
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function clampLimit(value, fallback) {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(20, Math.floor(n)));
}

function safeInput(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function redact(value) {
    return redactDirectContactDetails(String(value || '').trim());
}

function sanitizeSelector(value, data = {}) {
    let out = redact(value);
    for (const token of sensitiveTokens(data)) {
        out = replaceAllLiteral(out, token, '[redacted-id]');
    }
    out = out
        .replace(/\b[\w.+-]+@g\.us\b/gi, '[redacted-group-id]')
        .replace(/\b(?:raw|private|secret)[-_][a-z0-9@._:-]+\b/gi, '[redacted-id]');
    return out.trim();
}

function sensitiveTokens(data = {}) {
    const tokens = [];
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    for (const contact of contacts) {
        if (!contact || typeof contact !== 'object') continue;
        addToken(tokens, contact.id);
        addToken(tokens, contact.sources?.linkedin?.publicIdentifier);
        addToken(tokens, contact.sources?.linkedin?.profileId);
        addToken(tokens, contact.sources?.googleContacts?.resourceName);
        addToken(tokens, contact.sources?.telegram?.userId);
        addToken(tokens, contact.sources?.whatsapp?.jid);
        for (const membership of Array.isArray(contact.groupMemberships) ? contact.groupMemberships : []) {
            addToken(tokens, membership && membership.chatId);
            addToken(tokens, membership && membership.chatName);
        }
    }
    const groups = isPlainObject(data.groupMemberships) ? data.groupMemberships : {};
    for (const [groupId, group] of Object.entries(groups)) {
        addToken(tokens, groupId);
        if (group && typeof group === 'object') addToken(tokens, group.name);
    }
    return tokens.sort((a, b) => b.length - a.length);
}

function addToken(tokens, value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) tokens.push(trimmed);
}

function replaceAllLiteral(text, token, replacement) {
    return String(text).replace(new RegExp(escapeRegExp(token), 'gi'), replacement);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function warmthLabel(score) {
    const n = Number(score) || 0;
    if (n >= 70) return 'strong';
    if (n >= 40) return 'warm';
    if (n > 0) return 'cold';
    return 'unknown';
}

function sizeBucket(size) {
    if (size > 0 && size <= 8) return 'small';
    if (size <= 30) return 'medium';
    return 'large';
}

function confidence(score, bucket, count) {
    if (score >= 70 && bucket === 'small' && count > 0) return 'high';
    if (score >= 40 && count > 0) return 'medium';
    return 'low';
}

function freshnessSummary(days) {
    if (Number.isFinite(days)) return { label: `${days} days since intermediary contact`, daysSinceContact: days, stale: days > 30 };
    return { label: 'freshness unknown for intermediary', daysSinceContact: null, stale: false };
}

function safeDays(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

module.exports = { buildAgentIntroPaths };
