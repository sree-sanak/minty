const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    waStableId,
    liStableId,
    slackStableId,
    discordStableId,
    buildPhoneBridge,
    buildInteractionIndex,
    buildInteractions,
    loadSlack,
    loadDiscord,
} = require('../../crm/merge');
const { ContactIndex } = require('../../crm/utils');

// --- waStableId ---

describe('waStableId', () => {
    it('prefixes a phone number with wa_', () => {
        assert.equal(waStableId('15551234567'), 'wa_15551234567');
    });

    it('returns null for falsy input', () => {
        assert.equal(waStableId(null), null);
        assert.equal(waStableId(undefined), null);
        assert.equal(waStableId(''), null);
    });

    it('preserves the raw string without normalizing', () => {
        assert.equal(waStableId('44771234@c.us'), 'wa_44771234@c.us');
    });
});

// --- liStableId ---

describe('liStableId', () => {
    it('extracts slug from full LinkedIn profile URL', () => {
        assert.equal(liStableId('https://www.linkedin.com/in/alex-r'), 'li_alex-r');
    });

    it('strips trailing slashes', () => {
        assert.equal(liStableId('https://www.linkedin.com/in/alex-r/'), 'li_alex-r');
    });

    it('lowercases the slug', () => {
        assert.equal(liStableId('https://www.linkedin.com/in/Alex-R'), 'li_alex-r');
    });

    it('replaces non-alphanumeric chars (except _ and -) with hyphens', () => {
        assert.equal(liStableId('https://www.linkedin.com/in/alex.r!'), 'li_alex-r-');
    });

    it('returns null for null/undefined input', () => {
        assert.equal(liStableId(null), null);
        assert.equal(liStableId(undefined), null);
    });

    it('handles bare slug after /in/', () => {
        assert.equal(liStableId('/in/jane-doe'), 'li_jane-doe');
    });
});

// --- slackStableId / loadSlack ---

describe('Slack source merge', () => {
    it('derives a stable Slack contact id from the member id', () => {
        assert.equal(slackStableId('U123'), 'slack_U123');
        assert.equal(slackStableId(null), null);
    });

    it('loads Slack members as person contacts with source metadata', () => {
        const index = new ContactIndex();
        loadSlack(index, [
            { id: 'U123', displayName: 'Dana Builder', title: 'Founder building AI infrastructure', email: 'dana@example.com' },
            { id: 'B999', displayName: 'Helper Bot', isBot: true },
            { id: 'USLACKBOT', displayName: 'Slackbot', isBot: false },
            { id: 'U456', displayName: 'Deleted Member', isDeleted: true },
        ]);

        assert.equal(index.contacts.length, 1);
        const contact = index.contacts[0];
        assert.equal(contact.id, 'slack_U123');
        assert.equal(contact.name, 'Dana Builder');
        assert.equal(contact.sources.slack.id, 'U123');
        assert.equal(contact.sources.slack.userId, 'U123');
        assert.equal(contact.sources.slack.title, 'Founder building AI infrastructure');
        assert.deepEqual(contact.emails, ['dana@example.com']);
    });
});

// --- buildPhoneBridge ---

describe('Discord source merge', () => {
    it('derives stable local Discord contact ids from safe refs', () => {
        assert.equal(discordStableId('discord_user_abc123'), 'discord_discord_user_abc123');
        assert.equal(discordStableId(null), null);
    });

    it('loads Discord export contacts with source metadata', () => {
        const index = new ContactIndex();
        loadDiscord(index, [
            { id: 'discord_user_abc123', name: 'Ada Example', messageCount: 3, lastMessageAt: '2026-05-01T10:00:00.000Z' },
            { id: 'discord_user_missing_name' },
        ]);

        assert.equal(index.contacts.length, 1);
        const contact = index.contacts[0];
        assert.equal(contact.id, 'discord_discord_user_abc123');
        assert.equal(contact.name, 'Ada Example');
        assert.equal(contact.sources.discord.discordRef, 'discord_user_abc123');
        assert.equal(contact.sources.discord.messageCount, 3);
    });

    it('adds Discord messages to the interaction timeline', () => {
        const interactions = buildInteractions({
            discordThreads: [{
                id: 'discord_thread_abc123',
                type: 'group_dm',
                chatName: 'Discord direct group',
                messages: [{
                    id: 'discord_msg_1',
                    timestamp: '2026-05-01T10:00:00.000Z',
                    from: 'discord_user_abc123',
                    to: 'me',
                    body: 'synthetic local-only discord context',
                }],
            }],
        });

        const discord = interactions.find(i => i.source === 'discord');
        assert.equal(discord.id, 'discord_msg_1');
        assert.equal(discord.chatId, 'discord_thread_abc123');
        assert.equal(discord.chatName, 'Discord direct group');
        assert.equal(discord.from, 'discord_user_abc123');
    });
});

// --- buildPhoneBridge ---

describe('buildPhoneBridge', () => {
    it('maps normalized names to phone sets for linkedin_imported contacts', () => {
        const contacts = [
            { source: 'linkedin_imported', name: 'Alice Smith', phones: ['+1 555-123-4567'] },
        ];
        const bridge = buildPhoneBridge(contacts);
        const key = Object.keys(bridge)[0];
        assert.ok(key, 'should have at least one bridge entry');
        assert.ok(bridge[key] instanceof Set);
        assert.equal(bridge[key].size, 1);
    });

    it('ignores non-imported contacts', () => {
        const contacts = [
            { source: 'linkedin_connection', name: 'Bob', phones: ['+447712345678'] },
        ];
        const bridge = buildPhoneBridge(contacts);
        assert.equal(Object.keys(bridge).length, 0);
    });

    it('ignores contacts without phones', () => {
        const contacts = [
            { source: 'linkedin_imported', name: 'Charlie', phones: [] },
        ];
        const bridge = buildPhoneBridge(contacts);
        assert.equal(Object.keys(bridge).length, 0);
    });

    it('skips names shorter than 3 chars after normalization', () => {
        const contacts = [
            { source: 'linkedin_imported', name: 'Al', phones: ['+15551234567'] },
        ];
        const bridge = buildPhoneBridge(contacts);
        assert.equal(Object.keys(bridge).length, 0);
    });

    it('skips phones shorter than 7 digits after normalization', () => {
        const contacts = [
            { source: 'linkedin_imported', name: 'Alice Smith', phones: ['123'] },
        ];
        const bridge = buildPhoneBridge(contacts);
        // Key may exist but set should be empty
        const sets = Object.values(bridge);
        const totalPhones = sets.reduce((sum, s) => sum + s.size, 0);
        assert.equal(totalPhones, 0);
    });

    it('merges multiple phones for the same normalized name', () => {
        const contacts = [
            { source: 'linkedin_imported', name: 'Alice Smith', phones: ['+15551234567', '+15559876543'] },
        ];
        const bridge = buildPhoneBridge(contacts);
        const key = Object.keys(bridge)[0];
        assert.equal(bridge[key].size, 2);
    });
});

// --- buildInteractionIndex ---

describe('buildInteractionIndex', () => {
    it('indexes interactions by chatId', () => {
        const interactions = [
            { chatId: 'chat1', from: 'me', source: 'whatsapp', timestamp: '2025-01-01' },
            { chatId: 'chat1', from: 'alice', source: 'whatsapp', timestamp: '2025-01-02' },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byChatId['chat1'].length, 2);
    });

    it('indexes by from, excluding "me"', () => {
        const interactions = [
            { chatId: 'c1', from: 'me', source: 'whatsapp' },
            { chatId: 'c1', from: 'alice@c.us', source: 'whatsapp' },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byFrom['me'], undefined);
        assert.equal(idx.byFrom['alice@c.us'].length, 1);
    });

    it('indexes LinkedIn interactions by participant name', () => {
        const interactions = [
            { source: 'linkedin', chatName: 'Alice, Bob', from: 'alice' },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byLiName['Alice'].length, 1);
        assert.equal(idx.byLiName['Bob'].length, 1);
    });

    it('indexes email interactions by from and to addresses', () => {
        const interactions = [
            { source: 'email', from: 'a@x.com', to: ['b@x.com', 'c@x.com'] },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byEmail['a@x.com'].length, 1);
        assert.equal(idx.byEmail['b@x.com'].length, 1);
        assert.equal(idx.byEmail['c@x.com'].length, 1);
    });

    it('indexes Slack interactions by author/member id', () => {
        const interactions = [
            { source: 'slack', from: 'U123', chatId: 'C123', id: 'm1' },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byFrom.U123.length, 1);
    });

    it('handles empty interactions array', () => {
        const idx = buildInteractionIndex([]);
        assert.deepEqual(idx.byChatId, {});
        assert.deepEqual(idx.byFrom, {});
        assert.deepEqual(idx.byEmail, {});
        assert.deepEqual(idx.byLiName, {});
    });

    it('handles email with string to (not array)', () => {
        const interactions = [
            { source: 'email', from: 'a@x.com', to: 'b@x.com' },
        ];
        const idx = buildInteractionIndex(interactions);
        assert.equal(idx.byEmail['a@x.com'].length, 1);
        assert.equal(idx.byEmail['b@x.com'].length, 1);
    });
});
