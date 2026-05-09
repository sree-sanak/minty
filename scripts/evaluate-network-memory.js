#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { loadData } = require('./agent-query');
const { queryNetwork } = require('../crm/agent-retrieval');
const { evaluateRelationshipQueries } = require('../crm/evaluation');
const { handleMessage } = require('./minty-mcp-server');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'agent-workflows.json');

function loadDefaultCases() {
    const all = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    return Object.freeze(validateCases(all));
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

function validateCasePrivacy(value, location = '$') {
    if (typeof value === 'string') {
        const exampleDomainEmail = /[A-Z0-9._%+-]+@example\.(?:com|test|org)\b/ig;
        const allowedSentinelPhone = /raw-phone-555-0\d{3}/g;
        const sanitized = value
            .replace(exampleDomainEmail, '[example-email]')
            .replace(allowedSentinelPhone, '[sentinel-phone]');
        if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(sanitized)) {
            throw new Error(`private-looking eval case value: email-like value at ${location}`);
        }
        const phoneCandidates = sanitized.match(/(?:\+?\d|\(\d{3}\))[\d\s().-]{7,}\d/g) || [];
        if (phoneCandidates.some(candidate => candidate.replace(/\D/g, '').length >= 10)) {
            throw new Error(`private-looking eval case value: phone-like value at ${location}`);
        }
        if (/\b(?:sk|pk|rk)-(?:live|test|proj|pat|key)-[A-Za-z0-9_-]{8,}\b/i.test(sanitized)) {
            throw new Error(`private-looking eval case value: token-like value at ${location}`);
        }
        if (/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{6,}/i.test(sanitized)) {
            throw new Error(`private-looking eval case value: secret-like value at ${location}`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, idx) => validateCasePrivacy(item, `${location}[${idx}]`));
        return;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            validateCasePrivacy(child, `${location}.${key}`);
        }
    }
}

function validateCases(cases) {
    if (!Array.isArray(cases)) throw new Error('cases file must contain an array');
    validateCasePrivacy(cases);
    return cases;
}

function readCases(file) {
    if (!file) return DEFAULT_CASES;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateCases(parsed);
}

function parseMcpToolEnvelope(resp) {
    const text = resp && resp.result && resp.result.content && resp.result.content[0] && resp.result.content[0].text;
    if (!text) return {};
    return JSON.parse(text);
}

function runAgentEvalCase(testCase, data) {
    if (typeof testCase === 'string') {
        return queryNetwork(testCase, { ...data, limit: 10 });
    }

    const target = testCase && testCase.target;
    const args = (testCase && testCase.arguments) || {};

    if (target === 'query_network') {
        const query = args.query || testCase.query || '';
        const opts = { ...data, limit: 10 };
        if (args.source) opts.source = args.source;
        if (args.sources) opts.sources = args.sources;
        return queryNetwork(query, opts);
    }

    if (typeof target === 'string' && target.startsWith('mcp:')) {
        const tool = target.slice('mcp:'.length);
        const resp = handleMessage({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: tool, arguments: args },
        }, data);
        return parseMcpToolEnvelope(resp);
    }

    throw new Error(`Unsupported eval target: ${target}`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const data = loadData(args.dataDir);
    const cases = readCases(args.casesPath);
    const report = evaluateRelationshipQueries(cases, (testCase) => runAgentEvalCase(testCase, data));
    console.log(JSON.stringify({ dataDir: args.dataDir, ...report }, null, 2));
    process.exitCode = report.failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { DEFAULT_CASES, parseArgs, readCases, runAgentEvalCase };
