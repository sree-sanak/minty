'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    buildMarkdownDocument,
    buildRelationshipMemoryEnvelope,
    exportGbrainMemory,
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
