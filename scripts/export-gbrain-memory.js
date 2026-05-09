#!/usr/bin/env node

/**
 * scripts/export-gbrain-memory.js
 *
 * Export Minty relationship-memory envelopes for GBrain/private brain ingestion.
 * This is local, deterministic, source-backed, and privacy conservative:
 * direct emails, phone numbers, raw contact ids, group contacts, raw messages,
 * source handles, private paths, URLs, and arbitrary insight prose are never emitted.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataDir, loadData } = require('./agent-query');
const { warmthLabel } = require('../crm/agent-retrieval');
const { stripDirectContactDetails, agentSafetyEnvelope } = require('../crm/privacy-envelope');
const { canonicalSafeSource, safeContactRef, parseSafeTimestamp } = require('../crm/source-events');
const { extractAllowedTopics } = require('../crm/evidence-patches');

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function safeText(value, fallback = '') {
    const cleaned = stripDirectContactDetails(text(value))
        .replace(/(?:https?|ftp|file):\/\/\S+/gi, '')
        .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|token|secret|credential|session|cookie)[_-]?(?:path|file)?\s*[:=]\s*\S+/gi, '')
        .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/root\/|\/tmp\/|\.\/|\.\.\/)[^\s]+/g, ' ')
        .replace(/(^|\s)@[A-Za-z0-9_.-]{2,}/g, ' ')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}

function uniq(values) {
    return [...new Set(values.map(v => safeText(v)).filter(Boolean))];
}

function safeTopics(values, limit = 20) {
    const out = [];
    for (const value of values.flat()) {
        for (const topic of extractAllowedTopics(value)) {
            if (!out.includes(topic)) out.push(topic);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

function safeSourceNames(contact) {
    const names = Object.keys((contact && contact.sources) || {})
        .map(canonicalSafeSource)
        .filter(Boolean)
        .sort();
    return [...new Set(names)];
}

function safeCitationRef(contactRef, kind, index) {
    return `${contactRef}:gbrain:${kind}:${index}`;
}

function linkedinSource(contact) {
    return contact && contact.sources && contact.sources.linkedin ? contact.sources.linkedin : {};
}

function googleSource(contact) {
    return contact && contact.sources && contact.sources.googleContacts ? contact.sources.googleContacts : {};
}

function contactTitle(contact) {
    const li = linkedinSource(contact);
    const gc = googleSource(contact);
    return safeText(contact.title) || safeText(li.position) || safeText(gc.title) || null;
}

function contactCompany(contact) {
    const li = linkedinSource(contact);
    const gc = googleSource(contact);
    return safeText(contact.company) || safeText(li.company) || safeText(gc.org) || null;
}

function contactLocation(contact) {
    const li = linkedinSource(contact);
    return safeText(contact.city) || safeText(contact.location) || safeText(li.location) || null;
}

function buildRelationshipMemoryEnvelope(contact, insights = {}) {
    if (!contact || contact.isGroup === true) return null;

    const contactRef = safeContactRef(contact.id);
    const contactInsights = (insights && (insights[contact.id] || insights[contactRef])) || {};
    const title = contactTitle(contact);
    const company = contactCompany(contact);
    const location = contactLocation(contact);
    const sources = safeSourceNames(contact);
    const latestAt = parseSafeTimestamp(contact.lastSyncedAt || contact.updatedAt || contact.lastContactedAt);
    const topics = safeTopics([
        ...(Array.isArray(contact.tags) ? contact.tags : []),
        ...(Array.isArray(contactInsights.keywords) ? contactInsights.keywords : []),
        ...(Array.isArray(contactInsights.topics) ? contactInsights.topics : []),
        title,
        company,
        location,
    ]);

    const evidence = [];
    sources.forEach((source, index) => {
        evidence.push({
            citationRef: safeCitationRef(contactRef, 'source', index),
            kind: 'source_presence',
            source,
            label: safeText(`Present in ${source} source data`),
            detail: source === 'googlecontacts'
                ? safeText('Synced from Google Contacts metadata; direct contact details omitted.')
                : safeText('Derived from local Minty source data; direct contact details omitted.'),
            latestAt,
            count: 1,
        });
    });

    [
        ['role', 'Role/title evidence', title],
        ['company', 'Company evidence', company],
        ['location', 'Location evidence', location],
    ].forEach(([kind, label, detail], index) => {
        if (!detail) return;
        evidence.push({
            citationRef: safeCitationRef(contactRef, kind, index),
            kind,
            source: 'minty',
            label: safeText(label),
            detail: safeText(detail),
            latestAt,
            count: 1,
        });
    });

    topics.slice(0, 8).forEach((topic, index) => {
        evidence.push({
            citationRef: safeCitationRef(contactRef, 'topic', index),
            kind: 'topic',
            source: 'minty',
            label: safeText('Allowed topic evidence'),
            detail: safeText(topic),
            latestAt,
            count: 1,
        });
    });

    const confidence = evidence.length >= 4 && sources.length > 0 ? 'medium' : 'low';
    return {
        type: 'relationship_memory',
        schemaVersion: 2,
        contactRef,
        person: safeText(contact.name || contact.displayName, 'Unknown person'),
        headline: [title, company].filter(Boolean).join(' at ') || title || company || null,
        title,
        company,
        location,
        topics,
        relationship: {
            score: contact.relationshipScore || 0,
            warmth: warmthLabel(contact.relationshipScore || 0),
            interactionCount: contact.interactionCount || 0,
            daysSinceContact: contact.daysSinceContact ?? null,
            activeChannels: Array.isArray(contact.activeChannels)
                ? [...new Set(contact.activeChannels.map(canonicalSafeSource).filter(Boolean))].sort()
                : [],
        },
        evidence,
        sourceMetadata: {
            sources,
            latestAt,
            profileSourceCount: sources.length,
            evidenceCount: evidence.length,
            confidence,
            freshness: latestAt ? 'source_synced' : 'unknown',
        },
        safety: {
            ...agentSafetyEnvelope({ omittedFields: ['messageBodies', 'groupNames', 'groupIds', 'sourceHandles', 'privatePaths', 'rawInsightText'] }),
            readOnly: true,
            noLlmCalls: true,
            contactIdsOmitted: true,
            directContactDetailsOmitted: true,
            rawMessagesOmitted: true,
            rawInsightTextOmitted: true,
            noOutreachTriggered: true,
            safeToUseInAgentContext: true,
        },
    };
}

function envelopeToMarkdown(envelope) {
    const lines = [];
    lines.push(`## ${safeText(envelope.person, 'Unknown person')}`);
    lines.push(`- Contact ref: ${safeText(envelope.contactRef, 'unknown')}`);
    if (envelope.headline) lines.push(`- Headline: ${safeText(envelope.headline)}`);
    if (envelope.location) lines.push(`- Location: ${safeText(envelope.location)}`);
    lines.push(`- Relationship: ${safeText(envelope.relationship.warmth)}, score ${Number(envelope.relationship.score) || 0}`);
    lines.push(`- Sources: ${envelope.sourceMetadata.sources.map(safeText).filter(Boolean).join(', ') || 'unknown'}`);
    lines.push(`- Confidence: ${safeText(envelope.sourceMetadata.confidence || 'low')}`);
    if (envelope.sourceMetadata.latestAt) lines.push(`- Latest safe timestamp: ${safeText(envelope.sourceMetadata.latestAt)}`);
    if (envelope.topics.length) lines.push(`- Topics: ${uniq(envelope.topics).join(', ')}`);
    lines.push('- Safety: direct contact details, contact ids, raw messages, and raw insight text omitted; read-only relationship memory.');
    if (envelope.evidence.length) {
        lines.push('- Evidence:');
        for (const e of envelope.evidence.slice(0, 12)) {
            const citation = e.citationRef ? ` (citation: ${safeText(e.citationRef)})` : '';
            const label = safeText(e.label, 'Evidence');
            const detail = safeText(e.detail);
            lines.push(`  - ${label}${detail ? `: ${detail}` : ''}${citation}`);
        }
    }
    return lines.join('\n');
}

function buildMarkdownDocument(envelopes, generatedAt = new Date().toISOString()) {
    const lines = [
        '---',
        'title: Minty Relationship Memory Export',
        `generated_at: ${generatedAt}`,
        'privacy: private',
        'source: minty',
        'tags: [minty, relationship-memory, gbrain]',
        '---',
        '',
        '# Minty Relationship Memory Export',
        '',
        'Private local export for GBrain/Hermes ingestion. Direct contact details, raw contact ids, raw messages, source handles, group contacts, private paths, URLs, and arbitrary insight prose are intentionally omitted.',
        '',
    ];
    for (const envelope of envelopes) {
        lines.push(envelopeToMarkdown(envelope), '');
    }
    return lines.join('\n');
}

function exportGbrainMemory(opts = {}) {
    const rootDir = opts.rootDir || path.join(__dirname, '..');
    const dataDir = opts.dataDir || resolveDataDir(rootDir);
    if (!dataDir) throw new Error('No Minty contacts found. Run npm run google-contacts:hermes && npm run merge first.');

    const { contacts, insights } = loadData(dataDir);
    const sourceContacts = Array.isArray(contacts) ? contacts : [];
    const exportableContacts = sourceContacts.filter(c => c && c.isGroup !== true && safeText(c.name || c.displayName, ''));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : exportableContacts.length;
    const envelopes = exportableContacts
        .slice(0, limit)
        .map(c => buildRelationshipMemoryEnvelope(c, insights))
        .filter(Boolean);

    const outDir = opts.outDir || path.join(dataDir, 'gbrain');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonlPath = path.join(outDir, 'relationship-memory.jsonl');
    const markdownPath = path.join(outDir, 'relationship-memory.md');
    fs.writeFileSync(jsonlPath, envelopes.map(e => JSON.stringify(e)).join('\n') + (envelopes.length ? '\n' : ''));
    fs.writeFileSync(markdownPath, buildMarkdownDocument(envelopes));

    return { dataDir, outDir, jsonlPath, markdownPath, count: envelopes.length };
}

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--out-dir') opts.outDir = path.resolve(argv[++i]);
        else if (arg === '--data-dir') opts.dataDir = path.resolve(argv[++i]);
        else if (arg === '--limit') opts.limit = Number.parseInt(argv[++i], 10);
        else if (arg === '--help' || arg === '-h') opts.help = true;
    }
    return opts;
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/export-gbrain-memory.js [--data-dir ./data] [--out-dir ./data/gbrain] [--limit N]');
        process.exit(0);
    }
    try {
        const result = exportGbrainMemory(opts);
        console.log(`Exported ${result.count} relationship-memory envelopes`);
        console.log(`JSONL: ${result.jsonlPath}`);
        console.log(`Markdown: ${result.markdownPath}`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    buildMarkdownDocument,
    buildRelationshipMemoryEnvelope,
    envelopeToMarkdown,
    exportGbrainMemory,
    parseArgs,
};
