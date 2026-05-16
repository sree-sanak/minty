'use strict';

/**
 * Local-file-only Slack export importer.
 *
 * This reads Slack export JSON from disk, normalizes only DMs and MPIMs, and
 * writes local artifacts that feed Minty's existing merge/source-health paths.
 * It intentionally has no provider API, OAuth, webhook, scraping, or send hooks.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../_shared/progress');

const DEFAULT_EXPORT_DIR = process.env.SLACK_EXPORT_DIR || path.join(__dirname, '../../data/slack/export');
const DEFAULT_OUT_DIR = process.env.SLACK_OUT_DIR || path.join(__dirname, '../../data/slack');
const DEFAULT_DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '../../data');

function stableHash(prefix, value) {
    return `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12)}`;
}

function safeSlackUserRef(id) {
    return stableHash('slack_user', id);
}

function safeSlackConversationRef(id) {
    return stableHash('slack_conv', id);
}

function safeSlackMessageRef(id) {
    return stableHash('slack_msg', id);
}

function userId(value) {
    if (!value) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object' && value.id) return String(value.id);
    return null;
}

function displayName(user) {
    if (!user || typeof user !== 'object') return null;
    const profile = user.profile && typeof user.profile === 'object' ? user.profile : {};
    const raw = profile.real_name || user.real_name || user.realName || null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function isoFromMillis(millis) {
    if (!Number.isFinite(millis)) return null;
    const parsed = new Date(millis);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function strictIsoTimestamp(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
    if (!match) return null;
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

function slackTimestamp(message) {
    const raw = message && (message.ts || message.timestamp || message.date || message.createdAt || message.created_at);
    if (typeof raw === 'number' && Number.isFinite(raw)) return isoFromMillis(raw * 1000);
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const trimmed = raw.trim();
    if (/^\d{10}(?:\.\d{1,6})?$/.test(trimmed)) {
        return isoFromMillis(Number(trimmed) * 1000);
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
        return strictIsoTimestamp(trimmed);
    }
    return null;
}

function isSkippedUser(id, user, selfIds) {
    if (!id || selfIds.has(id)) return true;
    if (String(id).toUpperCase() === 'USLACKBOT') return true;
    if (!user || typeof user !== 'object') return false;
    const name = String(user.name || '').trim().toLowerCase();
    const realName = String(user.real_name || user.realName || '').trim().toLowerCase();
    return user.is_bot === true || user.deleted === true || name === 'slackbot' || realName === 'slackbot';
}

function normalizeConversationType(rawType) {
    const raw = String(rawType || '').toLowerCase();
    if (['dm', 'direct', 'direct_message', 'directmessage'].includes(raw)) return 'direct';
    if (['mpim', 'group_dm', 'direct_group', 'group_direct'].includes(raw)) return 'mpim';
    return null;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeMessageBody(value, extraSlackRefs = []) {
    if (typeof value !== 'string' || !value.trim()) return '';
    let cleaned = value;
    for (const ref of extraSlackRefs) {
        if (typeof ref !== 'string' || !ref.trim()) continue;
        cleaned = cleaned.replace(new RegExp(`(^|\\s)[@#]?${escapeRegExp(ref.trim())}\\b`, 'gi'), '$1[slack-ref]');
    }
    return cleaned
        .replace(/<[@#!][^>]+>/g, '[slack-ref]')
        .replace(/(^|\s)[@#][a-z0-9][a-z0-9._-]{1,80}\b/gi, '$1[slack-ref]')
        .replace(/\bx(?:ox|app|oxa|oxb|oxp|oxs)[a-z0-9-]*-[A-Za-z0-9._-]+\b/gi, '[redacted-secret]')
        .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [redacted-secret]')
        .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd)\s*[:=]\s*(?:"[^"]+"|'[^']+'|\S+)/gi, '[redacted-secret]')
        .replace(/\b[A-Z][A-Z0-9_]{3,}\b/g, '[slack-ref]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
        .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, '[url]')
        .replace(/\b[a-zA-Z]:\\(?:[^\s]+\\?)+/g, '[path]')
        .replace(/(^|\s)\/(?:Users|home|root|tmp|var|private|etc)\/[^\s]+/g, '$1[path]')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeProfileText(value, fallback = null) {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const cleaned = sanitizeMessageBody(value);
    return cleaned || fallback;
}

function updateContactSeen(contact, timestamp) {
    if (!contact.firstSeen || timestamp < contact.firstSeen) contact.firstSeen = timestamp;
    if (!contact.lastMessageAt || timestamp > contact.lastMessageAt) contact.lastMessageAt = timestamp;
}

function normalizeSlackExport(data, options = {}) {
    const users = new Map();
    for (const user of data?.users || []) {
        const id = userId(user);
        if (id) users.set(id, user);
    }

    const selfIds = new Set((options.selfUserIds || data?.selfUserIds || data?.self_user_ids || []).map(String));
    const contactsByRef = new Map();
    const conversations = [];
    const messages = [];
    const diagnostics = { skippedConversations: 0, skippedMessages: 0, skippedParticipants: 0 };

    const rawConversations = [];
    for (const dm of data?.dms || []) rawConversations.push({ ...dm, type: 'dm' });
    for (const mpim of data?.mpims || []) rawConversations.push({ ...mpim, type: 'mpim' });
    for (const conv of data?.conversations || []) rawConversations.push(conv);
    const knownSlackRefs = rawConversations
        .map(conv => (typeof conv?.name === 'string' ? conv.name.trim() : ''))
        .filter(Boolean);

    const messagesByConversation = data?.messagesByConversation || data?.messages_by_conversation || {};

    for (const conv of rawConversations) {
        const type = normalizeConversationType(conv?.type || conv?.conversationType);
        const convId = conv && conv.id ? String(conv.id) : null;
        if (!convId || !type) {
            diagnostics.skippedConversations += 1;
            continue;
        }

        const rawMemberIds = (conv.members || conv.participants || conv.recipients || []).map(userId).filter(Boolean);
        const participantRefs = [];
        for (const memberId of rawMemberIds) {
            const user = users.get(memberId);
            if (isSkippedUser(memberId, user, selfIds)) continue;
            const name = sanitizeProfileText(displayName(user), 'Slack contact');
            if (!name) {
                diagnostics.skippedParticipants += 1;
                continue;
            }
            const ref = safeSlackUserRef(memberId);
            participantRefs.push(ref);
            if (!contactsByRef.has(ref)) {
                contactsByRef.set(ref, {
                    id: ref,
                    source: 'slack',
                    userId: ref,
                    slackId: ref,
                    slackRef: ref,
                    name,
                    displayName: name,
                    realName: name,
                    email: null,
                    title: sanitizeProfileText(user?.profile?.title, null),
                    workspace: null,
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

        const normalizedConversation = {
            id: safeSlackConversationRef(convId),
            source: 'slack',
            type: type === 'mpim' ? 'mpim' : 'direct',
            chatName: type === 'mpim' ? 'Slack direct group' : 'Slack DM',
            channelId: safeSlackConversationRef(convId),
            participantRefs,
            participantCount: rawMemberIds.length,
            messages: [],
        };

        const rows = Array.isArray(messagesByConversation[convId]) ? messagesByConversation[convId] : [];
        for (const msg of rows) {
            const timestamp = slackTimestamp(msg);
            const authorId = userId(msg?.user || msg?.from || msg?.user_id || msg?.authorId || msg?.author_id);
            const author = users.get(authorId);
            const subtype = String(msg?.subtype || '').toLowerCase();
            if (!timestamp || !authorId || subtype === 'bot_message' || isSkippedUser(authorId, author, new Set())) {
                diagnostics.skippedMessages += 1;
                continue;
            }
            const from = selfIds.has(authorId) ? 'me' : safeSlackUserRef(authorId);
            const rawBody = typeof msg.text === 'string'
                ? msg.text
                : (typeof msg.body === 'string' ? msg.body : '');
            const body = sanitizeMessageBody(rawBody, knownSlackRefs);
            const to = from === 'me'
                ? (participantRefs.length === 1 ? participantRefs[0] : participantRefs.slice())
                : 'me';
            const normalized = {
                id: safeSlackMessageRef(`${convId}:${msg.ts || msg.id || timestamp}:${authorId}`),
                source: 'slack',
                timestamp,
                from,
                to,
                body,
                type: normalizedConversation.type,
                chatId: normalizedConversation.id,
                channelId: normalizedConversation.channelId,
                chatName: normalizedConversation.chatName,
                isDirect: normalizedConversation.type === 'direct',
            };
            normalizedConversation.messages.push(normalized);
            messages.push(normalized);
            if (from !== 'me' && contactsByRef.has(from)) {
                const contact = contactsByRef.get(from);
                contact.messageCount += 1;
                updateContactSeen(contact, timestamp);
            }
        }

        conversations.push(normalizedConversation);
    }

    return { contacts: Array.from(contactsByRef.values()), conversations, messages, diagnostics };
}

function readJsonIfExists(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error('Slack export JSON could not be parsed');
    }
}

function readConversationMessages(exportDir, conversations) {
    const messagesByConversation = {};
    const exportRoot = path.resolve(exportDir);
    let exportRootReal;
    try {
        exportRootReal = fs.realpathSync(exportRoot);
    } catch (err) {
        exportRootReal = exportRoot;
    }
    for (const conv of conversations) {
        if (!conv || !conv.id) continue;
        const convId = String(conv.id);
        messagesByConversation[convId] = [];
        if (convId.includes('/') || convId.includes('\\')) continue;
        const convDir = path.resolve(exportRoot, convId);
        if (convDir !== exportRoot && !convDir.startsWith(exportRoot + path.sep)) continue;
        if (!fs.existsSync(convDir)) continue;
        let stat;
        try {
            stat = fs.lstatSync(convDir);
        } catch (err) {
            continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        let convDirReal;
        try {
            convDirReal = fs.realpathSync(convDir);
        } catch (err) {
            continue;
        }
        if (convDirReal !== exportRootReal && !convDirReal.startsWith(exportRootReal + path.sep)) continue;
        let files;
        try {
            files = fs.readdirSync(convDir).filter(name => name.endsWith('.json')).sort();
        } catch (err) {
            continue;
        }
        for (const file of files) {
            const filePath = path.resolve(convDir, file);
            if (!filePath.startsWith(convDir + path.sep)) continue;
            let fileStat;
            let fileReal;
            try {
                fileStat = fs.lstatSync(filePath);
                if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
                fileReal = fs.realpathSync(filePath);
            } catch (err) {
                continue;
            }
            if (!fileReal.startsWith(convDirReal + path.sep)) continue;
            const rows = readJsonIfExists(filePath, []);
            if (Array.isArray(rows)) messagesByConversation[convId].push(...rows);
        }
    }
    return messagesByConversation;
}

function parseSelfUserIds(value) {
    return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}

function runSlackImport(options = {}) {
    const exportDir = options.exportDir || DEFAULT_EXPORT_DIR;
    const outDir = options.outDir || DEFAULT_OUT_DIR;
    const dataDir = options.dataDir || DEFAULT_DATA_DIR;
    const progress = options.progress === undefined ? P : options.progress;
    const logger = options.logger || console;

    if (progress) progress.startProgress(dataDir, 'slack', { step: 'init', message: 'Reading Slack export…' });
    let exportStat;
    try {
        exportStat = fs.existsSync(exportDir) ? fs.statSync(exportDir) : null;
    } catch (err) {
        exportStat = null;
    }
    if (!exportStat || !exportStat.isDirectory()) {
        const err = new Error('Slack export directory was not found');
        if (progress) progress.failProgress(dataDir, 'slack', err);
        throw err;
    }

    let result;
    try {
        const users = readJsonIfExists(path.join(exportDir, 'users.json'), []);
        const dms = readJsonIfExists(path.join(exportDir, 'dms.json'), []);
        const mpims = readJsonIfExists(path.join(exportDir, 'mpims.json'), []);
        const messagesByConversation = readConversationMessages(exportDir, [...dms, ...mpims]);

        if (progress) progress.updateProgress(dataDir, 'slack', { step: 'messages', message: 'Normalizing Slack DMs…' });
        result = normalizeSlackExport({ users, dms, mpims, messagesByConversation }, {
            selfUserIds: options.selfUserIds || parseSelfUserIds(process.env.SLACK_SELF_USER_IDS),
        });
    } catch (err) {
        const safeError = /Slack export JSON could not be parsed/.test(err.message)
            ? err
            : new Error('Slack export could not be imported');
        if (progress) progress.failProgress(dataDir, 'slack', safeError);
        throw safeError;
    }

    try {
        fs.mkdirSync(path.join(outDir, 'messages'), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'contacts.json'), JSON.stringify(result.contacts, null, 2));
        fs.writeFileSync(path.join(outDir, 'messages', 'messages.json'), JSON.stringify(result.messages, null, 2));
    } catch (err) {
        const safeError = new Error('Slack import artifacts could not be written');
        if (progress) progress.failProgress(dataDir, 'slack', safeError);
        throw safeError;
    }

    logger.log(`Saved ${result.contacts.length} Slack contacts`);
    logger.log(`Saved ${result.messages.length} Slack messages across ${result.conversations.length} conversations`);
    if (progress) {
        progress.finishProgress(dataDir, 'slack', {
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
        runSlackImport();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    normalizeSlackExport,
    safeSlackUserRef,
    safeSlackConversationRef,
    safeSlackMessageRef,
    runSlackImport,
};
