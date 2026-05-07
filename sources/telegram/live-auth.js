'use strict';

const fs = require('fs');
const qrcode = require('qrcode');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

function makeTelegramLoginUrl(token) {
    return `tg://login?token=${Buffer.from(token).toString('base64url')}`;
}

function safeUser(user) {
    if (!user) return null;
    return {
        id: user.id != null ? String(user.id) : null,
        username: user.username || null,
        firstName: user.firstName || user.first_name || null,
        lastName: user.lastName || user.last_name || null,
        phone: user.phone || null,
    };
}

function createTelegramQrManager(options = {}) {
    const Client = options.TelegramClient || TelegramClient;
    const Session = options.StringSession || StringSession;
    const toDataURL = options.toDataURL || (url => qrcode.toDataURL(url, { width: 256, margin: 2 }));
    const apiId = Number(options.apiId || process.env.TELEGRAM_API_ID);
    const apiHash = options.apiHash || process.env.TELEGRAM_API_HASH;
    const initialSession = options.session || '';
    const passwordProvider = options.passwordProvider || (async () => { throw new Error('Telegram 2FA password required'); });
    const onConnected = options.onConnected || (async () => {});

    if (!Number.isInteger(apiId)) throw new Error('TELEGRAM_API_ID must be configured');
    if (!apiHash) throw new Error('TELEGRAM_API_HASH must be configured');

    const state = {
        status: 'idle',
        qr: null,
        loginUrl: null,
        expiresAt: null,
        user: null,
        error: null,
        startedAt: null,
        connectedAt: null,
    };
    let client = null;
    let promise = null;
    let stopped = false;

    async function start() {
        if (promise) return promise;
        stopped = false;
        state.status = 'starting';
        state.startedAt = new Date().toISOString();
        client = new Client(new Session(initialSession), apiId, apiHash, { connectionRetries: 5 });
        promise = (async () => {
            try {
                await client.connect();
                if (await client.isUserAuthorized()) {
                    state.status = 'connected';
                    state.connectedAt = new Date().toISOString();
                    const session = client.session.save();
                    await onConnected({ session, user: null });
                    return { session, user: null };
                }
                const user = await client.signInUserWithQrCode(
                    { apiId, apiHash },
                    {
                        qrCode: async ({ token, expires }) => {
                            const loginUrl = makeTelegramLoginUrl(token);
                            state.loginUrl = loginUrl;
                            state.qr = await toDataURL(loginUrl);
                            state.expiresAt = expires instanceof Date ? expires.toISOString() : expires;
                            state.status = 'qr_pending';
                        },
                        password: passwordProvider,
                        onError: async error => {
                            state.error = error && (error.message || String(error));
                            return false;
                        },
                    }
                );
                if (stopped) return null;
                const session = client.session.save();
                state.status = 'connected';
                state.connectedAt = new Date().toISOString();
                state.user = safeUser(user);
                state.qr = null;
                state.loginUrl = null;
                await onConnected({ session, user: state.user });
                return { session, user: state.user };
            } catch (error) {
                if (!stopped) {
                    state.status = 'error';
                    state.error = error && (error.message || String(error));
                }
                throw error;
            }
        })();
        promise.catch(() => {});
        return promise;
    }

    async function stop() {
        stopped = true;
        if (state.status !== 'connected') state.status = 'stopped';
        if (client && typeof client.disconnect === 'function') await client.disconnect();
    }

    function status() {
        return {
            status: state.status,
            qr: state.qr,
            expiresAt: state.expiresAt,
            startedAt: state.startedAt,
            connectedAt: state.connectedAt,
            user: state.user,
            error: state.error,
        };
    }

    return { start, stop, status };
}

function saveTelegramSessionMeta(metaPath, { session, user }) {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = {}; }
    meta.telegram = {
        ...(meta.telegram || {}),
        status: 'connected',
        connectedAt: new Date().toISOString(),
        session,
        user: safeUser(user),
    };
    fs.mkdirSync(require('path').dirname(metaPath), { recursive: true });
    // Create new credential-bearing files owner-only from the first write; chmod
    // both before and after so existing files are corrected before replacement.
    try { if (fs.existsSync(metaPath)) fs.chmodSync(metaPath, 0o600); } catch { /* ignore */ }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
    try { fs.chmodSync(metaPath, 0o600); } catch { /* ignore */ }
    return meta.telegram;
}

module.exports = {
    makeTelegramLoginUrl,
    createTelegramQrManager,
    saveTelegramSessionMeta,
    safeUser,
};
