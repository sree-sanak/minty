'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TOOLS } = require('../scripts/minty-mcp-server');

// Files that constitute a fully-ready Hermes data set
const REQUIRED_FILES = [
    { key: 'contacts', file: 'contacts.json', label: 'Unified contacts' },
    { key: 'interactions', file: 'interactions.json', label: 'Interactions' },
    { key: 'contactEvidence', file: 'contact-evidence.json', label: 'Contact evidence' },
    { key: 'hybridIndex', file: 'hybrid-index.json', label: 'Hybrid search index' },
];

// Repo skill relative to repo root
const REPO_SKILL_PATH = path.join(__dirname, '..', 'hermes', 'minty-network-memory', 'SKILL.md');

// Hermes-home-installed skill path (only accessible paths are used; no secrets read)
const INSTALLED_SKILL_DIR = path.join(os.homedir(), '.hermes', 'skills', 'minty-network-memory');
const INSTALLED_SKILL_PATH = path.join(INSTALLED_SKILL_DIR, 'SKILL.md');

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
 * Extract MCP tool names mentioned in a skill markdown as `### tool_name` headings.
 * Returns the set of tool names found.
 * @param {string} content
 * @returns {Set<string>}
 */
function extractSkillTools(content) {
    const tools = new Set();
    // Match ### tool_name  (backtick-optional, whitespace after)
    const re = /^###\s+`?([a-z_]+)`?\s*$/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
        tools.add(m[1]);
    }
    return tools;
}

/**
 * Check whether the installed Hermes Minty skill is stale vs the repo copy.
 *
 * Reads the repo skill and the installed skill (when present), extracts
 * tool-name headings from each, and warns if the installed skill is missing
 * tools the repo exposes.
 *
 * Does NOT read private paths, tokens, or contact data.
 * Returns a privacy-safe check object with no raw content.
 *
 * @returns {{ name: string, status: string, detail: string }}
 */
function checkSkillDrift(opts = {}) {
    const repoSkillPath = opts.repoSkillPath || REPO_SKILL_PATH;
    const installedSkillPath = opts.installedSkillPath || INSTALLED_SKILL_PATH;
    const repoExists = fs.existsSync(repoSkillPath);
    if (!repoExists) {
        return { name: 'skill_drift', status: 'warn', detail: 'Repo skill not found — cannot check drift' };
    }

    let repoContent;
    try {
        repoContent = fs.readFileSync(repoSkillPath, 'utf8');
    } catch {
        return { name: 'skill_drift', status: 'warn', detail: 'Repo skill unreadable' };
    }

    const repoTools = extractSkillTools(repoContent);
    const installedExists = fs.existsSync(installedSkillPath);

    if (!installedExists) {
        return {
            name: 'skill_drift',
            status: 'warn',
            detail: 'Installed skill not present. Update: hermes skills install minty-network-memory',
        };
    }

    let installedContent;
    try {
        installedContent = fs.readFileSync(installedSkillPath, 'utf8');
    } catch {
        return { name: 'skill_drift', status: 'warn', detail: 'Installed skill unreadable' };
    }

    const installedTools = extractSkillTools(installedContent);

    // Check: does the repo expose tools the installed skill doesn't mention?
    const missingInInstalled = [...repoTools].filter(t => !installedTools.has(t));

    if (missingInInstalled.length === 0) {
        return {
            name: 'skill_drift',
            status: 'pass',
            detail: `Installed skill in sync (${installedTools.size} tools)`,
        };
    }

    const updateCmd = 'hermes skills install minty-network-memory  # or: hermes skills sync';
    return {
        name: 'skill_drift',
        status: 'warn',
        detail: `Installed skill missing ${missingInInstalled.length} tool(s): ${missingInInstalled.join(', ')}. Update: ${updateCmd}`,
    };
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
    const { dataDir, dataKind: kindOverride, skillDrift: skillDriftOptions = {} } = opts;
    const toolNames = TOOLS.map(t => t.name);

    const baseReadiness = { demo: false, dogfood: false, hermesNative: false };

    // No data directory at all
    if (!dataDir) {
        return {
            level: 'not-ready',
            readiness: baseReadiness,
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
    const fileChecks = REQUIRED_FILES.map(spec => checkFile(dataDir, spec));
    const skillDriftCheck = checkSkillDrift(skillDriftOptions);
    const checks = [...fileChecks, skillDriftCheck];

    const fails = checks.filter(c => c.status === 'fail');
    const passes = checks.filter(c => c.status === 'pass');

    let level;
    if (fails.length === REQUIRED_FILES.length) {
        level = 'not-ready';
    } else if (passes.length >= REQUIRED_FILES.length && fails.length === 0) {
        // All required-file checks pass (skill_drift is a warn-only advisory, not a file dependency)
        level = 'ready';
    } else {
        level = 'partial';
    }

    const nextActions = [];
    if (fails.length > 0) {
        const missing = fails.map(f => f.name).join(', ');
        nextActions.push(`Missing data: ${missing}. Run npm run merge and npm run contact-evidence to rebuild.`);
    }
    if (skillDriftCheck.status === 'warn') {
        nextActions.push(`Update Hermes Minty skill: hermes skills install minty-network-memory`);
    }

    const dataReady = level === 'ready';
    const readiness = {
        demo: dataReady && dataKind === 'demo',
        dogfood: dataReady && dataKind !== 'demo',
        hermesNative: dataReady && dataKind !== 'demo' && skillDriftCheck.status === 'pass',
    };

    return {
        level,
        readiness,
        checks,
        toolNames,
        dataDir: redactPath(dataDir),
        dataKind,
        nextActions,
    };
}

module.exports = { evaluateReadiness, redactPath, checkSkillDrift, extractSkillTools };
