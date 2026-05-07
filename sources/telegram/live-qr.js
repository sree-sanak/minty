#!/usr/bin/env node
/**
 * Telegram live QR login helper.
 *
 * Usage:
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:live:qr
 *
 * Prints a TELEGRAM_SESSION string that can be saved in the Minty daemon env.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const qrcode = require('qrcode-terminal');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const ROOT = path.join(__dirname, '../..');
const ENV_PATH = process.env.MINTY_ENV_FILE || path.join(ROOT, '.env');

function loadDotEnv(file = ENV_PATH) {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const [, key, raw] = match;
        if (process.env[key] !== undefined) continue;
        process.env[key] = raw.replace(/^['"]|['"]$/g, '');
    }
}

function upsertDotEnv(values, file = ENV_PATH) {
    let existing = '';
    try {
        existing = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const lines = existing ? existing.split(/\r?\n/) : [];
    const seen = new Set();
    const next = lines.map(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match || !(match[1] in values)) return line;
        seen.add(match[1]);
        return `${match[1]}=${values[match[1]]}`;
    });
    for (const [key, value] of Object.entries(values)) {
        if (!seen.has(key)) next.push(`${key}=${value}`);
    }
    fs.writeFileSync(file, next.filter((line, i, arr) => !(line === '' && i === arr.length - 1)).join('\n') + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        console.error(`Missing ${name}. Get TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org/apps`);
        process.exit(1);
    }
    return value;
}

function askHidden(query) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const onData = char => {
            char = String(char);
            if (char === '\n' || char === '\r' || char === '\u0004') return;
            readline.moveCursor(process.stdout, -1, 0);
            process.stdout.write('*');
        };
        process.stdin.on('data', onData);
        rl.question(query, answer => {
            process.stdin.off('data', onData);
            rl.close();
            process.stdout.write('\n');
            resolve(answer.trim());
        });
    });
}

async function run() {
    loadDotEnv();
    const apiIdRaw = requireEnv('TELEGRAM_API_ID');
    const apiId = Number(apiIdRaw);
    const apiHash = requireEnv('TELEGRAM_API_HASH');

    if (!Number.isInteger(apiId)) {
        console.error(`TELEGRAM_API_ID must be an integer, got: ${apiIdRaw}`);
        process.exit(1);
    }

    const session = new StringSession(process.env.TELEGRAM_SESSION || '');
    const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

    await client.connect();
    if (await client.isUserAuthorized()) {
        const saved = client.session.save();
        console.log('Already authorized. Current session:');
        console.log(`TELEGRAM_SESSION=${saved}`);
        if (process.argv.includes('--save') || process.env.MINTY_SAVE_TELEGRAM_SESSION === '1') {
            upsertDotEnv({ TELEGRAM_API_ID: String(apiId), TELEGRAM_API_HASH: apiHash, TELEGRAM_SESSION: saved });
            console.log(`Saved Telegram credentials to ${ENV_PATH}`);
        }
        await client.disconnect();
        return;
    }

    console.log('Scan this QR from Telegram: Settings → Devices → Link Desktop Device');
    console.log('Waiting for scan/approval…\n');

    const user = await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
            qrCode: async ({ token, expires }) => {
                const url = `tg://login?token=${token.toString('base64url')}`;
                console.log(`QR expires at: ${expires instanceof Date ? expires.toISOString() : expires}`);
                qrcode.generate(url, { small: true });
            },
            password: async hint => {
                const label = hint ? `Telegram 2FA password (${hint}): ` : 'Telegram 2FA password: ';
                return askHidden(label);
            },
            onError: async error => {
                console.error('Telegram QR login error:', error && (error.message || error));
                return false;
            },
        }
    );

    console.log(`Logged in as ${user && (user.username || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.id)}`);
    console.log('\nSave this in the Minty daemon env:');
    const saved = client.session.save();
    console.log(`TELEGRAM_SESSION=${saved}`);
    if (process.argv.includes('--save') || process.env.MINTY_SAVE_TELEGRAM_SESSION === '1') {
        upsertDotEnv({ TELEGRAM_API_ID: String(apiId), TELEGRAM_API_HASH: apiHash, TELEGRAM_SESSION: saved });
        console.log(`Saved Telegram credentials to ${ENV_PATH}`);
    }

    await client.disconnect();
}

if (require.main === module) {
    run().catch(error => {
        console.error(error && (error.stack || error.message) || error);
        process.exit(1);
    });
}

module.exports = { loadDotEnv, upsertDotEnv, requireEnv, askHidden, run };
