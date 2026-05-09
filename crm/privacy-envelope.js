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

const ENVELOPE_DEFAULT_OMITTED_FIELDS = ['emails', 'phones', 'rawContact', 'sourceDerivedContactIds'];

// Privacy marker only: callers may extend omittedFields with safe field names,
// but arbitrary metadata is intentionally not passed through to avoid leaks.
function isSafeOmittedField(value) {
    return typeof value === 'string'
        && /^[A-Za-z_$][A-Za-z0-9_$.-]{0,80}$/.test(value)
        && !value.split('.').some(part => part === '__proto__' || part === 'prototype' || part === 'constructor');
}

function agentSafetyEnvelope(extra = {}) {
    const envelopeExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
    const extraOmitted = Array.isArray(envelopeExtra.omittedFields) ? envelopeExtra.omittedFields.filter(isSafeOmittedField) : [];
    return {
        contactDetailsOmitted: true,
        contactIdsOmitted: true,
        omittedFields: [...new Set([...ENVELOPE_DEFAULT_OMITTED_FIELDS, ...extraOmitted])],
        noLlmCalls: true,
        readOnly: true,
    };
}

function safeEvidenceDetail(reason = {}) {
    const kind = reason && reason.kind;
    if (kind === 'topic') return 'Topic match from precomputed insights';
    return redactDirectContactDetails(reason && reason.detail || '') || null;
}

module.exports = { redactDirectContactDetails, stripDirectContactDetails, agentSafetyEnvelope, safeEvidenceDetail };
