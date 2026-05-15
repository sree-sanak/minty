#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { buildHybridIndex } = require('../crm/hybrid-index');
const { buildSourceEvents } = require('../crm/source-events');
const { applyEvidenceOverrides } = require('../crm/evidence-review');

function parseArgs(argv) {
    const out = { dataDir: process.env.CRM_DATA_DIR || './data' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--data-dir') out.dataDir = argv[++i];
        else if (argv[i] === '--dry-run') out.dryRun = true;
    }
    return out;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = args.dataDir;
    const unified = path.join(dataDir, 'unified');
    const contacts = readJson(path.join(unified, 'contacts.json'), []);
    const interactions = readJson(path.join(unified, 'interactions.json'), []);
    const insights = readJson(path.join(unified, 'insights.json'), {});
    const contactEvidence = readJson(path.join(unified, 'contact-evidence.json'), {});
    const evidenceOverrides = readJson(path.join(unified, 'evidence-overrides.json'), {});
    const sourceEvents = readJson(path.join(unified, 'source-events.json'), buildSourceEvents({ contacts, interactions, insights }));
    const filteredContactEvidence = applyEvidenceOverrides({ contactEvidence, overrides: evidenceOverrides });
    const hybridIndex = buildHybridIndex({ contacts, contactEvidence: filteredContactEvidence, sourceEvents });
    const outputPath = path.join(unified, 'hybrid-index.json');
    if (!args.dryRun) {
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(hybridIndex, null, 2) + '\n');
    }
    console.log(JSON.stringify({
        dataDir,
        outputPath,
        dryRun: !!args.dryRun,
        contactsRead: Array.isArray(contacts) ? contacts.length : 0,
        evidenceContacts: contactEvidence && typeof contactEvidence === 'object' ? Object.keys(contactEvidence).length : 0,
        sourceEvents: Array.isArray(sourceEvents) ? sourceEvents.length : 0,
        hybridIndexEntries: hybridIndex.length,
    }, null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs };
