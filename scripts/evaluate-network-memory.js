#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { loadData } = require('./agent-query');
const { queryNetwork } = require('../crm/agent-retrieval');
const { evaluateRelationshipQueries } = require('../crm/evaluation');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'agent-workflows.json');

function loadDefaultCases() {
    const all = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    return Object.freeze(all.filter(c => c.target === 'query_network'));
}

const DEFAULT_CASES = loadDefaultCases();

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
