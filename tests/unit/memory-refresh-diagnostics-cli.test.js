'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
    parseStepLog,
    inspectArtifacts,
    writeRefreshStatus,
} = require('../../scripts/memory-refresh-diagnostics');

const NOW = '2026-05-07T20:00:00.000Z';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-diag-test-'));
}

// --- parseStepLog ---

test('[DiagnosticsCLI]: parseStepLog reads JSONL step entries', () => {
    const dir = tmpDir();
    const logFile = path.join(dir, 'steps.jsonl');
    const lines = [
        JSON.stringify({ id: 'google_contacts', status: 'ok', startedAt: NOW, finishedAt: NOW, durationMs: 100 }),
        JSON.stringify({ id: 'telegram', status: 'failed', exitCode: 1, error: 'creds missing' }),
    ];
    fs.writeFileSync(logFile, lines.join('\n') + '\n');

    const steps = parseStepLog(logFile);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].id, 'google_contacts');
    assert.equal(steps[0].status, 'ok');
    assert.equal(steps[1].id, 'telegram');
    assert.equal(steps[1].exitCode, 1);
    fs.rmSync(dir, { recursive: true });
});

test('[DiagnosticsCLI]: parseStepLog returns empty array for missing file', () => {
    const steps = parseStepLog('/tmp/nonexistent-minty-test-log.jsonl');
    assert.deepEqual(steps, []);
});

test('[DiagnosticsCLI]: parseStepLog skips malformed lines', () => {
    const dir = tmpDir();
    const logFile = path.join(dir, 'steps.jsonl');
    fs.writeFileSync(logFile, 'not json\n{"id":"merge","status":"ok"}\n\n');

    const steps = parseStepLog(logFile);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].id, 'merge');
    fs.rmSync(dir, { recursive: true });
});

// --- inspectArtifacts ---

test('[DiagnosticsCLI]: inspectArtifacts detects existing and missing artifacts', () => {
    const dir = tmpDir();
    const dataDir = path.join(dir, 'data', 'unified');
    fs.mkdirSync(dataDir, { recursive: true });

    // Create a contacts.json with array content
    const contactsPath = path.join(dataDir, 'contacts.json');
    fs.writeFileSync(contactsPath, JSON.stringify([{ name: 'Alice' }, { name: 'Bob' }]));

    const artifacts = inspectArtifacts(dir);

    assert.equal(artifacts.contacts.exists, true);
    assert.equal(artifacts.contacts.count, 2);
    assert.ok(artifacts.contacts.mtime); // has mtime

    // sync-state lives at data/sync-state.json, not under data/unified.
    fs.writeFileSync(path.join(dir, 'data', 'sync-state.json'), JSON.stringify({ telegram: {}, linkedin: {} }));
    const artifactsWithSyncState = inspectArtifacts(dir);
    assert.equal(artifactsWithSyncState.syncState.exists, true);
    assert.equal(artifactsWithSyncState.syncState.count, 2);

    // interactions doesn't exist
    assert.equal(artifacts.interactions.exists, false);
    assert.equal(artifacts.interactions.count, undefined);

    // No private paths leak in serialization
    const serialized = JSON.stringify(artifacts);
    assert.equal(serialized.includes(dir), false, 'data dir path must not appear in artifacts');
    assert.equal(serialized.includes('/root'), false);

    fs.rmSync(dir, { recursive: true });
});

test('[DiagnosticsCLI]: inspectArtifacts counts object-valued JSON without exposing keys', () => {
    const dir = tmpDir();
    const dataDir = path.join(dir, 'data', 'unified');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'contacts.json'), '{"raw-contact-id-alpha":{"name":"Sentinel"}}');

    const artifacts = inspectArtifacts(dir);
    assert.equal(artifacts.contacts.exists, true);
    assert.equal(artifacts.contacts.count, 1);
    assert.equal(JSON.stringify(artifacts).includes('raw-contact-id-alpha'), false);
    assert.equal(JSON.stringify(artifacts).includes('Sentinel'), false);

    fs.rmSync(dir, { recursive: true });
});

// --- writeRefreshStatus ---

test('[DiagnosticsCLI]: writeRefreshStatus writes sanitized JSON to data/unified/', () => {
    const dir = tmpDir();
    const dataDir = path.join(dir, 'data', 'unified');
    fs.mkdirSync(dataDir, { recursive: true });

    // Create step log
    const logFile = path.join(dir, 'steps.jsonl');
    fs.writeFileSync(logFile, JSON.stringify({
        id: 'google_contacts', status: 'ok',
        startedAt: NOW, finishedAt: NOW, durationMs: 50,
    }) + '\n');

    // Create a contacts artifact
    fs.writeFileSync(path.join(dataDir, 'contacts.json'), '[{"n":"a"}]');

    const outPath = writeRefreshStatus({ stepLogPath: logFile, rootDir: dir });
    assert.equal(outPath, path.join(dataDir, 'memory-refresh-status.json'));

    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.steps.length, 1);
    assert.equal(report.steps[0].id, 'google_contacts');
    assert.equal(report.artifacts.contacts.exists, true);
    assert.ok(report.safety.redacted);

    // No private paths
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(dir), false);

    fs.rmSync(dir, { recursive: true });
});

test('[DiagnosticsCLI]: writeRefreshStatus creates output dir if missing', () => {
    const dir = tmpDir();
    const logFile = path.join(dir, 'steps.jsonl');
    fs.writeFileSync(logFile, JSON.stringify({ id: 'merge', status: 'ok' }) + '\n');

    // data/unified does NOT exist yet
    const outPath = writeRefreshStatus({ stepLogPath: logFile, rootDir: dir });
    assert.ok(fs.existsSync(outPath));

    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(report.schemaVersion, 1);

    fs.rmSync(dir, { recursive: true });
});

test('[DiagnosticsCLI]: writeRefreshStatus records failure status on failed steps', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'data', 'unified'), { recursive: true });
    const logFile = path.join(dir, 'steps.jsonl');
    fs.writeFileSync(logFile, [
        JSON.stringify({ id: 'google_contacts', status: 'ok' }),
        JSON.stringify({ id: 'telegram', status: 'failed', exitCode: 1, error: 'TELEGRAM_API_HASH missing at /root/.hermes/.env' }),
    ].join('\n') + '\n');

    const outPath = writeRefreshStatus({ stepLogPath: logFile, rootDir: dir });
    const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));

    assert.equal(report.status, 'failed');
    assert.equal(report.failedStep, 'telegram');
    // Error is redacted
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('TELEGRAM_API_HASH'), false);
    assert.equal(serialized.includes('/root/.hermes'), false);

    fs.rmSync(dir, { recursive: true });
});

test('[DiagnosticsCLI]: inspectArtifacts checks gbrain export path', () => {
    const dir = tmpDir();
    const gbrainDir = path.join(dir, 'data', 'gbrain');
    fs.mkdirSync(gbrainDir, { recursive: true });
    fs.writeFileSync(path.join(gbrainDir, 'relationship-memory.jsonl'), '{"a":1}\n{"b":2}\n');

    const artifacts = inspectArtifacts(dir);
    assert.equal(artifacts.gbrainJsonl.exists, true);
    assert.equal(artifacts.gbrainJsonl.count, 2);

    fs.rmSync(dir, { recursive: true });
});
