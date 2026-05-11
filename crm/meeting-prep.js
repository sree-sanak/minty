'use strict';

const crypto = require('node:crypto');

const SAFETY = Object.freeze({
    contactDetailsOmitted: true,
    readOnly: true,
    noLlmCalls: true,
    noOutreachTriggered: true,
});

class OpaqueRefUnavailableError extends Error {
    constructor() {
        super('opaque_ref_unavailable');
        this.code = 'opaque_ref_unavailable';
    }
}

function toMs(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    if (value !== value.trim()) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, millis = '000'] = match;
    const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis));
    if (!Number.isFinite(ms)) return null;
    const parsed = new Date(ms);
    if (
        parsed.getUTCFullYear() !== Number(year) ||
        parsed.getUTCMonth() !== Number(month) - 1 ||
        parsed.getUTCDate() !== Number(day) ||
        parsed.getUTCHours() !== Number(hour) ||
        parsed.getUTCMinutes() !== Number(minute) ||
        parsed.getUTCSeconds() !== Number(second) ||
        parsed.getUTCMilliseconds() !== Number(millis)
    ) return null;
    return ms;
}

function isoOrNull(value) {
    const ms = toMs(value);
    return ms == null ? null : new Date(ms).toISOString();
}

function generatedAtFor(now) {
    const ms = toMs(now);
    return new Date(ms == null ? Date.now() : ms).toISOString();
}

function safeStatus(value) {
    const status = String(value || '').toLowerCase();
    return ['ok', 'stale', 'error', 'missing', 'unknown'].includes(status) ? status : 'unknown';
}

function redactSensitiveString(value) {
    if (value == null) return value;
    return String(value)
        .replace(/(?:mailto:|tel:)\S+/gi, '[redacted-contact]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/https?:\/\/\S+/gi, '[redacted-url]')
        .replace(/\b(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/gi, '[redacted-url]')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
        .replace(/(^|[^\w])@[a-z0-9_.-]{2,}/gi, '$1[redacted-handle]')
        .replace(/\b(?:telegram|whatsapp|linkedin|slack|email|sms|googleContacts):[^\s,;)]*/gi, '[redacted-source-ref]')
        .replace(/(?:^|\s)(?:\.?\.?\/)?[^\s,;)]*(?:token|secret|credential|key)[^\s,;)]*\.(?:json|ya?ml|env|txt)/gi, ' [redacted-secret-path]')
        .replace(/(?:\/[^\s,;)]*){2,}|[A-Z]:\\[^\s,;)]*/g, '[redacted-path]');
}

function safeRef(prefix, value) {
    const secret = process.env.MINTY_REF_SECRET || process.env.MINTY_MCP_REF_SECRET;
    if (!secret) throw new OpaqueRefUnavailableError();
    const digest = crypto.createHmac('sha256', secret)
        .update(prefix)
        .update('\0')
        .update(String(value || ''))
        .digest('base64url')
        .slice(0, 24);
    return `${prefix}:${digest}`;
}

function locationType(value) {
    const text = String(value || '').toLowerCase();
    if (!text.trim()) return 'unknown';
    if (/zoom|meet|teams|http|video/.test(text)) return 'video';
    if (/phone|dial|tel:/.test(text)) return 'phone';
    return 'in_person';
}

function warmthLabel(score) {
    const n = Number(score) || 0;
    if (n >= 70) return 'strong';
    if (n >= 50) return 'warm';
    if (n >= 30) return 'cool';
    return 'cold';
}

function sanitizeSourceHealth(health, nowMs) {
    if (!health || typeof health !== 'object') {
        return { status: 'unknown', stale: true, lastSyncAt: null, evidenceBearing: false, answerable: false };
    }
    const status = safeStatus(health.status);
    const lastSyncAt = isoOrNull(health.lastSyncAt);
    const lastSyncMs = lastSyncAt ? Date.parse(lastSyncAt) : null;
    const staleByAge = !lastSyncMs || lastSyncMs > nowMs || (nowMs - lastSyncMs) > 72 * 60 * 60 * 1000;
    const stale = health.stale === true || status !== 'ok' || staleByAge;
    const evidenceBearing = health.evidenceBearing === true;
    return {
        status,
        stale,
        lastSyncAt,
        evidenceBearing,
        answerable: status === 'ok' && !stale && evidenceBearing && health.answerable !== false,
    };
}

function safetyEnvelope() {
    return { ...SAFETY };
}

function blockedEnvelope(status, reason, generatedAt, sourceHealth) {
    return {
        status,
        reason,
        generatedAt,
        dataFreshness: { generatedAt, sourceHealth },
        safety: safetyEnvelope(),
    };
}

function selectedMeetings(meetings, opts) {
    const nowMs = toMs(opts.now) ?? Date.now();
    const rawHorizon = Number(opts.horizonHours);
    const horizonHours = Number.isFinite(rawHorizon) ? Math.max(1, Math.min(168, rawHorizon)) : 48;
    const horizonMs = nowMs + horizonHours * 60 * 60 * 1000;
    return (Array.isArray(meetings) ? meetings : [])
        .filter(m => m && typeof m === 'object')
        .filter(m => toMs(m.startAt) != null)
        .filter(m => (toMs(m.endAt) ?? toMs(m.startAt)) >= nowMs && toMs(m.startAt) <= horizonMs)
        .sort((a, b) => toMs(a.startAt) - toMs(b.startAt));
}

function selectMeeting(meetings, opts = {}) {
    const candidates = selectedMeetings(meetings, opts);
    const person = String(opts.person || '').trim().toLowerCase();
    if (person) {
        return candidates.find(m => (Array.isArray(m.attendees) ? m.attendees : []).some(a => {
            const label = String((a && (a.name || a.displayName)) || '').toLowerCase();
            return label.includes(person);
        })) || null;
    }
    return candidates[0] || null;
}

function safeCitation(source, evidenceKind, label, seedParts, observedAt) {
    return {
        citationRef: safeRef('citation', seedParts.filter(Boolean).join('|')),
        source,
        evidenceKind,
        observedAt: isoOrNull(observedAt),
        label: redactSensitiveString(label),
    };
}

function safeAttendee(attendee, eventId) {
    const a = attendee && typeof attendee === 'object' ? attendee : {};
    const contactRef = a.contactId ? safeRef('contact', a.contactId) : null;
    const seed = [eventId, a.contactId, a.name || a.displayName];
    const citations = [];
    if (a.meetingBrief) citations.push(safeCitation('insights.meetingBrief', 'meeting_brief', 'Meeting brief available', [...seed, 'brief'], a.analyzedAt || a.updatedAt || a.lastInteractionAt));
    if (Array.isArray(a.topics) && a.topics.length) citations.push(safeCitation('insights.topics', 'topics', a.topics.slice(0, 3).join(', '), [...seed, 'topics'], a.analyzedAt || a.updatedAt || a.lastInteractionAt));
    if (Array.isArray(a.openLoops) && a.openLoops.length) citations.push(safeCitation('insights.openLoops', 'open_loops', a.openLoops.slice(0, 2).join('; '), [...seed, 'openLoops'], a.analyzedAt || a.updatedAt || a.lastInteractionAt));
    if (a.daysSinceContact != null) citations.push(safeCitation('contact.daysSinceContact', 'recency', `Last contact ${a.daysSinceContact}d ago`, [...seed, 'recency'], a.lastInteractionAt));

    return {
        contactRef,
        name: redactSensitiveString(a.name || a.displayName || 'Unknown attendee'),
        responseStatus: a.responseStatus ? redactSensitiveString(a.responseStatus) : null,
        relationshipScore: Number.isFinite(Number(a.relationshipScore)) ? Number(a.relationshipScore) : null,
        warmth: a.relationshipScore == null ? null : warmthLabel(a.relationshipScore),
        daysSinceContact: Number.isFinite(Number(a.daysSinceContact)) ? Number(a.daysSinceContact) : null,
        topics: Array.isArray(a.topics) ? a.topics.slice(0, 5).map(redactSensitiveString) : [],
        openLoops: Array.isArray(a.openLoops) ? a.openLoops.slice(0, 5).map(redactSensitiveString) : [],
        meetingBrief: a.meetingBrief ? redactSensitiveString(a.meetingBrief) : null,
        citations,
    };
}

function isUsableAttendee(attendee) {
    return attendee && typeof attendee === 'object' && attendee.self !== true && (attendee.name || attendee.displayName || attendee.contactId);
}

function buildMeetingPrep(meetings, opts = {}) {
    const generatedAt = generatedAtFor(opts.now);
    const nowMs = toMs(opts.now) ?? Date.now();
    const sourceHealth = sanitizeSourceHealth(opts.sourceHealth, nowMs);
    if (!sourceHealth.answerable) {
        return blockedEnvelope(
            'degraded',
            'Calendar source is not fresh, evidence-bearing, and answerable enough to prepare a meeting brief safely.',
            generatedAt,
            sourceHealth,
        );
    }

    try {
        const selected = selectMeeting(meetings, opts);
        if (!selected) {
            return {
                status: 'empty',
                reason: 'No upcoming meeting matched the request inside the selected horizon.',
                generatedAt,
                dataFreshness: {
                    generatedAt,
                    calendarLastSyncAt: isoOrNull(opts.calendarLastSyncAt),
                    calendarStatus: safeStatus(opts.calendarStatus),
                    sourceHealth,
                },
                safety: safetyEnvelope(),
            };
        }

        const attendees = (Array.isArray(selected.attendees) ? selected.attendees : [])
            .filter(isUsableAttendee)
            .map(a => safeAttendee(a, selected.id));
        const strongest = attendees.slice().sort((a, b) => (b.relationshipScore || 0) - (a.relationshipScore || 0))[0] || null;
        return {
            status: 'ok',
            meeting: {
                eventRef: safeRef('calendar-event', selected.id),
                title: redactSensitiveString(selected.title || '(No title)'),
                startAt: isoOrNull(selected.startAt),
                endAt: isoOrNull(selected.endAt),
                locationType: locationType(selected.location),
            },
            summary: strongest
                ? redactSensitiveString(`Prep for ${strongest.name} — ${strongest.meetingBrief || strongest.citations[0]?.label || 'review relationship context before the meeting'}.`)
                : 'No matched Minty contacts found for this meeting yet.',
            attendees,
            dataFreshness: {
                generatedAt,
                calendarLastSyncAt: isoOrNull(opts.calendarLastSyncAt),
                calendarStatus: safeStatus(opts.calendarStatus),
                sourceHealth,
            },
            safety: {
                ...safetyEnvelope(),
                omittedFields: ['emails', 'phones', 'urls', 'rawLocation', 'rawContact', 'rawContactId', 'rawCalendarEventId', 'rawAttendee', 'description'],
            },
        };
    } catch (err) {
        if (err && err.code === 'opaque_ref_unavailable') {
            return blockedEnvelope(
                'error',
                'opaque_ref_unavailable: meeting prep cannot safely return private calendar context without a configured ref secret.',
                generatedAt,
                sourceHealth,
            );
        }
        throw err;
    }
}

module.exports = {
    buildMeetingPrep,
    locationType,
    redactSensitiveString,
    safeRef,
    selectMeeting,
    sanitizeSourceHealth,
    warmthLabel,
    OpaqueRefUnavailableError,
};
