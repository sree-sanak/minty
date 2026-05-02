'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildMarkdownDocument,
    buildRelationshipMemoryEnvelope,
    envelopeToMarkdown,
    exportGbrainMemory,
    parseArgs,
} = require('../../scripts/export-gbrain-memory');

const CONTACT = {
    id: 'c_ada',
    name: 'Ada Lovelace',
    relationshipScore: 72,
    interactionCount: 4,
    daysSinceContact: 12,
    activeChannels: ['email'],
    emails: ['ada@example.com'],
    phones: ['+15551234567'],
    sources: {
        googleContacts: { org: 'Analytical Engines Ltd', title: 'Founder' },
        linkedin: { company: 'Analytical Engines Ltd', position: 'Founder', location: 'London' },
    },
    lastSyncedAt: '2026-04-29T00:00:00Z',
};

const INSIGHTS = {
    c_ada: { topics: ['agent infra', 'open source AI'] },
};

test('buildRelationshipMemoryEnvelope: emits source-backed relationship memory without direct contact details', () => {
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, INSIGHTS);

    assert.equal(envelope.type, 'relationship_memory');
    assert.equal(envelope.person, 'Ada Lovelace');
    assert.equal(envelope.company, 'Analytical Engines Ltd');
    assert.equal(envelope.location, 'London');
    assert.deepEqual(envelope.sourceMetadata.sources, ['googleContacts', 'linkedin']);
    assert.equal(envelope.safety.directContactDetailsOmitted, true);
    assert.equal(envelope.safety.readOnly, true);
    assert.equal('emails' in envelope, false);
    assert.equal('phones' in envelope, false);
    assert.equal('rawContact' in envelope, false);

    const serialized = JSON.stringify(envelope);
    assert.equal(serialized.includes('ada@example.com'), false);
    assert.equal(serialized.includes('+15551234567'), false);
    assert.ok(serialized.includes('agent infra'));
});

test('buildRelationshipMemoryEnvelope: redacts email-like names and phone-like metadata', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        id: 'c_private',
        name: 'private@example.com',
        title: '+15551234567',
        company: 'Acme <secret@example.com>',
        location: '+442071234567',
    }, {});
    const serialized = JSON.stringify(envelope);

    assert.equal(envelope.person, 'Unknown person');
    assert.equal(serialized.includes('private@example.com'), false);
    assert.equal(serialized.includes('secret@example.com'), false);
    assert.equal(serialized.includes('+15551234567'), false);
    assert.equal(serialized.includes('+442071234567'), false);
});

test('buildMarkdownDocument: creates GBrain-ingestable private markdown', () => {
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, INSIGHTS);
    const markdown = buildMarkdownDocument([envelope], '2026-04-29T00:00:00Z');

    assert.match(markdown, /^---/);
    assert.match(markdown, /privacy: private/);
    assert.match(markdown, /# Minty Relationship Memory Export/);
    assert.match(markdown, /## Ada Lovelace/);
    assert.equal(markdown.includes('ada@example.com'), false);
    assert.equal(markdown.includes('+15551234567'), false);
});

// ---------------------------------------------------------------------------
// envelopeToMarkdown — characterization coverage of formatting logic
// ---------------------------------------------------------------------------

test('envelopeToMarkdown: renders all fields for a full envelope', () => {
    const envelope = buildRelationshipMemoryEnvelope(CONTACT, INSIGHTS);
    const md = envelopeToMarkdown(envelope);

    assert.match(md, /^## Ada Lovelace/);
    assert.match(md, /- Headline: Founder at Analytical Engines Ltd/);
    assert.match(md, /- Location: London/);
    assert.match(md, /- Relationship: strong, score 72/);
    assert.match(md, /- Sources: googleContacts, linkedin/);
    assert.match(md, /- Topics: /);
    assert.match(md, /- Safety: direct contact details omitted; read-only relationship memory\./);
    assert.match(md, /- Evidence:/);
});

test('envelopeToMarkdown: omits headline and location lines when absent', () => {
    const envelope = buildRelationshipMemoryEnvelope({
        ...CONTACT,
        id: 'c_minimal',
        name: 'Minimal Person',
        sources: {},
    }, {});
    const md = envelopeToMarkdown(envelope);

    assert.match(md, /^## Minimal Person/);
    assert.equal(md.includes('Headline:'), false, 'no headline line when null');
    assert.equal(md.includes('Location:'), false, 'no location line when null');
    assert.match(md, /- Sources: unknown/);
});

test('envelopeToMarkdown: truncates evidence to 12 items', () => {
    const evidence = Array.from({ length: 20 }, (_, i) => ({
        source: 'minty',
        label: `Evidence item ${i}`,
        detail: `Detail ${i}`,
    }));
    const envelope = {
        person: 'Test Person',
        headline: null,
        location: null,
        relationship: { warmth: 'warm', score: 50 },
        sourceMetadata: { sources: ['test'] },
        topics: [],
        evidence,
        safety: { directContactDetailsOmitted: true, readOnly: true },
    };
    const md = envelopeToMarkdown(envelope);
    const evidenceLines = md.split('\n').filter(l => l.startsWith('  - '));
    assert.equal(evidenceLines.length, 12, 'evidence truncated to 12');
    assert.ok(evidenceLines[0].includes('Evidence item 0'));
    assert.ok(evidenceLines[11].includes('Evidence item 11'));
});

test('envelopeToMarkdown: evidence label without detail omits colon suffix', () => {
    const envelope = {
        person: 'No Detail',
        headline: null,
        location: null,
        relationship: { warmth: 'cold', score: 10 },
        sourceMetadata: { sources: [] },
        topics: [],
        evidence: [{ source: 'minty', label: 'Bare label' }],
        safety: { directContactDetailsOmitted: true, readOnly: true },
    };
    const md = envelopeToMarkdown(envelope);
    assert.match(md, /  - Bare label$/m);
    // Ensure no trailing colon or "undefined"
    assert.equal(md.includes('Bare label:'), false);
    assert.equal(md.includes('undefined'), false);
});

test('envelopeToMarkdown: no evidence section when evidence array is empty', () => {
    const envelope = {
        person: 'Ghost',
        headline: null,
        location: null,
        relationship: { warmth: 'cold', score: 0 },
        sourceMetadata: { sources: [] },
        topics: [],
        evidence: [],
        safety: { directContactDetailsOmitted: true, readOnly: true },
    };
    const md = envelopeToMarkdown(envelope);
    assert.equal(md.includes('Evidence:'), false);
});

// ---------------------------------------------------------------------------
// parseArgs — characterization coverage of CLI argument parsing
// ---------------------------------------------------------------------------

test('parseArgs: parses --out-dir flag', () => {
    const opts = parseArgs(['--out-dir', '/tmp/out']);
    assert.equal(opts.outDir, path.resolve('/tmp/out'));
});

test('parseArgs: parses --data-dir flag', () => {
    const opts = parseArgs(['--data-dir', '/tmp/data']);
    assert.equal(opts.dataDir, path.resolve('/tmp/data'));
});

test('parseArgs: parses --limit as integer', () => {
    const opts = parseArgs(['--limit', '25']);
    assert.equal(opts.limit, 25);
});

test('parseArgs: parses --help flag', () => {
    const opts = parseArgs(['--help']);
    assert.equal(opts.help, true);
});

test('parseArgs: parses -h shorthand', () => {
    const opts = parseArgs(['-h']);
    assert.equal(opts.help, true);
});

test('parseArgs: parses multiple flags together', () => {
    const opts = parseArgs(['--data-dir', '/tmp/data', '--out-dir', '/tmp/out', '--limit', '10']);
    assert.equal(opts.dataDir, path.resolve('/tmp/data'));
    assert.equal(opts.outDir, path.resolve('/tmp/out'));
    assert.equal(opts.limit, 10);
});

test('parseArgs: returns empty object for no arguments', () => {
    const opts = parseArgs([]);
    assert.deepEqual(opts, {});
});

test('parseArgs: --limit NaN produces NaN (caller validates)', () => {
    const opts = parseArgs(['--limit', 'abc']);
    assert.ok(Number.isNaN(opts.limit));
});

// ---------------------------------------------------------------------------
// exportGbrainMemory — integration test
// ---------------------------------------------------------------------------

test('exportGbrainMemory: writes JSONL and Markdown under selected output directory', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-gbrain-export-'));
    try {
        const dataDir = path.join(tmp, 'data');
        const unified = path.join(dataDir, 'unified');
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(path.join(unified, 'contacts.json'), JSON.stringify([CONTACT]));
        fs.writeFileSync(path.join(unified, 'insights.json'), JSON.stringify(INSIGHTS));

        const result = exportGbrainMemory({ dataDir, outDir: path.join(tmp, 'out') });
        assert.equal(result.count, 1);
        assert.ok(fs.existsSync(result.jsonlPath));
        assert.ok(fs.existsSync(result.markdownPath));

        const jsonl = fs.readFileSync(result.jsonlPath, 'utf8');
        const markdown = fs.readFileSync(result.markdownPath, 'utf8');
        assert.equal(jsonl.includes('ada@example.com'), false);
        assert.equal(markdown.includes('+15551234567'), false);
        assert.equal(JSON.parse(jsonl.trim()).person, 'Ada Lovelace');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
