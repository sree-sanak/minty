#!/usr/bin/env node
'use strict';

/**
 * scripts/hermes-doctor.js — Hermes readiness doctor CLI.
 *
 * Usage:
 *   node scripts/hermes-doctor.js            # human-readable output
 *   node scripts/hermes-doctor.js --json      # stable JSON for agents
 *   npm run hermes:doctor
 *   npm run hermes:doctor -- --json
 */

const { evaluateReadiness } = require('../crm/hermes-readiness');
const { resolveDataDir } = require('./agent-query');

const LEVEL_LABELS = {
    'ready':     '✓ Ready',
    'partial':   '⚠ Partial',
    'not-ready': '✗ Not ready',
};

function run() {
    const jsonFlag = process.argv.includes('--json');
    const dataDir = resolveDataDir();
    const isDemo = dataDir && dataDir.includes('data-demo');
    const result = evaluateReadiness({
        dataDir,
        dataKind: isDemo ? 'demo' : undefined,
    });

    if (jsonFlag) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
    }

    // Human output
    const label = LEVEL_LABELS[result.level] || result.level;
    console.log(`Hermes readiness: ${label}  (data: ${result.dataKind})`);
    console.log('');
    for (const c of result.checks) {
        const icon = c.status === 'pass' ? '  ✓' : c.status === 'warn' ? '  ⚠' : '  ✗';
        console.log(`${icon} ${c.detail}`);
    }
    if (result.toolNames.length) {
        console.log(`\nMCP tools: ${result.toolNames.join(', ')}`);
    }
    if (result.nextActions.length) {
        console.log('\nNext actions:');
        for (const a of result.nextActions) console.log(`  → ${a}`);
    }
}

run();
