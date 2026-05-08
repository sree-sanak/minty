#!/usr/bin/env node
'use strict';

/**
 * CLI helper: reads a step-log JSONL file, inspects repo-local artifacts,
 * builds a privacy-safe diagnostics report, and writes
 * data/unified/memory-refresh-status.json.
 *
 * Usage (from refresh-hermes-memory.sh):
 *   node scripts/memory-refresh-diagnostics.js <step-log.jsonl> [root-dir]
 *
 * Library usage:
 *   const { parseStepLog, inspectArtifacts, writeRefreshStatus } = require('./memory-refresh-diagnostics');
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildRefreshStatus } = require('../crm/memory-refresh-diagnostics');

// Map of artifact id → relative path from project root
const ARTIFACT_PATHS = {
    contacts:        'data/unified/contacts.json',
    interactions:    'data/unified/interactions.json',
    insights:        'data/unified/insights.json',
    digest:          'data/unified/digest.json',
    contactEvidence: 'data/unified/contact-evidence.json',
    sourceEvents:    'data/unified/source-events.json',
    hybridIndex:     'data/unified/hybrid-index.json',
    queryIndex:      'data/unified/query-index.json',
    gbrainJsonl:     'data/gbrain/relationship-memory.jsonl',
    syncState:       'data/sync-state.json',
};

/**
 * Parse a JSONL step log file. Returns an array of step objects.
 * Returns [] if the file does not exist or is empty.
 */
function parseStepLog(filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const steps = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            steps.push(JSON.parse(trimmed));
        } catch {
            // skip malformed lines
        }
    }
    return steps;
}

/**
 * Inspect known artifact files relative to rootDir.
 * Returns an object keyed by artifact id with { exists, count?, mtime? }.
 * Never includes file paths in the output.
 */
function inspectArtifacts(rootDir) {
    const artifacts = Object.create(null);
    for (const [id, relPath] of Object.entries(ARTIFACT_PATHS)) {
        const fullPath = path.join(rootDir, relPath);
        let fd;
        try {
            fd = fs.openSync(fullPath, 'r');
        } catch {
            artifacts[id] = { exists: false };
            continue;
        }

        try {
            const stat = fs.fstatSync(fd);
            const entry = {
                exists: true,
                mtime: stat.mtime.toISOString(),
            };
            // Try to get count for JSON arrays/objects and JSONL files without
            // reopening the path after the existence check.
            try {
                const raw = fs.readFileSync(fd, 'utf8');
                if (relPath.endsWith('.jsonl')) {
                    const lines = raw.split('\n').filter(l => l.trim());
                    entry.count = lines.length;
                } else {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        entry.count = parsed.length;
                    } else if (parsed && typeof parsed === 'object') {
                        entry.count = Object.keys(parsed).length;
                    }
                }
            } catch {
                // count is optional
            }
            artifacts[id] = entry;
        } finally {
            fs.closeSync(fd);
        }
    }
    return artifacts;
}

/**
 * Build and write the sanitized refresh status report.
 * @param {object} opts
 * @param {string} opts.stepLogPath - Path to the JSONL step log
 * @param {string} opts.rootDir - Project root directory
 * @returns {string} Path to the written status file
 */
function writeRefreshStatus({ stepLogPath, rootDir }) {
    const steps = parseStepLog(stepLogPath);
    const artifacts = inspectArtifacts(rootDir);
    const report = buildRefreshStatus({
        generatedAt: new Date().toISOString(),
        steps,
        artifacts,
    });

    const outDir = path.join(rootDir, 'data', 'unified');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'memory-refresh-status.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    return outPath;
}

// CLI entry point
if (require.main === module) {
    const stepLogPath = process.argv[2];
    const rootDir = process.argv[3] || path.resolve(__dirname, '..');
    if (!stepLogPath) {
        console.error('Usage: node scripts/memory-refresh-diagnostics.js <step-log.jsonl> [root-dir]');
        process.exit(1);
    }
    const outPath = writeRefreshStatus({ stepLogPath, rootDir });
    console.log(`Wrote memory refresh diagnostics to ${path.relative(rootDir, outPath)}`);
}

module.exports = { parseStepLog, inspectArtifacts, writeRefreshStatus, ARTIFACT_PATHS };
