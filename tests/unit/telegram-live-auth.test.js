'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    makeTelegramLoginUrl,
    createTelegramQrManager,
    saveTelegramSessionMeta,
} = require('../../sources/telegram/live-auth');

test('makeTelegramLoginUrl converts token buffer into tg login URL', () => {
    const url = makeTelegramLoginUrl(Buffer.from('hello world'));
    assert.equal(url, 'tg://login?token=aGVsbG8gd29ybGQ');
});

test('createTelegramQrManager starts QR flow and reports qr_pending status', async () => {
    class FakeClient {
        constructor(session, apiId, apiHash) {
            this.session = { save: () => 'SESSION_STRING' };
            this.apiId = apiId;
            this.apiHash = apiHash;
            this.disconnected = false;
        }
        async connect() {}
        async isUserAuthorized() { return false; }
        async signInUserWithQrCode(credentials, params) {
            await params.qrCode({ token: Buffer.from('token'), expires: new Date('2026-01-01T00:00:00Z') });
            return new Promise(() => {});
        }
        async disconnect() { this.disconnected = true; }
    }
    const qrs = [];
    const manager = createTelegramQrManager({
        TelegramClient: FakeClient,
        StringSession: class { constructor(value) { this.value = value; } },
        toDataURL: async url => { qrs.push(url); return 'data:image/png;base64,abc'; },
        apiId: 123,
        apiHash: 'hash',
    });

    manager.start();
    await new Promise(resolve => setImmediate(resolve));
    const status = manager.status();
    assert.equal(status.status, 'qr_pending');
    assert.equal(status.qr, 'data:image/png;base64,abc');
    assert.equal(status.loginUrl, undefined);
    assert.equal(status.session, undefined);
    assert.deepEqual(qrs, ['tg://login?token=dG9rZW4']);
    await manager.stop();
});

test('saveTelegramSessionMeta stores session in owner-only sources metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-tg-'));
    const metaPath = path.join(dir, 'sources.json');
    saveTelegramSessionMeta(metaPath, {
        session: 'SECRET_SESSION',
        user: { id: '42', username: 'sree', firstName: 'Sree' },
    });
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.telegram.status, 'connected');
    assert.equal(meta.telegram.session, 'SECRET_SESSION');
    assert.equal(meta.telegram.user.username, 'sree');
    assert.ok(meta.telegram.connectedAt);
    if (process.platform !== 'win32') {
        assert.equal((fs.statSync(metaPath).mode & 0o777), 0o600);
    }
});

test('live QR CLI can be imported without running login side effects', () => {
    const cli = require('../../sources/telegram/live-qr');
    assert.equal(typeof cli.run, 'function');
    assert.equal(typeof cli.upsertDotEnv, 'function');
});
