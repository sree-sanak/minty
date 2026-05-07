'use strict';

/**
 * Live Telegram sync via MTProto / GramJS.
 *
 * This writes the same privacy-local files consumed by sources/telegram/import.js:
 *   data/telegram/contacts.json
 *   data/telegram/chats.json
 *
 * Required env:
 *   TELEGRAM_API_ID
 *   TELEGRAM_API_HASH
 *   TELEGRAM_SESSION     A GramJS StringSession. Generate once interactively with --login.
 *
 * Optional env:
 *   TELEGRAM_OUT_DIR     default data/telegram
 *   TELEGRAM_DIALOG_LIMIT default 300
 *   TELEGRAM_MESSAGE_LIMIT default 200
 *   TELEGRAM_INCLUDE_GROUPS=0 to exclude group/supergroup dialogs
 *
 * One-time login:
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_PHONE=+1... node sources/telegram/live.js --login
 * Then save the printed TELEGRAM_SESSION as a daemon secret.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const P = require('../_shared/progress');
const { safeInt, sleep, sourceSafeMode } = require('../_shared/safety');

const ROOT = path.join(__dirname, '../..');

function loadLocalEnv() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] != null) continue;
        process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
}

loadLocalEnv();

const DATA_DIR = process.env.CRM_DATA_DIR || path.join(ROOT, 'data');
const OUT_DIR = process.env.TELEGRAM_OUT_DIR || path.join(DATA_DIR, 'telegram');

function asId(value) {
    if (value == null) return null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object' && value.value != null) return asId(value.value);
    return String(value);
}

function entityName(entity, fallback = '') {
    if (!entity) return fallback || '';
    const first = entity.firstName || entity.first_name || '';
    const last = entity.lastName || entity.last_name || '';
    const joined = `${first} ${last}`.trim();
    return joined || entity.title || entity.username || fallback || '';
}

function toIsoDate(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value * 1000).toISOString();
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeContact(entity) {
    return {
        firstName: entity.firstName || entity.first_name || '',
        lastName: entity.lastName || entity.last_name || '',
        name: entityName(entity),
        username: entity.username || null,
        phone: entity.phone || null,
        userId: asId(entity.id),
        accessHash: asId(entity.accessHash || entity.access_hash),
        bot: Boolean(entity.bot),
        mutualContact: Boolean(entity.mutualContact || entity.mutual_contact),
        date: null,
        source: 'telegram',
        sourceMode: 'live',
    };
}

function normalizeMessage(message) {
    return {
        id: asId(message.id),
        timestamp: toIsoDate(message.date),
        from: message.out ? 'me' : null,
        fromId: asId(message.senderId || message.fromId?.userId || message.peerId?.userId || message.fromId),
        body: typeof message.message === 'string' ? message.message : '',
        type: message.className || 'message',
        mediaType: message.media?.className || null,
        replyToId: asId(message.replyTo?.replyToMsgId || message.replyToMsgId),
        forwarded: message.fwdFrom ? true : null,
    };
}

function normalizeDialog(dialog, messages) {
    const entity = dialog.entity || dialog.inputEntity || {};
    return {
        id: asId(entity.id || dialog.id),
        accessHash: asId(entity.accessHash || entity.access_hash),
        username: entity.username || null,
        name: dialog.name || entityName(entity, String(dialog.title || '')),
        type: entity.className || (dialog.isGroup ? 'group' : 'user'),
        sourceMode: 'live',
        messages: messages.map(normalizeMessage),
    };
}

function telegramQrLoginUrl(token) {
    const encoded = Buffer.from(token)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return `tg://login?token=${encoded}`;
}

function loadTelegramDeps() {
    try {
        const { TelegramClient, Api } = require('telegram');
        const { StringSession } = require('telegram/sessions');
        return { TelegramClient, StringSession, Api };
    } catch (e) {
        throw new Error('Missing optional dependency "telegram". Run: npm install telegram --save-optional');
    }
}

async function fetchContacts(client, Api = loadTelegramDeps().Api) {
    if (typeof client.getContacts === 'function') return client.getContacts();
    if (!Api?.contacts?.GetContacts || typeof client.invoke !== 'function') {
        throw new Error('Telegram client does not support contact sync');
    }
    const result = await client.invoke(new Api.contacts.GetContacts({ hash: 0 }));
    return Array.from(result?.users || []);
}

async function promptHiddenish(rl, label) {
    // Not truly hidden, but keeps login flow explicit and avoids storing secrets here.
    return (await rl.question(label)).trim();
}

async function createClient({ login = false, qr = false } = {}) {
    const apiId = Number.parseInt(process.env.TELEGRAM_API_ID || '', 10);
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH');

    const { TelegramClient, StringSession } = loadTelegramDeps();
    const session = new StringSession(process.env.TELEGRAM_SESSION || '');
    const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

    if (qr) {
        let qrcode;
        try { qrcode = require('qrcode-terminal'); }
        catch { throw new Error('Missing qrcode-terminal dependency. Run: npm install'); }
        const rl = readline.createInterface({ input, output });
        await client.start({
            phoneNumber: async () => {
                const err = new Error('Restart auth with QR');
                err.errorMessage = 'RESTART_AUTH_WITH_QR';
                throw err;
            },
            phoneCode: async () => '',
            password: async (hint) => process.env.TELEGRAM_PASSWORD || promptHiddenish(rl, `2FA password${hint ? ` (${hint})` : ''}, if any: `),
            qrCode: async ({ token, expires }) => {
                console.log('\nScan this QR in Telegram: Settings → Devices → Link Desktop Device');
                console.log(`Expires: ${new Date(expires * 1000).toISOString()}`);
                qrcode.generate(telegramQrLoginUrl(token), { small: true });
            },
            onError: (err) => { console.error('[telegram-live] login error:', err.message); },
        });
        rl.close();
        console.log('\nTELEGRAM_SESSION=' + client.session.save());
    } else if (login || !process.env.TELEGRAM_SESSION) {
        const rl = readline.createInterface({ input, output });
        await client.start({
            phoneNumber: async () => process.env.TELEGRAM_PHONE || promptHiddenish(rl, 'Telegram phone: '),
            password: async () => process.env.TELEGRAM_PASSWORD || promptHiddenish(rl, '2FA password, if any: '),
            phoneCode: async () => process.env.TELEGRAM_CODE || promptHiddenish(rl, 'Login code: '),
            onError: (err) => console.error('[telegram-live] login error:', err.message),
        });
        rl.close();
        console.log('\nTELEGRAM_SESSION=' + client.session.save());
    } else {
        await client.connect();
        if (!(await client.isUserAuthorized())) {
            throw new Error('TELEGRAM_SESSION is not authorized. Re-run with --login.');
        }
    }

    return client;
}

function shouldIncludeDialog(dialog, { includeGroups = true } = {}) {
    if (dialog?.isGroup && !includeGroups) return false;
    return true;
}

async function fetchLiveTelegram({ login = false, qr = false } = {}) {
    const client = await createClient({ login, qr });
    const safeMode = sourceSafeMode('telegram');
    const dialogLimit = safeInt('telegram', 'DIALOG_LIMIT', 100, 300, { min: 1, max: 5000 });
    const messageLimit = safeInt('telegram', 'MESSAGE_LIMIT', 50, 200, { min: 0, max: 5000 });
    const dialogDelayMs = safeInt('telegram', 'DIALOG_DELAY_MS', 1000, 100, { min: 0, max: 60000 });
    const includeGroups = process.env.TELEGRAM_INCLUDE_GROUPS !== '0';
    console.error(`Telegram safe mode: ${safeMode ? 'on' : 'off'} · dialogs=${dialogLimit} · messagesPerDialog=${messageLimit} · dialogDelayMs=${dialogDelayMs} · groups=${includeGroups ? 'included' : 'excluded'}`);

    const contactsRaw = await fetchContacts(client);
    const contacts = contactsRaw.map(normalizeContact);

    const dialogsRaw = await client.getDialogs({ limit: dialogLimit });
    const dialogs = [];
    for (const dialog of dialogsRaw) {
        if (!shouldIncludeDialog(dialog, { includeGroups })) continue;
        const entity = dialog.entity || dialog.inputEntity;
        if (!entity) continue;
        const messages = messageLimit > 0 ? await client.getMessages(entity, { limit: messageLimit }) : [];
        dialogs.push(normalizeDialog(dialog, Array.from(messages || [])));
        if (dialogDelayMs > 0) await sleep(dialogDelayMs);
    }

    await client.disconnect();
    return { contacts, chats: dialogs };
}

async function run(options = {}) {
    P.startProgress(DATA_DIR, 'telegram', { message: 'Connecting to live Telegram…', step: 'connect' });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    try {
        const { contacts, chats } = await fetchLiveTelegram(options);
        fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), JSON.stringify(contacts, null, 2));
        fs.writeFileSync(path.join(OUT_DIR, 'chats.json'), JSON.stringify(chats, null, 2));
        const msgCount = chats.reduce((n, c) => n + (c.messages || []).length, 0);
        P.finishProgress(DATA_DIR, 'telegram', {
            message: `Live Telegram synced ${contacts.length} contacts and ${msgCount} messages across ${chats.length} chats.`,
            current: chats.length,
            total: chats.length,
            itemsProcessed: msgCount,
        });
        console.log(`[telegram-live] contacts=${contacts.length} chats=${chats.length} messages=${msgCount}`);
        return { contacts: contacts.length, chats: chats.length, messages: msgCount };
    } catch (e) {
        P.failProgress(DATA_DIR, 'telegram', e);
        throw e;
    }
}

if (require.main === module) {
    run({ login: process.argv.includes('--login'), qr: process.argv.includes('--qr') })
        .catch(e => {
            console.error('[telegram-live]', e.message);
            process.exit(1);
        });
}

module.exports = {
    asId,
    entityName,
    toIsoDate,
    telegramQrLoginUrl,
    normalizeContact,
    normalizeMessage,
    normalizeDialog,
    fetchContacts,
    shouldIncludeDialog,
    fetchLiveTelegram,
    run,
};
