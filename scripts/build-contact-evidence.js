#!/usr/bin/env node
/**
 * Build privacy-safe per-contact evidence summaries from unified interactions.
 *
 * Input:  <dataDir>/unified/contacts.json + interactions.json
 * Output: <dataDir>/unified/contact-evidence.json
 *
 * This intentionally stores compact topic/source/count/freshness metadata only,
 * not raw message bodies or direct contact details.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildContactEvidence } = require('../crm/contact-evidence');
const { resolveDataDir } = require('./agent-query');

function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`Failed to parse ${file}: ${err.message}`);
    }
}

function parseArgs(argv) {
    const args = { dataDir: null, dryRun: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--data-dir') args.dataDir = argv[++i];
        else if (!args.dataDir) args.dataDir = arg;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    return args;
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const dataDir = args.dataDir || process.env.CRM_DATA_DIR || resolveDataDir();
    if (!dataDir) {
        throw new Error('No data directory found. Pass --data-dir, set CRM_DATA_DIR, or seed demo data.');
    }

    const unifiedDir = path.join(dataDir, 'unified');
    const contactsPath = path.join(unifiedDir, 'contacts.json');
    const interactionsPath = path.join(unifiedDir, 'interactions.json');
    const insightsPath = path.join(unifiedDir, 'insights.json');
    const outputPath = path.join(unifiedDir, 'contact-evidence.json');

    const contacts = readJson(contactsPath, []);
    const interactions = readJson(interactionsPath, []);
    const insights = readJson(insightsPath, {});
    const evidence = buildContactEvidence({ contacts, interactions, insights });
    const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;

    if (!args.dryRun) {
        fs.mkdirSync(unifiedDir, { recursive: true });
        fs.writeFileSync(outputPath, evidenceJson);
    }

    const contactCount = Object.keys(evidence).length;
    const sourceSet = new Set();
    for (const ev of Object.values(evidence)) {
        for (const source of ev.sources || []) sourceSet.add(source);
    }

    const summary = {
        dataDir,
        outputPath,
        dryRun: args.dryRun,
        contactsRead: Array.isArray(contacts) ? contacts.length : 0,
        interactionsRead: Array.isArray(interactions) ? interactions.length : 0,
        insightsRead: insights && typeof insights === 'object' ? Object.keys(insights).length : 0,
        evidenceContacts: contactCount,
        sources: [...sourceSet].sort(),
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = { main, parseArgs };
