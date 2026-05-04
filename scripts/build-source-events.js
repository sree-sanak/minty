#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { buildSourceEvents } = require('../crm/source-events');

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
    const sourceEvents = buildSourceEvents({ contacts, interactions, insights });
    const outputPath = path.join(unified, 'source-events.json');
    if (!args.dryRun) {
        fs.mkdirSync(unified, { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(sourceEvents, null, 2) + '\n');
    }
    const bySource = Object.create(null);
    for (const e of sourceEvents) bySource[e.source] = (bySource[e.source] || 0) + 1;
    console.log(JSON.stringify({
        dataDir,
        outputPath,
        dryRun: !!args.dryRun,
        contactsRead: Array.isArray(contacts) ? contacts.length : 0,
        interactionsRead: Array.isArray(interactions) ? interactions.length : 0,
        insightKeysRead: insights && typeof insights === 'object' ? Object.keys(insights).length : 0,
        sourceEvents: sourceEvents.length,
        sources: Object.keys(bySource).sort(),
    }, null, 2));
}

if (require.main === module) main();

module.exports = { parseArgs };
