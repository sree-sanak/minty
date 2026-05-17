#!/usr/bin/env node
'use strict';

/**
 * scripts/source-quality-workbench.js — local read-only CLI for the source quality workbench.
 *
 * Emits the same privacy-safe aggregate envelope as /api/source-quality/workbench without
 * starting the CRM server or exposing raw contacts, ids, paths, provider payloads, or message bodies.
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeSourceFilter } = require('../crm/agent-source-health');
const { buildSourceQualityWorkbench } = require('../crm/source-quality-workbench');

function readJsonIfExists(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function safeSourceHealthNow(value) {
    if (!value) return undefined;
    if (typeof value !== 'string' || value.length > 128) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString().replace('.000Z', 'Z') === value ? value : parsed.toISOString();
}

function parseArgs(argv) {
    const options = {
        sources: [],
        now: undefined,
        format: 'json',
        dataDir: process.env.CRM_DATA_DIR || path.join(process.cwd(), 'data'),
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--json') {
            options.format = 'json';
        } else if (arg === '--pretty') {
            options.pretty = true;
        } else if (arg === '--human') {
            options.format = 'human';
        } else if (arg === '--source' || arg === '--sources') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw Object.assign(new Error('Missing value for source option.'), { code: 'missing_source' });
            }
            i += 1;
            options.sources.push(...String(value).split(',').map(s => s.trim()).filter(Boolean));
        } else if (arg === '--now') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw Object.assign(new Error('Missing value for now option.'), { code: 'missing_now' });
            }
            i += 1;
            options.now = safeSourceHealthNow(value);
        } else if (arg === '--data-dir') {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) {
                throw Object.assign(new Error('Missing value for data directory option.'), { code: 'missing_data_dir' });
            }
            i += 1;
            options.dataDir = value;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            throw Object.assign(new Error('Unknown option.'), { code: 'unknown_option' });
        }
    }

    return options;
}

function loadSourceTrustData(dataDir) {
    const unifiedDir = path.join(dataDir, 'unified');
    return {
        contacts: readJsonIfExists(path.join(unifiedDir, 'contacts.json'), []),
        interactions: readJsonIfExists(path.join(unifiedDir, 'interactions.json'), []),
        contactEvidence: readJsonIfExists(path.join(unifiedDir, 'contact-evidence.json'), {}),
        sourceEvents: readJsonIfExists(path.join(unifiedDir, 'source-events.json'), []),
        syncState: readJsonIfExists(path.join(dataDir, 'sync-state.json'), {}),
        memoryRefreshStatus: readJsonIfExists(path.join(dataDir, 'memory-refresh-status.json'), null),
    };
}

function formatHuman(payload) {
    const bucketLines = Object.entries(payload.buckets || {}).map(([key, bucket]) => (
        `- ${key}: ${bucket.count || 0}`
    ));
    return [
        `status: ${payload.status}`,
        `totalOpenItems: ${payload.summary ? payload.summary.totalOpenItems : 0}`,
        `sourcesReviewed: ${payload.summary ? payload.summary.sourcesReviewed : 0}`,
        ...bucketLines,
        `readOnly: ${payload.safety && payload.safety.readOnly === true}`,
    ].join('\n');
}

function usage() {
    return [
        'Usage: npm run source-quality -- [--json|--human] [--pretty] [--source SOURCE[,SOURCE]] [--now ISO_Z] [--data-dir DIR]',
        '',
        'Read-only. Emits aggregate source-quality trust gaps with contact details and raw rows omitted.',
    ].join('\n');
}

function buildError(code, message) {
    return {
        ok: false,
        error: {
            code,
            message,
        },
        safety: {
            readOnly: true,
            contactDetailsOmitted: true,
            rawRowsOmitted: true,
            tokenPathsOmitted: true,
        },
    };
}

function runSourceQualityWorkbenchCli(argv = process.argv.slice(2), io = {}) {
    const stdout = io.stdout || process.stdout;
    const stderr = io.stderr || process.stderr;
    let options;
    try {
        options = parseArgs(argv);
        if (options.help) {
            stdout.write(`${usage()}\n`);
            return 0;
        }
        const filter = normalizeSourceFilter(options.sources.length ? options.sources : undefined);
        if (filter.invalid.length) {
            stdout.write(`${JSON.stringify(buildError('invalid_source', 'Unknown source filter.'), null, 2)}\n`);
            return 2;
        }
        const payload = buildSourceQualityWorkbench(loadSourceTrustData(options.dataDir), {
            now: options.now,
            sources: filter.sources,
        });
        if (options.format === 'human') {
            stdout.write(`${formatHuman(payload)}\n`);
        } else {
            stdout.write(`${JSON.stringify(payload, null, options.pretty ? 2 : 0)}\n`);
        }
        return 0;
    } catch (err) {
        const code = err && err.code ? err.code : 'invalid_args';
        const payload = buildError(code, err && err.message ? err.message : 'Invalid arguments.');
        const target = code === 'unknown_option' || code.startsWith('missing_') ? stderr : stdout;
        target.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 2;
    }
}

if (require.main === module) {
    process.exitCode = runSourceQualityWorkbenchCli();
}

module.exports = {
    buildError,
    formatHuman,
    loadSourceTrustData,
    parseArgs,
    runSourceQualityWorkbenchCli,
    safeSourceHealthNow,
};
