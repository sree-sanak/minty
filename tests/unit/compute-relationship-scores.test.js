'use strict';
const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { ContactIndex } = require('../../crm/utils');
const { computeRelationshipScores } = require('../../crm/merge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextInteractionId = 0;

function daysAgo(n) {
    return new Date(Date.now() - n * 86400 * 1000).toISOString();
}

function interactionId(prefix) {
    nextInteractionId += 1;
    return `${prefix}_${nextInteractionId}`;
}

beforeEach(() => {
    nextInteractionId = 0;
});

/** Create a WhatsApp-style interaction that will be matched via byChatId/byFrom. */
function waInteraction(waId, timestamp) {
    return {
        id: interactionId('wa'),
        source: 'whatsapp',
        timestamp,
        from: waId,
        to: 'me',
        body: 'hello',
        chatId: waId,
        chatName: null,
        type: 'message',
    };
}

/** Create an email interaction matched via byEmail. */
function emailInteraction(email, timestamp) {
    return {
        id: interactionId('email'),
        source: 'email',
        timestamp,
        from: email,
        to: 'me@example.com',
        body: 'hello',
        chatId: null,
        chatName: null,
        type: 'message',
    };
}

/** Create a LinkedIn interaction matched via byLiName. */
function liInteraction(name, timestamp) {
    return {
        id: interactionId('li'),
        source: 'linkedin',
        timestamp,
        from: name,
        to: 'me',
        body: 'hello',
        chatId: null,
        chatName: name,
        type: 'message',
    };
}

function seedIndex(contacts) {
    const idx = new ContactIndex();
    for (const c of contacts) {
        const contact = idx.upsert(c.phones || [], c.emails || [], c.name, c.id);
        if (c.isGroup) contact.isGroup = true;
        if (c.sources) {
            for (const [src, val] of Object.entries(c.sources)) {
                contact.sources[src] = val;
            }
        }
    }
    return idx;
}

// ---------------------------------------------------------------------------
// computeRelationshipScores — characterization tests
// ---------------------------------------------------------------------------

test('computeRelationshipScores: assigns score to contact with recent WhatsApp interactions', () => {
    const waId = '447911000001@c.us';
    const idx = seedIndex([{
        id: 'c_alice', name: 'Alice', phones: ['+447911000001'],
        sources: { whatsapp: { id: waId } },
    }]);
    const interactions = [
        waInteraction(waId, daysAgo(2)),
        waInteraction(waId, daysAgo(5)),
        waInteraction(waId, daysAgo(10)),
    ];
    computeRelationshipScores(idx, interactions);

    const alice = idx.byId['c_alice'];
    assert.ok(alice.relationshipScore > 0, `expected positive score, got ${alice.relationshipScore}`);
    assert.ok(alice.relationshipScore <= 100);
    assert.equal(alice.interactionCount, 3);
    assert.ok(alice.lastContactedAt != null);
    assert.ok(alice.daysSinceContact <= 3, `expected ~2 days since, got ${alice.daysSinceContact}`);
});

test('computeRelationshipScores: contact with no interactions scores 0', () => {
    const idx = seedIndex([
        { id: 'c_alice', name: 'Alice', phones: ['+447911000001'],
          sources: { whatsapp: { id: '447911000001@c.us' } } },
        { id: 'c_bob', name: 'Bob', phones: ['+447911000002'],
          sources: { whatsapp: { id: '447911000002@c.us' } } },
    ]);
    // Only Alice has interactions
    const interactions = [waInteraction('447911000001@c.us', daysAgo(1))];
    computeRelationshipScores(idx, interactions);

    const bob = idx.byId['c_bob'];
    assert.equal(bob.relationshipScore, 0);
    assert.equal(bob.interactionCount, 0);
});

test('computeRelationshipScores: groups always get score 0', () => {
    const waId = 'group@g.us';
    const idx = seedIndex([{
        id: 'g_team', name: 'Team Chat', phones: [], isGroup: true,
        sources: { whatsapp: { id: waId } },
    }]);
    const interactions = [
        waInteraction(waId, daysAgo(1)),
        waInteraction(waId, daysAgo(2)),
    ];
    computeRelationshipScores(idx, interactions);

    const group = idx.byId['g_team'];
    assert.equal(group.relationshipScore, 0, 'groups should always score 0');
});

test('computeRelationshipScores: recent contact scores higher than stale contact', () => {
    const idx = seedIndex([
        { id: 'c_recent', name: 'Recent', phones: ['+447911000001'],
          sources: { whatsapp: { id: 'recent@c.us' } } },
        { id: 'c_stale', name: 'Stale', phones: ['+447911000002'],
          sources: { whatsapp: { id: 'stale@c.us' } } },
    ]);
    const interactions = [
        waInteraction('recent@c.us', daysAgo(1)),
        waInteraction('stale@c.us', daysAgo(200)),
    ];
    computeRelationshipScores(idx, interactions);

    const recent = idx.byId['c_recent'];
    const stale = idx.byId['c_stale'];
    assert.ok(recent.relationshipScore > stale.relationshipScore,
        `recent (${recent.relationshipScore}) should outscore stale (${stale.relationshipScore})`);
});

test('computeRelationshipScores: multi-channel contact scores higher than single-channel', () => {
    const waId = 'multi@c.us';
    const email = 'multi@example.com';
    const liName = 'Multi Person';
    const idx = seedIndex([
        { id: 'c_multi', name: 'Multi Person', phones: ['+447911000001'], emails: [email],
          sources: { whatsapp: { id: waId }, linkedin: { name: liName } } },
        { id: 'c_single', name: 'Single Person', phones: ['+447911000002'],
          sources: { whatsapp: { id: 'single@c.us' } } },
    ]);
    const ts = daysAgo(3);
    const interactions = [
        waInteraction(waId, ts),
        emailInteraction(email, ts),
        liInteraction(liName, ts),
        waInteraction('single@c.us', ts),
    ];
    computeRelationshipScores(idx, interactions);

    const multi = idx.byId['c_multi'];
    const single = idx.byId['c_single'];
    assert.ok(multi.relationshipScore > single.relationshipScore,
        `multi-channel (${multi.relationshipScore}) should outscore single-channel (${single.relationshipScore})`);
    assert.ok(multi.activeChannels.length > single.activeChannels.length);
});

test('computeRelationshipScores: sets daysSinceContact correctly', () => {
    const waId = 'alice@c.us';
    const idx = seedIndex([{
        id: 'c_alice', name: 'Alice', phones: ['+447911000001'],
        sources: { whatsapp: { id: waId } },
    }]);
    const interactions = [waInteraction(waId, daysAgo(15))];
    computeRelationshipScores(idx, interactions);

    const alice = idx.byId['c_alice'];
    assert.ok(alice.daysSinceContact >= 14 && alice.daysSinceContact <= 16,
        `expected ~15 days since, got ${alice.daysSinceContact}`);
});

test('computeRelationshipScores: sets activeChannels from interactions', () => {
    const waId = 'alice@c.us';
    const email = 'alice@example.com';
    const idx = seedIndex([{
        id: 'c_alice', name: 'Alice', phones: ['+447911000001'], emails: [email],
        sources: { whatsapp: { id: waId } },
    }]);
    const interactions = [
        waInteraction(waId, daysAgo(1)),
        emailInteraction(email, daysAgo(2)),
    ];
    computeRelationshipScores(idx, interactions);

    const alice = idx.byId['c_alice'];
    assert.ok(alice.activeChannels.includes('whatsapp'));
    assert.ok(alice.activeChannels.includes('email'));
    assert.equal(alice.activeChannels.length, 2);
});

test('computeRelationshipScores: high-frequency contact scores higher', () => {
    const idx = seedIndex([
        { id: 'c_chatty', name: 'Chatty', phones: ['+447911000001'],
          sources: { whatsapp: { id: 'chatty@c.us' } } },
        { id: 'c_quiet', name: 'Quiet', phones: ['+447911000002'],
          sources: { whatsapp: { id: 'quiet@c.us' } } },
    ]);
    const chattyMsgs = Array.from({ length: 50 }, (_, i) =>
        waInteraction('chatty@c.us', daysAgo(Math.floor(i / 2))));
    const quietMsgs = [waInteraction('quiet@c.us', daysAgo(1))];
    computeRelationshipScores(idx, [...chattyMsgs, ...quietMsgs]);

    const chatty = idx.byId['c_chatty'];
    const quiet = idx.byId['c_quiet'];
    assert.ok(chatty.relationshipScore >= quiet.relationshipScore,
        `chatty (${chatty.relationshipScore}) should score >= quiet (${quiet.relationshipScore})`);
});

test('computeRelationshipScores: score is integer in [0, 100]', () => {
    const idx = seedIndex([
        { id: 'c_a', name: 'Alice', phones: ['+447911000001'],
          sources: { whatsapp: { id: 'a@c.us' } } },
        { id: 'c_b', name: 'Bob', phones: ['+447911000002'],
          sources: { whatsapp: { id: 'b@c.us' } } },
    ]);
    const interactions = [
        waInteraction('a@c.us', daysAgo(1)),
        waInteraction('a@c.us', daysAgo(5)),
        waInteraction('b@c.us', daysAgo(100)),
    ];
    computeRelationshipScores(idx, interactions);

    for (const c of idx.contacts) {
        assert.ok(Number.isInteger(c.relationshipScore),
            `score should be integer, got ${c.relationshipScore}`);
        assert.ok(c.relationshipScore >= 0 && c.relationshipScore <= 100,
            `score should be 0-100, got ${c.relationshipScore}`);
    }
});

test('computeRelationshipScores: empty interactions list gives all zeros', () => {
    const idx = seedIndex([{
        id: 'c_a', name: 'Alice', phones: ['+447911000001'],
        sources: { whatsapp: { id: 'a@c.us' } },
    }]);
    computeRelationshipScores(idx, []);

    assert.equal(idx.byId['c_a'].relationshipScore, 0);
    assert.equal(idx.byId['c_a'].interactionCount, 0);
});

test('computeRelationshipScores: 365+ day old interaction scores modestly', () => {
    const waId = 'old@c.us';
    const idx = seedIndex([{
        id: 'c_old', name: 'Old Friend', phones: ['+447911000001'],
        sources: { whatsapp: { id: waId } },
    }]);
    const interactions = [waInteraction(waId, daysAgo(400))];
    computeRelationshipScores(idx, interactions);

    const old = idx.byId['c_old'];
    // recency=0 (365+), with 1 contact p90=1, freq=log1p(1)/log1p(1)*100=100
    // freq contrib = 100*0.3=30, channel=20*0.2=4, total = 34
    assert.ok(old.relationshipScore <= 40,
        `old contact should score modestly, got ${old.relationshipScore}`);
    assert.ok(old.relationshipScore > 0,
        `should still have some score from frequency/channel, got ${old.relationshipScore}`);
});

test('computeRelationshipScores: email-only contact gets scored via email lookup', () => {
    const email = 'dave@example.com';
    const idx = seedIndex([{
        id: 'c_dave', name: 'Dave', phones: [], emails: [email],
    }]);
    const interactions = [
        emailInteraction(email, daysAgo(3)),
        emailInteraction(email, daysAgo(7)),
    ];
    computeRelationshipScores(idx, interactions);

    const dave = idx.byId['c_dave'];
    assert.ok(dave.relationshipScore > 0, `email-only contact should score > 0, got ${dave.relationshipScore}`);
    assert.equal(dave.interactionCount, 2);
    assert.deepEqual(dave.activeChannels, ['email']);
});

test('computeRelationshipScores: LinkedIn-only contact gets scored via name lookup', () => {
    const liName = 'Eve Founder';
    const idx = seedIndex([{
        id: 'c_eve', name: 'Eve Founder', phones: [], emails: [],
        sources: { linkedin: { name: liName, company: 'Stealth' } },
    }]);
    const interactions = [liInteraction(liName, daysAgo(10))];
    computeRelationshipScores(idx, interactions);

    const eve = idx.byId['c_eve'];
    assert.ok(eve.relationshipScore > 0, `LinkedIn contact should score > 0, got ${eve.relationshipScore}`);
    assert.deepEqual(eve.activeChannels, ['linkedin']);
});
