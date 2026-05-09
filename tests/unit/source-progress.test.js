/**
 * Tests for sources/_shared/progress.js.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../../sources/_shared/progress');

function mkTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-progress-'));
}

test('[Progress] startProgress creates a file with step=init', () => {
    const d = mkTempDir();
    P.startProgress(d, 'telegram', { message: 'Loading…' });
    const rec = P.readProgress(d, 'telegram');
    assert.ok(rec);
    assert.equal(rec.source, 'telegram');
    assert.equal(rec.step, 'init');
    assert.equal(rec.message, 'Loading…');
    assert.ok(rec.startedAt);
    assert.ok(rec.updatedAt);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] updateProgress merges patch into existing record', () => {
    const d = mkTempDir();
    P.startProgress(d, 'email', { message: 'Hello' });
    P.updateProgress(d, 'email', { step: 'messages', current: 7, total: 100 });
    const rec = P.readProgress(d, 'email');
    assert.equal(rec.step, 'messages');
    assert.equal(rec.current, 7);
    assert.equal(rec.total, 100);
    assert.equal(rec.message, 'Hello'); // unchanged
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] isActive returns false for stale records (killed mid-sync)', () => {
    // Mid-sync record whose updatedAt is older than STALE_AFTER_MS — process died.
    const stale = {
        source: 'whatsapp',
        step: 'messages',
        current: 255,
        total: 736,
        updatedAt: new Date(Date.now() - P.STALE_AFTER_MS - 1000).toISOString(),
    };
    assert.equal(P.isActive(stale), false);
    assert.equal(P.isStale(stale), true);

    const fresh = { ...stale, updatedAt: new Date().toISOString() };
    assert.equal(P.isActive(fresh), true);
    assert.equal(P.isStale(fresh), false);
});

test('[Progress] finishProgress marks step=done; isActive returns false', () => {
    const d = mkTempDir();
    P.startProgress(d, 'sms');
    P.updateProgress(d, 'sms', { current: 50, total: 50 });
    P.finishProgress(d, 'sms', { message: 'Imported 50 messages' });
    const rec = P.readProgress(d, 'sms');
    assert.equal(rec.step, 'done');
    assert.equal(rec.message, 'Imported 50 messages');
    assert.equal(P.isActive(rec), false);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress records sanitized error metadata without stack traces', () => {
    const d = mkTempDir();
    P.startProgress(d, 'linkedin');
    const e = new Error('/Users/sree/private/export.csv failed for alice@example.com with token=secret');
    e.code = 'ENOENT';
    e.stack = 'Error: alice@example.com\n    at /Users/sree/private/export.csv:1:1';
    P.failProgress(d, 'linkedin', e);
    const rec = P.readProgress(d, 'linkedin');
    assert.equal(rec.step, 'error');
    assert.equal(rec.message, '[redacted-path] failed for [redacted-email] with [redacted-credential]');
    assert.equal(rec.error.message, '[redacted-path] failed for [redacted-email] with [redacted-credential]');
    assert.equal(rec.error.code, 'ENOENT');
    assert.equal(rec.error.name, 'Error');
    assert.equal(rec.error.stack, undefined);
    assert.ok(!JSON.stringify(rec).includes('alice@example.com'));
    assert.ok(!JSON.stringify(rec).includes('/Users/sree/private/export.csv'));
    assert.ok(!JSON.stringify(rec).includes('secret'));
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes bearer tokens, Windows paths, and unsafe metadata', () => {
    const d = mkTempDir();
    P.failProgress(d, 'email', {
        message: 'authorization: Bearer abc123 at C:\\Users\\sree\\private\\export and \\\\server\\share\\tokenfile',
        code: '../../SECRET',
        name: 'Error /tmp/private',
    });
    const rec = P.readProgress(d, 'email');
    const serialized = JSON.stringify(rec);
    assert.equal(rec.error.code, undefined);
    assert.equal(rec.error.name, undefined);
    assert.equal(serialized.includes('abc123'), false);
    assert.equal(serialized.includes('C:\\Users\\sree'), false);
    assert.equal(serialized.includes('server\\share'), false);
    assert.match(rec.error.message, /\[redacted-credential\]/);
    assert.match(rec.error.message, /\[redacted-path\]/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes string errors', () => {
    const d = mkTempDir();
    P.failProgress(d, 'telegram', 'Bearer zzz999 failed for +1 555 123 4567 in /tmp/source-export');
    const rec = P.readProgress(d, 'telegram');
    const serialized = JSON.stringify(rec);
    assert.equal(serialized.includes('zzz999'), false);
    assert.equal(serialized.includes('+1 555 123 4567'), false);
    assert.equal(serialized.includes('/tmp/source-export'), false);
    assert.match(rec.error.message, /Bearer \[redacted-credential\]/);
    assert.match(rec.error.message, /\[redacted-phone\]/);
    assert.match(rec.error.message, /\[redacted-path\]/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes relative paths, spaced paths, and stack-like text', () => {
    const d = mkTempDir();
    P.failProgress(d, 'memory', [
        'Error: failed at private-cache/source dump',
        'at run (relative/private folder/source dump:12:3)',
        '    at refresh (/Users/sree/Private Exports/source dump.csv:12:3)',
        '    at run (/tmp/minty local/build-output.log:4:2)',
    ].join('\n'));
    const rec = P.readProgress(d, 'memory');
    const serialized = JSON.stringify(rec);
    assert.equal(serialized.includes('private-cache/source dump'), false);
    assert.equal(serialized.includes('relative/private folder/source dump'), false);
    assert.equal(serialized.includes('/Users/sree/Private Exports/source dump.csv'), false);
    assert.equal(serialized.includes('/tmp/minty local/build-output.log'), false);
    assert.equal(/(?:^|\n)\s*at\s+\w+\s*\(/.test(rec.error.message), false);
    assert.match(rec.error.message, /\[redacted-path\]/);
    assert.match(rec.error.message, /\[redacted-stack\]/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes Windows-style relative and quoted paths', () => {
    const d = mkTempDir();
    P.failProgress(d, 'memory', 'failed in "private\\cache\\source dump" and [C:\\Users\\sree\\Private Exports\\source dump]');
    const rec = P.readProgress(d, 'memory');
    const serialized = JSON.stringify(rec);
    assert.equal(serialized.includes('private\\cache\\source dump'), false);
    assert.equal(serialized.includes('C:\\Users\\sree\\Private Exports\\source dump'), false);
    assert.equal(rec.error.message, 'failed in "[redacted-path]" and [[redacted-path]]');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes unquoted Windows paths with spaces', () => {
    const d = mkTempDir();
    P.failProgress(d, 'memory', 'failed at C:\\Users\\sree\\Private Exports\\source dump and private\\cache\\source dump');
    const rec = P.readProgress(d, 'memory');
    assert.equal(rec.error.message, 'failed at [redacted-path]');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes standalone Windows-style relative paths', () => {
    const d = mkTempDir();
    P.failProgress(d, 'memory', 'failed at private\\cache\\source dump');
    const rec = P.readProgress(d, 'memory');
    assert.equal(rec.error.message, 'failed at [redacted-path]');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] failProgress sanitizes JSON-style credentials and extensionless spaced paths', () => {
    const d = mkTempDir();
    P.failProgress(d, 'memory', 'failed at /Users/sree/Private Exports/source dump with "api_key": "sk-secret value"');
    const rec = P.readProgress(d, 'memory');
    const serialized = JSON.stringify(rec);
    assert.equal(serialized.includes('/Users/sree/Private Exports/source dump'), false);
    assert.equal(serialized.includes('sk-secret value'), false);
    assert.equal(rec.error.message, 'failed at [redacted-path]');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] percent clamps and returns null when no total', () => {
    assert.equal(P.percent(null), null);
    assert.equal(P.percent({ total: 0 }), null);
    assert.equal(P.percent({ total: 10, current: 5 }), 50);
    assert.equal(P.percent({ total: 10, current: 15 }), 100);
    assert.equal(P.percent({ total: 10, current: -1 }), 0);
});

test('[Progress] listActive excludes done + error', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp');
    P.updateProgress(d, 'whatsapp', { current: 3, total: 10 });

    P.startProgress(d, 'email');
    P.finishProgress(d, 'email');

    P.startProgress(d, 'telegram');
    P.failProgress(d, 'telegram', new Error('x'));

    const active = P.listActive(d);
    assert.deepEqual(Object.keys(active).sort(), ['whatsapp']);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] whatsapp writes to both canonical and legacy path (back-compat)', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp', { step: 'contacts', message: 'x' });
    const legacy = path.join(d, 'whatsapp', '.export-progress.json');
    assert.ok(fs.existsSync(legacy), 'legacy path must keep existing for server.js compatibility');
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    assert.equal(raw.step, 'contacts');
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] readProgress returns null when source has no progress', () => {
    const d = mkTempDir();
    assert.equal(P.readProgress(d, 'sms'), null);
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] writes are atomic (no half-written JSON after crash-style rename)', () => {
    const d = mkTempDir();
    P.startProgress(d, 'telegram');
    // Simulate many rapid updates — there should never be a parse error
    for (let i = 0; i < 50; i++) {
        P.updateProgress(d, 'telegram', { current: i, total: 50, message: `msg ${i}` });
        const rec = P.readProgress(d, 'telegram');
        assert.ok(rec);
        assert.equal(rec.current, i);
    }
    fs.rmSync(d, { recursive: true, force: true });
});

test('[Progress] listProgress returns every source that has a record', () => {
    const d = mkTempDir();
    P.startProgress(d, 'whatsapp');
    P.startProgress(d, 'linkedin');
    const all = P.listProgress(d);
    assert.deepEqual(Object.keys(all).sort(), ['linkedin', 'whatsapp']);
    fs.rmSync(d, { recursive: true, force: true });
});
