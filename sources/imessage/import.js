'use strict';

/**
 * Local-file-only iMessage export importer.
 *
 * This first slice reads a synthetic/local JSON export from disk and writes
 * privacy-safe local artifacts for Minty's merge and source-health paths. It
 * intentionally has no live provider, account, attachment, scrape, or send hooks.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../_shared/progress');

const DEFAULT_EXPORT_FILE = process.env.IMESSAGE_EXPORT_FILE || path.join(__dirname, '../../data/imessage/export/export.json');
const DEFAULT_OUT_DIR = process.env.IMESSAGE_OUT_DIR || path.join(__dirname, '../../data/imessage');
const DEFAULT_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function stableHash(prefix, value) {
    return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)}`;
}

function safeIMessageContactRef(id) {
    return stableHash('imessage_contact', id);
}

function safeIMessageChatRef(id) {
    return stableHash('imessage_chat', id);
}

function safeIMessageMessageRef(id) {
    return stableHash('imessage_msg', id);
}

function strictIsoTimestamp(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value.trim());
    if (!match || value !== value.trim()) return null;
    const [, y, mo, d, h, mi, s, fraction = '0'] = match;
    const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3));
    const millis = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millisecond);
    const parsed = new Date(millis);
    if (!Number.isFinite(parsed.getTime())) return null;
    if (parsed.getUTCFullYear() !== Number(y)
        || parsed.getUTCMonth() !== Number(mo) - 1
        || parsed.getUTCDate() !== Number(d)
        || parsed.getUTCHours() !== Number(h)
        || parsed.getUTCMinutes() !== Number(mi)
        || parsed.getUTCSeconds() !== Number(s)
        || parsed.getUTCMilliseconds() !== millisecond) {
        return null;
    }
    return parsed.toISOString();
}

function timestampFromMessage(message) {
    const raw = message && (message.timestamp || message.date || message.createdAt || message.created_at);
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const millis = raw > 9999999999 ? raw : raw * 1000;
        const parsed = new Date(millis);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }
    return strictIsoTimestamp(raw);
}

function handleId(value) {
    if (!value) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && value.id) return String(value.id);
    return null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeText(value, extraRefs = []) {
    if (typeof value !== 'string' || !value.trim()) return '';
    let cleaned = value;
    for (const ref of extraRefs) {
        if (typeof ref !== 'string' || !ref.trim()) continue;
        cleaned = cleaned.replace(new RegExp(escapeRegExp(ref.trim()), 'gi'), '[imessage-ref]');
    }
    return cleaned
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\+?\b\d[\d\s().-]{6,}\d\b/g, '[phone]')
        .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, '[url]')
        .replace(/\b[a-zA-Z]:\\(?:[^\s]+\\?)+/g, '[path]')
        .replace(/(^|\s)\/(?:Users|home|root|tmp|var|private|etc)\/[^\s]+/g, '$1[path]')
        .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted-secret]')
        .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*[:=]?\s*(?:"[^"]+"|'[^']+'|[A-Za-z0-9._-]{6,})/gi, '[redacted-secret]')
        .replace(/\s+/g, ' ')
        .trim();
}

function contactName(handle) {
    const raw = handle && (handle.displayName || handle.name || handle.label);
    const cleaned = sanitizeText(raw || '', [handle?.id, handle?.value]).trim();
    return cleaned || 'iMessage contact';
}

function normalizeChatType(raw) {
    const value = String(raw || '').toLowerCase();
    if (['direct', 'dm', 'one_to_one', 'one-to-one'].includes(value)) return 'direct';
    if (['group', 'mpim', 'group_dm', 'direct_group'].includes(value)) return 'group';
    return null;
}

function normalizeIMessageExport(data) {
    const handles = new Map();
    for (const handle of data?.handles || []) {
        const id = handleId(handle);
        if (id) handles.set(id, handle);
    }

    const selfHandles = new Set((data?.selfHandles || data?.self_handles || []).map(String));
    const contactsByRef = new Map();
    const conversations = [];
    const messages = [];
    const diagnostics = { skippedChats: 0, skippedMessages: 0, skippedParticipants: 0 };
    const knownRefs = [];
    for (const handle of handles.values()) {
        if (handle?.id) knownRefs.push(String(handle.id));
        if (handle?.value) knownRefs.push(String(handle.value));
    }

    for (const chat of data?.chats || data?.conversations || []) {
        const rawChatId = chat && (chat.id || chat.chatId || chat.guid);
        const type = normalizeChatType(chat?.type || chat?.chatType || (Array.isArray(chat?.participants) && chat.participants.length > 2 ? 'group' : 'direct'));
        if (!rawChatId || !type) {
            diagnostics.skippedChats += 1;
            continue;
        }

        const participantIds = (chat.participants || chat.handles || [])
            .map(handleId)
            .filter(Boolean);
        const participantRefs = [];
        for (const participantId of participantIds) {
            if (selfHandles.has(participantId)) continue;
            const handle = handles.get(participantId) || { id: participantId };
            const ref = safeIMessageContactRef(participantId);
            participantRefs.push(ref);
            if (!contactsByRef.has(ref)) {
                contactsByRef.set(ref, {
                    id: ref,
                    source: 'imessage',
                    imessageRef: ref,
                    name: contactName(handle),
                    displayName: contactName(handle),
                    firstSeen: null,
                    lastMessageAt: null,
                    messageCount: 0,
                });
            }
        }

        if (participantRefs.length === 0) {
            diagnostics.skippedChats += 1;
            continue;
        }

        const normalizedChat = {
            id: safeIMessageChatRef(rawChatId),
            source: 'imessage',
            type,
            chatName: type === 'group' ? 'iMessage direct group' : 'iMessage conversation',
            participantRefs,
            messages: [],
        };

        for (const message of chat.messages || []) {
            const timestamp = timestampFromMessage(message);
            const authorId = handleId(message.handleId || message.handle_id || message.from || message.sender);
            if (!timestamp || !authorId) {
                diagnostics.skippedMessages += 1;
                continue;
            }
            const from = selfHandles.has(authorId) ? 'me' : safeIMessageContactRef(authorId);
            const body = sanitizeText(typeof message.text === 'string' ? message.text : message.body, knownRefs);
            const normalized = {
                id: safeIMessageMessageRef(`${rawChatId}:${message.id || message.guid || timestamp}:${authorId}`),
                source: 'imessage',
                timestamp,
                from,
                to: from === 'me' ? (participantRefs.length === 1 ? participantRefs[0] : participantRefs.slice()) : 'me',
                body,
                type,
                chatId: normalizedChat.id,
                chatName: normalizedChat.chatName,
                isDirect: type === 'direct',
            };
            normalizedChat.messages.push(normalized);
            messages.push(normalized);
            if (from !== 'me' && contactsByRef.has(from)) {
                const contact = contactsByRef.get(from);
                contact.messageCount += 1;
                if (!contact.firstSeen || timestamp < contact.firstSeen) contact.firstSeen = timestamp;
                if (!contact.lastMessageAt || timestamp > contact.lastMessageAt) contact.lastMessageAt = timestamp;
            }
        }

        conversations.push(normalizedChat);
    }

    return {
        source: 'imessage',
        contacts: Array.from(contactsByRef.values()),
        conversations,
        messages,
        diagnostics,
    };
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function runIMessageImport(options = {}) {
    const exportFile = options.exportFile || DEFAULT_EXPORT_FILE;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const progress = options.progress === undefined ? P : options.progress;
    const logger = options.logger || console;

    if (progress) progress.startProgress(dataDir, 'imessage', { step: 'init', message: 'Reading iMessage export…' });

    if (!fs.existsSync(exportFile)) {
        const err = new Error('iMessage export JSON was not found');
        if (progress) progress.failProgress(dataDir, 'imessage', err);
        throw err;
    }

    let raw;
    try {
        raw = readJson(exportFile);
    } catch (_err) {
        const err = new Error('iMessage export JSON could not be parsed');
        if (progress) progress.failProgress(dataDir, 'imessage', err);
        throw err;
    }

    if (progress) progress.updateProgress(dataDir, 'imessage', { step: 'messages', message: 'Normalizing iMessage conversations…' });
    const result = normalizeIMessageExport(raw);
    try {
        writeJson(path.join(outDir, 'contacts.json'), result.contacts);
        writeJson(path.join(outDir, 'conversations.json'), result.conversations);
        writeJson(path.join(outDir, 'messages', 'messages.json'), result.messages);
    } catch (_err) {
        const err = new Error('iMessage artifacts could not be written');
        if (progress) progress.failProgress(dataDir, 'imessage', err);
        throw err;
    }

    if (progress) {
        progress.finishProgress(dataDir, 'imessage', {
            contacts: result.contacts.length,
            messages: result.messages.length,
            skippedMessages: result.diagnostics.skippedMessages,
        });
    }
    if (logger && typeof logger.log === 'function') {
        logger.log(`Imported ${result.contacts.length} iMessage contacts and ${result.messages.length} messages`);
    }
    return result;
}

function main() {
    runIMessageImport();
}

if (require.main === module) {
    main();
}

module.exports = {
    normalizeIMessageExport,
    runIMessageImport,
    safeIMessageContactRef,
    safeIMessageChatRef,
    safeIMessageMessageRef,
    sanitizeText,
    strictIsoTimestamp,
};
