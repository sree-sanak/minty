 'use strict';

const { rankContactsForGoal } = require('./utils');
const { findIntroPaths } = require('./people-graph');
const { agentSafetyEnvelope, redactDirectContactDetails } = require('./privacy-envelope');

function buildAgentGoalActions(data = {}, opts = {}) {
    const goals = Array.isArray(data.goals) ? data.goals.filter(isUsableGoal) : [];
    const contacts = Array.isArray(data.contacts) ? data.contacts.filter(isUsableContact) : [];
    const memberships = isPlainObject(data.groupMemberships) ? data.groupMemberships : {};
    const limit = clampLimit(opts.limit, 5);
    const selectedGoals = selectGoals(goals, opts.goal);

    const safety = { ...agentSafetyEnvelope(), noOutreachTriggered: true };
    if (!selectedGoals.length || !contacts.length) {
        return {
            status: 'empty',
            confidence: 'low',
            briefs: [],
            reason: selectedGoals.length ? 'No contacts available for goal actions.' : 'No active goal matched the request.',
            safety,
        };
    }

    const briefs = [];
    const contactById = new Map(contacts.map(c => [c.id, c]));

    selectedGoals.forEach((goal, goalIndex) => {
        const goalRef = `goal:${goalIndex + 1}`;
        for (const brief of pipelineFollowUps(goal, goalRef, contactById, opts.now)) briefs.push(brief);
        for (const brief of warmIntroActions(goal, goalRef, contacts, memberships)) briefs.push(brief);
        for (const brief of newAskActions(goal, goalRef, contacts)) briefs.push(brief);
    });

    const deduped = [];
    const seen = new Set();
    for (const brief of briefs.sort((a, b) => b.score - a.score)) {
        const key = `${brief.goalRef}:${brief.person?.name || brief.nextAction?.label}:${brief.nextAction?.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(brief);
        if (deduped.length >= limit) break;
    }

    return {
        status: deduped.length ? 'ok' : 'empty',
        confidence: deduped.length ? 'medium' : 'low',
        briefs: deduped,
        ...(deduped.length ? {} : { reason: 'No safe goal actions found.' }),
        safety,
    };
}

function isUsableGoal(goal) {
    return goal && typeof goal === 'object' && !Array.isArray(goal) && typeof goal.text === 'string' && goal.text.trim() && goal.active !== false;
}

function isUsableContact(contact) {
    return contact && typeof contact === 'object' && !Array.isArray(contact) && typeof contact.id === 'string' && typeof contact.name === 'string' && contact.name.trim() && !contact.isGroup && !contact.isChannel && !contact.isBroadcast;
}

function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function clampLimit(value, fallback) {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(50, Math.floor(n)));
}

function selectGoals(goals, query) {
    if (typeof query !== 'string' || !query.trim()) return goals;
    const terms = tokenize(query);
    return goals.filter(goal => {
        const text = goal.text.toLowerCase();
        return terms.every(term => text.includes(term));
    });
}

function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function pipelineFollowUps(goal, goalRef, contactById, nowValue) {
    if (!isPlainObject(goal.assignments)) return [];
    const now = parseTime(nowValue) || Date.now();
    const out = [];
    for (const [contactId, assignment] of Object.entries(goal.assignments)) {
        if (!isPlainObject(assignment)) continue;
        const contact = contactById.get(contactId);
        if (!contact) continue;
        const stage = safeShortString(assignment.stage) || 'active';
        const updatedAt = safeIso(assignment.updatedAt);
        const ageDays = updatedAt ? Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 86400000)) : null;
        const staleBoost = ageDays == null ? 0 : Math.min(30, ageDays);
        const score = 160 + staleBoost + Math.min(20, Number(contact.relationshipScore) || 0) / 5;
        out.push({
            goal: { text: redact(goal.text) },
            goalRef,
            person: safePerson(contact),
            score: Math.round(score),
            pipelineFollowUps: [{ stage, ageDays, updatedAt }],
            introPaths: [],
            nextAction: {
                type: 'pipeline_follow_up',
                label: `Follow up with ${displayName(contact)} on ${redact(goal.text)}`,
                reason: `Existing goal pipeline is in ${stage}${ageDays == null ? '' : ` and has not moved for ${ageDays} days`}.`,
            },
        });
    }
    return out;
}

function warmIntroActions(goal, goalRef, contacts, memberships) {
    const ranked = rankContactsForGoal(contacts, goal.text, 12);
    const out = [];
    for (const target of ranked) {
        if ((Number(target.relationshipScore) || 0) > 35) continue;
        const paths = findIntroPaths(target.id, contacts, memberships, { maxPaths: 1, maxGroupSize: 80 });
        if (!paths.length) continue;
        const top = paths[0];
        out.push({
            goal: { text: redact(goal.text) },
            goalRef,
            person: safePerson(target),
            score: Math.round(125 + top.pathScore + (target.goalRelevance || 0) / 2),
            pipelineFollowUps: [],
            introPaths: [{
                target: safePerson(target),
                intermediary: {
                    name: redact(top.intermediaryName),
                    ...(top.intermediaryTitle ? { title: redact(top.intermediaryTitle) } : {}),
                    ...(top.intermediaryCompany ? { company: redact(top.intermediaryCompany) } : {}),
                    warmth: warmthLabel(top.intermediaryScore),
                },
                sharedContext: 'shared private group membership',
            }],
            nextAction: {
                type: 'warm_intro_request',
                label: `Ask ${redact(top.intermediaryName)} for a warm intro to ${displayName(target)}`,
                reason: 'Target is goal-relevant but cold; a warmer mutual connection exists through local group evidence.',
            },
        });
    }
    return out;
}

function newAskActions(goal, goalRef, contacts) {
    return rankContactsForGoal(contacts, goal.text, 8).map(contact => ({
        goal: { text: redact(goal.text) },
        goalRef,
        person: safePerson(contact),
        score: Math.round(70 + (Number(contact.goalRelevance) || 0) / 2 + Math.min(20, Number(contact.relationshipScore) || 0) / 5),
        pipelineFollowUps: [],
        introPaths: [],
        nextAction: {
            type: 'new_ask',
            label: `Ask ${displayName(contact)} about ${redact(goal.text)}`,
            reason: 'Contact appears relevant to the active goal based on local profile evidence.',
        },
    }));
}

function safePerson(contact) {
    return {
        name: redact(contact.name),
        ...(contact.apollo?.headline ? { title: redact(contact.apollo.headline) } : contact.sources?.linkedin?.position ? { title: redact(contact.sources.linkedin.position) } : {}),
        ...(contact.sources?.linkedin?.company ? { company: redact(contact.sources.linkedin.company) } : {}),
        warmth: warmthLabel(contact.relationshipScore),
    };
}

function displayName(contact) {
    return redact(contact && contact.name);
}

function warmthLabel(score) {
    const n = Number(score) || 0;
    if (n >= 75) return 'strong';
    if (n >= 50) return 'warm';
    if (n >= 25) return 'light';
    return 'cold';
}

function safeShortString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    return redact(trimmed);
}

function safeIso(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/);
    if (!match) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const [, y, mo, d, h, mi, s, ms = '000'] = match;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    if (date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getUTCHours() !== Number(h) ||
        date.getUTCMinutes() !== Number(mi) ||
        date.getUTCSeconds() !== Number(s) ||
        date.getUTCMilliseconds() !== Number(ms)) {
        return null;
    }
    return value;
}

function parseTime(value) {
    if (typeof value === 'string') {
        const t = Date.parse(value);
        return Number.isNaN(t) ? null : t;
    }
    return null;
}

function redact(value) {
    return redactDirectContactDetails(String(value || ''));
}

module.exports = { buildAgentGoalActions };
