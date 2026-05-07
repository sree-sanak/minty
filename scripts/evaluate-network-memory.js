#!/usr/bin/env node

'use strict';

const fs = require('fs');
const { loadData } = require('./agent-query');
const { queryNetwork } = require('../crm/agent-retrieval');
const { evaluateRelationshipQueries } = require('../crm/evaluation');

const DEFAULT_CASES = Object.freeze([
    {
        query: 'Who do I know for crypto insurance?',
        minResults: 1,
        requireEvidenceKinds: ['keyword', 'topic'],
        disallowFallback: true,
        requirePaths: ['safety.readOnly', 'results.0.evidenceBacked'],
        forbidPaths: ['results.0.email', 'results.0.phone'],
        forbidSubstrings: ['raw-phone-555-0101'],
    },
    {
        query: 'Who do I know for EU crypto insurance?',
        minResults: 1,
        requireEvidenceKinds: ['keyword', 'topic'],
        disallowFallback: true,
        requirePaths: ['safety.readOnly', 'results.0.evidenceBacked'],
        forbidPaths: ['results.0.email', 'results.0.phone'],
        forbidSubstrings: ['raw-phone-555-0101'],
    },
    { query: 'Who do I know for impossible private codename zzqv?', maxResults: 0, disallowFallback: true },
]);

function parseArgs(argv) {
    const out = { dataDir: process.env.CRM_DATA_DIR || './data-demo', casesPath: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--data-dir') out.dataDir = argv[++i];
        else if (argv[i] === '--cases') out.casesPath = argv[++i];
    }
    return out;
}

function readCases(file) {
    if (!file) return DEFAULT_CASES;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('cases file must contain an array');
    return parsed;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = loadData(args.dataDir);
    const cases = readCases(args.casesPath);
    const report = evaluateRelationshipQueries(cases, (query) => queryNetwork(query, { ...data, limit: 10 }));
    console.log(JSON.stringify({ dataDir: args.dataDir, ...report }, null, 2));
    process.exitCode = report.failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { DEFAULT_CASES, parseArgs };
