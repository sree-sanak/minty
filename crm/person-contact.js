/**
 * crm/person-contact.js — shared person/non-person contact guards.
 *
 * Agent-facing and evidence-generating paths must not treat groups, channels,
 * broadcasts, newsletters, or mailing lists as people, even when upstream ingest
 * represents them with slightly different flag or type fields.
 */

'use strict';

const NON_PERSON_TYPES = new Set([
    'group',
    'channel',
    'broadcast',
    'list',
    'mailing_list',
    'mailing-list',
    'distribution_list',
    'distribution-list',
    'newsletter',
    'community',
]);

const NON_PERSON_JID_SUFFIXES = [
    '@g.us',
    '@broadcast',
    '@newsletter',
];

function normalized(value) {
    return String(value || '').toLowerCase().trim();
}

function hasNonPersonJid(value) {
    const raw = normalized(value);
    return !!raw && NON_PERSON_JID_SUFFIXES.some(suffix => raw.endsWith(suffix) || raw.includes(`${suffix}:`));
}

function hasNonPersonType(value) {
    const type = normalized(value).replace(/\s+/g, '_');
    return NON_PERSON_TYPES.has(type);
}

function hasSlackChannelShape(record) {
    const source = normalized(record.source || record.channel);
    if (source !== 'slack') return false;
    const channelId = String(record.channelId || record.channel_id || record.chatId || '').trim();
    return !!channelId && !/^D[A-Z0-9]+$/.test(channelId);
}

function hasNonPersonShape(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.isGroup || record.isChannel || record.isBroadcast || record.isList || record.isMailingList || record.groupId) return true;
    if (hasSlackChannelShape(record)) return true;
    if (Array.isArray(record.participants) && record.participants.length > 2) return true;

    const typeFields = [
        record.type,
        record.kind,
        record.contactType,
        record.chatType,
        record.conversationType,
        record.threadType,
        record.sourceType,
    ];
    if (typeFields.some(hasNonPersonType)) return true;

    const idFields = [
        record.jid,
        record.chatId,
        record.chat_id,
        record.sourceId,
        record.remoteJid,
        record.id,
    ];
    return idFields.some(hasNonPersonJid);
}

function isNonPersonRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (hasNonPersonShape(record)) return true;
    return Object.values(record.sources || {}).some(hasNonPersonShape);
}

function isPersonContact(contact) {
    return !!(contact && contact.id && !isNonPersonRecord(contact));
}

module.exports = {
    isNonPersonRecord,
    isPersonContact,
};
