#!/usr/bin/env node

/**
 * scripts/agent-query.js — CLI for agent-facing network retrieval.
 *
 * Usage:
 *   node scripts/agent-query.js "Who can help me with EU crypto insurance?"
 *   CRM_DATA_DIR=./data-demo node scripts/agent-query.js "investors in London"
 *   npm run agent -- "founders in SF"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { queryNetwork } = require('../crm/agent-retrieval');

/**
 * Resolve the CRM data directory:
 *  1. CRM_DATA_DIR env var wins if set.
 *  2. ./data if it has unified contacts.
 *  3. ./data-demo as fallback if it has unified contacts.
 *  4. null if neither has contacts.
 */
function resolveDataDir(rootDir) {
    if (process.env.CRM_DATA_DIR) return path.resolve(process.env.CRM_DATA_DIR);

    const root = rootDir || path.join(__dirname, '..');
    const primary = path.join(root, 'data');
    const demo = path.join(root, 'data-demo');

    if (hasContacts(primary)) return primary;
    if (hasContacts(demo)) return demo;
    return null;
}

function hasContacts(dir) {
    const p = path.join(dir, 'unified', 'contacts.json');
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) && arr.length > 0;
    } catch {
        return false;
    }
}

/**
 * Load contacts and insights from a resolved data directory.
 * @param {string} dataDir - Path to data directory (contains unified/ subdir)
 * @returns {{ contacts: object[], insights: object, interactions: object[] }}
 */
function loadData(dataDir) {
    function loadJson(file) {
        const fallback = file === 'insights.json' ? {} : [];
        const p = path.join(dataDir, 'unified', file);
        if (!fs.existsSync(p)) return fallback;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
            return fallback;
        }
    }
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        interactions: loadJson('interactions.json'),
    };
}

// Export helpers for testing and MCP server reuse
module.exports = { resolveDataDir, hasContacts, loadData };

if (require.main === module) {
    const query = process.argv.slice(2).join(' ').trim();

    if (!query) {
        console.error('Usage: node scripts/agent-query.js "<natural language query>"');
        process.exit(1);
    }

    const dataDir = resolveDataDir();

    if (!dataDir) {
        console.error('No contacts found in ./data or ./data-demo.');
        console.error('Run "npm run seed:demo" first, or set CRM_DATA_DIR.');
        process.exit(1);
    }

    const { contacts, insights, interactions } = loadData(dataDir);

    const result = queryNetwork(query, { contacts, insights, interactions, limit: 10 });

    // Pretty-print for terminal, machine-readable JSON on stdout
    if (process.stdout.isTTY) {
        console.log(`\nQuery:  ${result.query}`);
        console.log(`Intent: ${result.intent}`);
        console.log(`Found:  ${result.results.length} result(s)\n`);
        for (const [i, r] of result.results.entries()) {
            const warmthIcon = { strong: '++++', warm: '+++', cool: '++', cold: '+' }[r.warmth] || '';
            console.log(`  ${i + 1}. ${r.name}${r.title ? ' — ' + r.title : ''}`);
            if (r.company) console.log(`     Company: ${r.company}`);
            console.log(`     Warmth: ${r.warmth} ${warmthIcon}  |  Score: ${r.relationshipScore}  |  Confidence: ${r.confidence}`);
            if (r.evidence.length) {
                console.log(`     Evidence: ${r.evidence.map(e => e.label + (e.detail ? ' (' + e.detail + ')' : '')).join(', ')}`);
            }
            console.log(`     Action: ${r.suggestedAction}`);
            console.log();
        }
    } else {
        // Pipe / redirect: emit clean JSON
        console.log(JSON.stringify(result, null, 2));
    }
}
