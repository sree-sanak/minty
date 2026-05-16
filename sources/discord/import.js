'use strict';

/**
 * Local-file-only Discord export importer.
 *
 * This intentionally accepts synthetic/export-style JSON files and writes only
 * local normalized artifacts. It never talks to Discord, never needs tokens,
 * and normalizes raw upstream ids into stable opaque refs before persistence.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../_shared/progress');

const DEFAULT_EXPORT_FILE = process.env.DISCORD_EXPORT_FILE || path.join(__dirname, '../../data/discord/export/export.json');
const DEFAULT_OUT_DIR = process.env.DISCORD_OUT_DIR || path.join(__dirname, '../../data/discord');
const DEFAULT_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function stableHash(prefix, value) {
    return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)}`;
}

function safeDiscordUserRef(id) {
    return stableHash('discord_user', id);
}

function safeDiscordThreadRef(id) {
    return stableHash('discord_thread', id);
}

function safeDiscordMessageRef(id) {
    return stableHash('discord_msg', id);
}

function parseIso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function displayName(user) {
    if (!user || typeof user !== 'object') return null;
    const raw = user.global_name || user.globalName || user.displayName || user.name || user.username || null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function userId(value) {
    if (!value) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && value.id) return String(value.id);
    return null;
}

function conversationType(conv) {
    const raw = String(conv?.type || conv?.channelType || '').toLowerCase();
    if (['dm', 'direct', 'direct_message', 'private'].includes(raw)) return 'dm';
    if (['group_dm', 'direct_group', 'group_direct', 'private_group'].includes(raw)) return 'group_dm';
    return null;
}

function normalizeDiscordExport(data, options = {}) {
    const users = new Map();
    for (const user of data?.users || data?.relationships || []) {
        const id = userId(user);
        if (id) users.set(id, user);
    }

    const selfIds = new Set((options.selfUserIds || data?.selfUserIds || data?.self_user_ids || []).map(String));
    const contactsByRef = new Map();
    const threads = [];
    const messages = [];
    const diagnostics = { skippedConversations: 0, skippedMessages: 0, skippedParticipants: 0 };

    const conversations = data?.conversations || data?.channels || [];
    for (const conv of conversations) {
        const type = conversationType(conv);
        if (!conv || !type || !conv.id) {
            diagnostics.skippedConversations += 1;
            continue;
        }

        const rawParticipantIds = (conv.participants || conv.recipients || []).map(userId).filter(Boolean);
        const participantRefs = [];
        for (const participantId of rawParticipantIds) {
            if (selfIds.has(participantId)) continue;
            const name = displayName(users.get(participantId));
            if (!name) {
                diagnostics.skippedParticipants += 1;
                continue;
            }
            const ref = safeDiscordUserRef(participantId);
            participantRefs.push(ref);
            if (!contactsByRef.has(ref)) {
                contactsByRef.set(ref, {
                    id: ref,
                    source: 'discord',
                    name,
                    discordRef: ref,
                    firstSeen: null,
                    lastMessageAt: null,
                    messageCount: 0,
                });
            }
        }

        if (participantRefs.length === 0) {
            diagnostics.skippedConversations += 1;
            continue;
        }

        const thread = {
            id: safeDiscordThreadRef(conv.id),
            source: 'discord',
            type,
            chatName: type === 'group_dm' ? 'Discord direct group' : 'Discord DM',
            participantRefs,
            participantCount: rawParticipantIds.length,
            messages: [],
        };

        for (const msg of conv.messages || []) {
            const timestamp = parseIso(msg?.timestamp || msg?.date || msg?.createdAt || msg?.created_at);
            const authorId = userId(msg?.authorId || msg?.author_id || msg?.author);
            if (!timestamp || !authorId) {
                diagnostics.skippedMessages += 1;
                continue;
            }
            const from = selfIds.has(authorId) ? 'me' : safeDiscordUserRef(authorId);
            const body = typeof msg.content === 'string'
                ? msg.content
                : (typeof msg.body === 'string' ? msg.body : '');
            const normalized = {
                id: safeDiscordMessageRef(`${conv.id}:${msg.id || msg.messageId || timestamp}:${authorId}`),
                source: 'discord',
                timestamp,
                from,
                to: from === 'me' && participantRefs.length === 1 ? participantRefs[0] : 'me',
                body,
                type: thread.type,
                chatId: thread.id,
                chatName: thread.chatName,
            };
            thread.messages.push(normalized);
            messages.push(normalized);
            if (from !== 'me' && contactsByRef.has(from)) {
                const contact = contactsByRef.get(from);
                contact.messageCount += 1;
                contact.firstSeen = contact.firstSeen || timestamp;
                contact.lastMessageAt = timestamp;
            }
        }

        threads.push(thread);
    }

    return { contacts: Array.from(contactsByRef.values()), threads, messages, diagnostics };
}

function parseSelfUserIds(value) {
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function runDiscordImport(options = {}) {
    const exportFile = options.exportFile || DEFAULT_EXPORT_FILE;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const progress = options.progress === undefined ? P : options.progress;
    const logger = options.logger || console;

    if (progress) progress.startProgress(dataDir, 'discord', { step: 'init', message: 'Reading Discord export…' });
    if (!fs.existsSync(exportFile)) {
        const err = new Error(`Discord export not found: ${exportFile}`);
        if (progress) progress.failProgress(dataDir, 'discord', new Error('Discord export file was not found'));
        throw err;
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    } catch (err) {
        if (progress) progress.failProgress(dataDir, 'discord', new Error('Discord export JSON could not be parsed'));
        throw err;
    }

    if (progress) progress.updateProgress(dataDir, 'discord', { step: 'messages', message: 'Normalizing Discord DMs…' });
    const result = normalizeDiscordExport(parsed, {
        selfUserIds: options.selfUserIds || parseSelfUserIds(process.env.DISCORD_SELF_USER_IDS),
    });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(result.contacts, null, 2));
    fs.writeFileSync(path.join(outDir, 'messages.json'), JSON.stringify(result.threads, null, 2));

    logger.log(`Saved ${result.contacts.length} Discord contacts`);
    logger.log(`Saved ${result.messages.length} Discord messages across ${result.threads.length} threads`);
    if (progress) {
        progress.finishProgress(dataDir, 'discord', {
            message: `Imported ${result.contacts.length} contacts and ${result.messages.length} messages.`,
            current: result.messages.length,
            total: result.messages.length,
            itemsProcessed: result.messages.length,
        });
    }
    return result;
}

if (require.main === module) {
    try {
        runDiscordImport();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    normalizeDiscordExport,
    safeDiscordUserRef,
    safeDiscordThreadRef,
    safeDiscordMessageRef,
    runDiscordImport,
};
