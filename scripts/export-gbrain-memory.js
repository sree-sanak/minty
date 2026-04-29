#!/usr/bin/env node

/**
 * scripts/export-gbrain-memory.js
 *
 * Export Minty relationship-memory envelopes for GBrain/private brain ingestion.
 * This is local, deterministic, source-backed, and privacy conservative:
 * direct emails, phone numbers, and raw contact objects are never emitted.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveDataDir, loadData } = require('./agent-query');
const { warmthLabel } = require('../crm/agent-retrieval');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function safeText(value, fallback = '') {
    const cleaned = text(value)
        .replace(EMAIL_RE, '')
        .replace(PHONE_RE, '')
        .replace(/[<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || fallback;
}

function uniq(values) {
    return [...new Set(values.map(v => safeText(v)).filter(Boolean))];
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

function sourceNames(contact) {
    return Object.keys((contact && contact.sources) || {}).sort();
}

function buildRelationshipMemoryEnvelope(contact, insights = {}) {
    const contactInsights = insights[contact.id] || {};
    const title = contactTitle(contact);
    const company = contactCompany(contact);
    const location = contactLocation(contact);
    const topics = uniq([
        ...(Array.isArray(contact.tags) ? contact.tags : []),
        ...(Array.isArray(contactInsights.topics) ? contactInsights.topics : []),
        title,
        company,
        location,
    ]).slice(0, 20);

    const evidence = [];
    for (const source of sourceNames(contact)) {
        evidence.push({
            source,
            label: `Present in ${source} source data`,
            detail: source === 'googleContacts'
                ? 'Synced from Google Contacts metadata; direct contact details omitted.'
                : 'Derived from local Minty source data; direct contact details omitted.',
        });
    }
    if (title) evidence.push({ source: 'minty', label: 'Role/title evidence', detail: title });
    if (company) evidence.push({ source: 'minty', label: 'Company evidence', detail: company });
    if (location) evidence.push({ source: 'minty', label: 'Location evidence', detail: location });
    for (const topic of topics.slice(0, 8)) {
        evidence.push({ source: 'minty', label: 'Topic evidence', detail: topic });
    }

    return {
        type: 'relationship_memory',
        schemaVersion: 1,
        id: contact.id,
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
            activeChannels: Array.isArray(contact.activeChannels) ? contact.activeChannels : [],
        },
        evidence,
        sourceMetadata: {
            sources: sourceNames(contact),
            lastSyncedAt: contact.lastSyncedAt || contact.updatedAt || null,
            confidence: evidence.length >= 3 ? 'medium' : 'low',
            freshness: contact.lastSyncedAt ? 'source_synced' : 'unknown',
        },
        safety: {
            directContactDetailsOmitted: true,
            omittedFields: ['emails', 'phones', 'rawContact'],
            safeToUseInAgentContext: true,
            readOnly: true,
        },
    };
}

function envelopeToMarkdown(envelope) {
    const lines = [];
    lines.push(`## ${envelope.person}`);
    if (envelope.headline) lines.push(`- Headline: ${envelope.headline}`);
    if (envelope.location) lines.push(`- Location: ${envelope.location}`);
    lines.push(`- Relationship: ${envelope.relationship.warmth}, score ${envelope.relationship.score}`);
    lines.push(`- Sources: ${envelope.sourceMetadata.sources.join(', ') || 'unknown'}`);
    if (envelope.topics.length) lines.push(`- Topics: ${envelope.topics.join(', ')}`);
    lines.push('- Safety: direct contact details omitted; read-only relationship memory.');
    if (envelope.evidence.length) {
        lines.push('- Evidence:');
        for (const e of envelope.evidence.slice(0, 12)) {
            lines.push(`  - ${e.label}${e.detail ? `: ${e.detail}` : ''}`);
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
        'Private local export for GBrain/Hermes ingestion. Direct emails, phone numbers, and raw contact records are intentionally omitted.',
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
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : contacts.length;
    const envelopes = contacts
        .filter(c => c && safeText(c.name || c.displayName, ''))
        .slice(0, limit)
        .map(c => buildRelationshipMemoryEnvelope(c, insights));

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
