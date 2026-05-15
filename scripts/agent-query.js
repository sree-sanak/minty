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
const { applyEvidenceOverrides, applyEvidenceOverridesToHybridIndex } = require('../crm/evidence-review');

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
 * @returns {{ contacts: object[], insights: object, interactions: object[], contactEvidence: object, sourceEvents?: object[], hybridIndex?: object[], syncState: object }}
 */
function loadData(dataDir) {
    function fallbackFor(file, missing = false) {
        if (file === 'insights.json' || file === 'contact-evidence.json' || file === 'evidence-overrides.json' || file === 'group-memberships.json') return {};
        if (missing && (file === 'source-events.json' || file === 'hybrid-index.json')) return undefined;
        return [];
    }
    function loadJson(file) {
        const p = path.join(dataDir, 'unified', file);
        if (!fs.existsSync(p)) return fallbackFor(file, true);
        try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (file === 'insights.json' || file === 'contact-evidence.json' || file === 'evidence-overrides.json' || file === 'group-memberships.json') {
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackFor(file, false);
            } else {
                if (!Array.isArray(parsed)) return fallbackFor(file, false);
            }
            return parsed;
        } catch {
            return fallbackFor(file, false);
        }
    }
    function sanitizeSyncState(parsed) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [source, state] of Object.entries(parsed)) {
            if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
            const row = {};
            for (const key of ['lastSyncAt', 'lastSyncedAt', 'updatedAt', 'lastSync', 'status']) {
                if (typeof state[key] === 'string' && state[key].length <= 128) row[key] = state[key];
            }
            if (source === 'calendar') {
                for (const key of ['stale', 'evidenceBearing', 'answerable']) {
                    if (typeof state[key] === 'boolean') row[key] = state[key];
                }
                for (const key of ['lastError', 'reason']) {
                    if (typeof state[key] === 'string' && state[key].length <= 256) row[key] = state[key];
                }
            }
            if (source === 'calendar' && Array.isArray(state.upcomingMeetings)) {
                row.upcomingMeetings = state.upcomingMeetings
                    .filter(m => m && typeof m === 'object' && !Array.isArray(m))
                    .slice(0, 50)
                    .map(m => ({
                        id: typeof m.id === 'string' ? m.id : null,
                        title: typeof m.title === 'string' ? m.title : null,
                        startAt: typeof m.startAt === 'string' ? m.startAt : null,
                        endAt: typeof m.endAt === 'string' ? m.endAt : null,
                        location: typeof m.location === 'string' ? m.location : null,
                        attendees: Array.isArray(m.attendees) ? m.attendees.slice(0, 25).map(a => ({
                            email: typeof a?.email === 'string' ? a.email : null,
                            displayName: typeof a?.displayName === 'string' ? a.displayName : null,
                            name: typeof a?.name === 'string' ? a.name : null,
                            contactId: typeof a?.contactId === 'string' ? a.contactId : null,
                            relationshipScore: Number.isFinite(Number(a?.relationshipScore)) ? Number(a.relationshipScore) : null,
                            daysSinceContact: Number.isFinite(Number(a?.daysSinceContact)) ? Number(a.daysSinceContact) : null,
                            topics: Array.isArray(a?.topics) ? a.topics.filter(t => typeof t === 'string').slice(0, 5) : [],
                            openLoops: Array.isArray(a?.openLoops) ? a.openLoops.filter(t => typeof t === 'string').slice(0, 5) : [],
                            meetingBrief: typeof a?.meetingBrief === 'string' ? a.meetingBrief : null,
                            responseStatus: typeof a?.responseStatus === 'string' ? a.responseStatus : null,
                            lastInteractionAt: typeof a?.lastInteractionAt === 'string' ? a.lastInteractionAt : null,
                            updatedAt: typeof a?.updatedAt === 'string' ? a.updatedAt : null,
                            analyzedAt: typeof a?.analyzedAt === 'string' ? a.analyzedAt : null,
                        })) : [],
                    }));
            }
            if (Object.keys(row).length) out[source] = row;
        }
        return out;
    }
    function loadRootSyncState(file) {
        const p = path.join(dataDir, file);
        if (!fs.existsSync(p)) return {};
        try {
            return sanitizeSyncState(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch {
            return {};
        }
    }
    const contactEvidence = loadJson('contact-evidence.json');
    const evidenceOverrides = loadJson('evidence-overrides.json');
    const filteredContactEvidence = applyEvidenceOverrides({ contactEvidence, overrides: evidenceOverrides });
    const hybridIndex = loadJson('hybrid-index.json');
    return {
        contacts: loadJson('contacts.json'),
        insights: loadJson('insights.json'),
        interactions: loadJson('interactions.json'),
        contactEvidence: filteredContactEvidence,
        sourceEvents: loadJson('source-events.json'),
        hybridIndex: Array.isArray(hybridIndex) ? applyEvidenceOverridesToHybridIndex({ index: hybridIndex, overrides: evidenceOverrides }) : hybridIndex,
        goals: loadJson('goals.json'),
        groupMemberships: loadJson('group-memberships.json'),
        syncState: loadRootSyncState('sync-state.json'),
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

    const { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, syncState } = loadData(dataDir);

    const result = queryNetwork(query, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, syncState, limit: 10 });

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
