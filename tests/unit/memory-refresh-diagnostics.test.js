'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRefreshStatus,
    redactDiagnosticValue,
    sanitizeArtifact,
    sanitizeStep,
} = require('../../crm/memory-refresh-diagnostics');

const NOW = '2026-05-07T20:00:00.000Z';

function step(id, status, extra = {}) {
    return {
        id,
        label: id,
        status,
        startedAt: '2026-05-07T19:59:00.000Z',
        finishedAt: '2026-05-07T19:59:02.000Z',
        durationMs: 2000,
        ...extra,
    };
}

test('[MemoryRefreshDiagnostics]: summarizes successful refresh without leaking private paths', () => {
    const report = buildRefreshStatus({
        generatedAt: NOW,
        steps: [
            step('google_contacts', 'ok'),
            step('telegram', 'ok'),
            step('merge', 'ok'),
            step('contact_evidence', 'ok'),
            step('source_events', 'ok'),
            step('hybrid_index', 'ok'),
            step('query_index', 'ok'),
            step('gbrain_export', 'ok'),
            step('gbrain_import', 'ok'),
            step('mcp_smoke', 'skipped', { warning: 'hermes CLI not available' }),
        ],
        artifacts: {
            contacts: { exists: true, count: 12, mtime: NOW, path: '/root/.hermes/workspace/minty/data/unified/contacts.json' },
            contactEvidence: { exists: true, count: 8, mtime: NOW },
            sourceEvents: { exists: true, count: 20, mtime: NOW },
            gbrainJsonl: { exists: true, count: 12, mtime: NOW, path: '/root/.hermes/workspace/minty/data/gbrain/relationship-memory.jsonl' },
        },
    });

    assert.equal(report.status, 'warning');
    assert.equal(report.generatedAt, NOW);
    assert.equal(report.steps.length, 10);
    assert.equal(report.artifacts.contacts.count, 12);
    assert.equal(report.artifacts.contacts.path, undefined, 'repo paths should not be serialized');
    assert.deepEqual(report.nextActions, ['Install or expose Hermes CLI, then rerun npm run memory:refresh to verify MCP registration.']);

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('/root/.hermes'), false);
    assert.equal(serialized.includes('google_token'), false);
});

test('[MemoryRefreshDiagnostics]: failed required step marks downstream artifacts stale', () => {
    const report = buildRefreshStatus({
        generatedAt: NOW,
        steps: [
            step('google_contacts', 'ok'),
            step('telegram', 'failed', { exitCode: 1, error: 'TELEGRAM_API_HASH missing at /root/.hermes/workspace/minty/.env' }),
            step('merge', 'skipped'),
        ],
        artifacts: {
            contacts: { exists: true, count: 5, mtime: '2026-05-01T00:00:00.000Z' },
            sourceEvents: { exists: false },
        },
    });

    assert.equal(report.status, 'failed');
    assert.equal(report.failedStep, 'telegram');
    assert.ok(report.warnings.includes('sourceEvents_missing'));
    assert.equal(report.nextActions[0], 'Fix Telegram refresh credentials/session or provide a Telegram Desktop export, then rerun npm run memory:refresh.');

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('TELEGRAM_API_HASH'), false, 'secret env var names should be generalized');
    assert.equal(serialized.includes('/root/.hermes'), false, 'private paths should be redacted');
});

test('[MemoryRefreshDiagnostics]: redacts direct contact details, private paths, and message-like strings', () => {
    const value = redactDiagnosticValue('alice@example.com +141****0100 raw message from private group /root/.hermes/google_token.json /home/alice/.ssh/id_rsa /Users/alice/Desktop/contacts.csv C:\\Users\\alice\\Documents\\contacts.csv');
    assert.equal(value.includes('alice@example.com'), false);
    assert.equal(value.includes('+141****0100'), false);
    assert.equal(value.includes('raw message'), false);
    assert.equal(value.includes('/root'), false);
    assert.equal(value.includes('/home/alice'), false);
    assert.equal(value.includes('/Users/alice'), false);
    assert.equal(value.includes('C:\\Users\\alice'), false);
});

test('[MemoryRefreshDiagnostics]: redacts secret-like names with values', () => {
    const sensitiveNames = ['TELEGRAM_API_HASH', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD'];
    const sensitiveValues = ['hash-sentinel-value', 'openai-sentinel-value', 'github-sentinel-value', 'aws-sentinel-value', 'db-sentinel-value'];
    const value = redactDiagnosticValue(sensitiveNames.map((name, index) => `${name}:${sensitiveValues[index]}`).join(' '));
    for (const sensitiveValue of sensitiveValues) {
        assert.equal(value.includes(sensitiveValue), false);
    }
    for (const sensitiveName of sensitiveNames) {
        assert.equal(value.includes(sensitiveName), false);
    }
});

test('[MemoryRefreshDiagnostics]: sanitizeStep preserves safe fields and redacts unsafe details', () => {
    const sanitized = sanitizeStep({
        id: 'telegram',
        status: 'failed',
        startedAt: NOW,
        finishedAt: NOW,
        durationMs: 12.8,
        exitCode: 1,
        error: 'TELEGRAM_API_HASH:hash-sentinel-value raw message from alice@example.com /root/.hermes/.env',
        nested: { private: '/root/.hermes/google_token.json' },
    });

    assert.equal(sanitized.id, 'telegram');
    assert.equal(sanitized.status, 'failed');
    assert.equal(sanitized.durationMs, 12);
    assert.equal(sanitized.exitCode, 1);
    assert.equal(sanitized.nested, undefined);
    assert.equal(sanitized.error.includes('hash-sentinel-value'), false);
    assert.equal(sanitized.error.includes('TELEGRAM_API_HASH'), false);
    assert.equal(sanitized.error.includes('/root/.hermes'), false);
    assert.equal(sanitized.error.includes('alice@example.com'), false);
});

test('[MemoryRefreshDiagnostics]: sanitizeStep degrades unknown ids and malformed timestamps safely', () => {
    const sanitized = sanitizeStep({ id: '../contacts', status: 'unexpected', startedAt: 'not-a-date', finishedAt: NOW });
    assert.equal(sanitized.id, 'unknown');
    assert.equal(sanitized.status, 'warning');
    assert.equal(sanitized.startedAt, null);
    assert.equal(sanitized.finishedAt, NOW);
});

test('[MemoryRefreshDiagnostics]: sanitizeArtifact preserves counts and omits paths', () => {
    const sanitized = sanitizeArtifact({ exists: true, count: 3.9, mtime: NOW, path: '/root/.hermes/workspace/minty/data/unified/contacts.json' });
    assert.deepEqual(sanitized, { exists: true, count: 3, mtime: NOW });
});

test('[MemoryRefreshDiagnostics]: sanitizeArtifact tolerates missing and malformed fields', () => {
    assert.deepEqual(sanitizeArtifact({ exists: false, count: -2, mtime: 'bad-date' }), { exists: false, count: 0 });
    assert.deepEqual(sanitizeArtifact(null), { exists: false });
});

test('[MemoryRefreshDiagnostics]: ignores unsafe artifact keys', () => {
    const report = buildRefreshStatus({
        generatedAt: NOW,
        steps: [step('merge', 'ok')],
        artifacts: {
            contacts: { exists: true, count: 1, mtime: NOW },
            '__proto__': { exists: false },
            '../private': { exists: true, count: 99, mtime: NOW },
            rawContactIds: { exists: true, count: 99, mtime: NOW },
        },
    });

    assert.deepEqual(Object.keys(report.artifacts), ['contacts']);
    assert.equal(Object.getPrototypeOf(report.artifacts), null);
    assert.equal(report.artifacts.rawContactIds, undefined);
});
