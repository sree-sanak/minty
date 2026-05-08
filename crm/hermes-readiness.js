'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TOOLS } = require('../scripts/minty-mcp-server');

// Files that constitute a fully-ready Hermes data set
const REQUIRED_FILES = [
    { key: 'contacts', file: 'contacts.json', label: 'Unified contacts' },
    { key: 'interactions', file: 'interactions.json', label: 'Interactions' },
    { key: 'contactEvidence', file: 'contact-evidence.json', label: 'Contact evidence' },
    { key: 'hybridIndex', file: 'hybrid-index.json', label: 'Hybrid search index' },
];

function redactPath(p) {
    if (!p) return '(none)';
    const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
    const basename = segments.at(-1) || '(none)';
    return basename === '(none)' ? basename : `…/${basename}`;
}

function checkFile(dir, spec) {
    const full = path.join(dir, 'unified', spec.file);
    let exists = false;
    let count = null;
    try {
        const raw = fs.readFileSync(full, 'utf8');
        const parsed = JSON.parse(raw);
        exists = true;
        if (Array.isArray(parsed)) count = parsed.length;
        else if (parsed && typeof parsed === 'object') count = Object.keys(parsed).length;
    } catch {
        // file missing or unreadable
    }
    const status = exists ? (count > 0 ? 'pass' : 'warn') : 'fail';
    const detail = !exists
        ? `${spec.label} not found`
        : count === 0
            ? `${spec.label} exists but is empty`
            : `${spec.label}: ${count} entries`;
    return { name: spec.key, status, detail };
}

/**
 * Evaluate Hermes readiness against a data directory.
 *
 * Pure function — reads files but never writes, never loads contacts into
 * memory beyond counting, never exposes PII.
 *
 * @param {{ dataDir: string|null, dataKind?: string }} opts
 * @returns {{ level, checks, toolNames, dataDir, dataKind, nextActions }}
 */
function evaluateReadiness(opts = {}) {
    const { dataDir, dataKind: kindOverride } = opts;
    const toolNames = TOOLS.map(t => t.name);

    // No data directory at all
    if (!dataDir) {
        return {
            level: 'not-ready',
            checks: [{ name: 'dataDir', status: 'fail', detail: 'No data directory found' }],
            toolNames,
            dataDir: '(none)',
            dataKind: kindOverride || 'none',
            nextActions: [
                'Import at least one source (npm run whatsapp, npm run email, etc.) then run npm run merge.',
            ],
        };
    }

    const dataKind = kindOverride || 'user';
    const checks = REQUIRED_FILES.map(spec => checkFile(dataDir, spec));

    const fails = checks.filter(c => c.status === 'fail');
    const passes = checks.filter(c => c.status === 'pass');

    let level;
    if (fails.length === REQUIRED_FILES.length) {
        level = 'not-ready';
    } else if (passes.length === REQUIRED_FILES.length) {
        level = 'ready';
    } else {
        level = 'partial';
    }

    const nextActions = [];
    if (fails.length > 0) {
        const missing = fails.map(f => f.name).join(', ');
        nextActions.push(`Missing data: ${missing}. Run npm run merge and npm run contact-evidence to rebuild.`);
    }

    return {
        level,
        checks,
        toolNames,
        dataDir: redactPath(dataDir),
        dataKind,
        nextActions,
    };
}

module.exports = { evaluateReadiness, redactPath };
