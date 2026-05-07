/**
 * crm/privacy-envelope.js — shared privacy helpers for agent-facing responses.
 *
 * Pure helpers. No file I/O, no LLM calls, no side effects.
 */

'use strict';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MASKED_PHONE_RE = /\+?\d[\d\s().-]*\*{2,}[\d\s().-]*\d/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

function redactDirectContactDetails(value) {
    if (value == null) return value;
    if (typeof value !== 'string') return value;
    return value
        .replace(EMAIL_RE, '[redacted email]')
        .replace(MASKED_PHONE_RE, '[redacted phone]')
        .replace(PHONE_RE, match => isPhoneLike(match) ? '[redacted phone]' : match);
}

function stripDirectContactDetails(value) {
    if (value == null) return value;
    if (typeof value !== 'string') return value;
    return value
        .replace(EMAIL_RE, ' ')
        .replace(MASKED_PHONE_RE, ' ')
        .replace(PHONE_RE, match => isPhoneLike(match) ? ' ' : match)
        .replace(/\s+/g, ' ')
        .trim();
}

function isPhoneLike(value) {
    const text = String(value || '').trim();
    const digits = text.replace(/\D/g, '');
    return digits.length >= 10 || (text.startsWith('+') && digits.length >= 8);
}

function agentSafetyEnvelope(extra = {}) {
    const defaults = ['emails', 'phones', 'rawContact', 'sourceDerivedContactIds'];
    const extraOmitted = Array.isArray(extra.omittedFields) ? extra.omittedFields : [];
    return {
        ...extra,
        contactDetailsOmitted: true,
        contactIdsOmitted: true,
        omittedFields: [...new Set([...defaults, ...extraOmitted])],
        noLlmCalls: true,
        readOnly: true,
    };
}

module.exports = { redactDirectContactDetails, stripDirectContactDetails, agentSafetyEnvelope };
