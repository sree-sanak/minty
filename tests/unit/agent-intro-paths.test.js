'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentIntroPaths } = require('../../crm/agent-intro-paths');

function fixtureData() {
    const contacts = [
        {
            id: 'raw-target-id',
            name: 'Maya Target',
            relationshipScore: 12,
            daysSinceContact: 400,
            lastContactedAt: '2025-04-01T00:00:00Z',
            emails: ['maya-secret@example.test'],
            phones: ['raw-phone-555-0101'],
            sources: { linkedin: { company: 'TargetCo', position: 'Partner', publicIdentifier: 'raw-linkedin-handle' } },
            groupMemberships: [{ chatId: 'raw-group-id-seed@g.us', chatName: 'Secret Seed Group' }],
        },
        {
            id: 'raw-warm-id',
            name: 'Priya Warm',
            relationshipScore: 86,
            daysSinceContact: 4,
            lastContactedAt: '2026-05-01T00:00:00Z',
            sources: { linkedin: { company: 'WarmCo', position: 'Founder' } },
            groupMemberships: [{ chatId: 'raw-group-id-seed@g.us', chatName: 'Secret Seed Group' }],
        },
        {
            id: 'raw-other-id',
            name: 'No Path',
            relationshipScore: 75,
            sources: { linkedin: { company: 'OtherCo', position: 'Operator' } },
            groupMemberships: [],
        },
    ];
    return {
        contacts,
        interactions: [],
        insights: {},
        groupMemberships: {
            'raw-group-id-seed@g.us': {
                name: 'Secret Seed Group',
                size: 3,
                members: ['raw-target-id', 'raw-warm-id'],
            },
        },
    };
}

test('[AgentIntroPaths]: target query returns redacted cited warm intro paths', () => {
    const out = buildAgentIntroPaths(fixtureData(), { target: 'Maya Target', limit: 1 });

    assert.equal(out.status, 'ok');
    assert.equal(out.query.target, 'Maya Target');
    assert.equal(out.paths.length, 1);
    assert.deepEqual(out.paths[0], {
        target: { name: 'Maya Target', title: 'Partner', company: 'TargetCo', warmth: 'cold' },
        intermediary: { name: 'Priya Warm', title: 'Founder', company: 'WarmCo', warmth: 'strong' },
        sharedContext: { kind: 'private_group_membership', count: 1, sizeBucket: 'small' },
        confidence: 'high',
        confidenceDrivers: ['warm_intermediary', 'small_shared_context', 'local_group_evidence'],
        freshness: { label: '4 days since intermediary contact', daysSinceContact: 4, stale: false },
        citations: [{ ref: 'result:1:cite:1', source: 'group', field: 'sharedContext', matchType: 'co_membership', provenance: 'derived-local' }],
        sourceSummary: '1 local group citation; warm intro evidence',
    });
    assert.equal(out.safety.readOnly, true);
    assert.equal(out.safety.noOutreachTriggered, true);

    const serialized = JSON.stringify(out);
    for (const forbidden of [
        'raw-target-id',
        'raw-warm-id',
        'raw-group-id-seed',
        'Secret Seed Group',
        'maya-secret@example.test',
        'raw-phone-555-0101',
        'raw-linkedin-handle',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `must not leak ${forbidden}`);
    }
});

test('[AgentIntroPaths]: returns honest empty states', () => {
    assert.equal(buildAgentIntroPaths(fixtureData(), {}).status, 'empty');
    assert.equal(buildAgentIntroPaths(fixtureData(), {}).reasonCode, 'missing_input');
    assert.equal(buildAgentIntroPaths({ contacts: fixtureData().contacts, groupMemberships: {} }, { target: 'Maya Target' }).reasonCode, 'no_group_graph');
    assert.equal(buildAgentIntroPaths(fixtureData(), { target: 'Missing Person' }).reasonCode, 'no_target_matches');
    assert.equal(buildAgentIntroPaths(fixtureData(), { target: 'No Path' }).reasonCode, 'no_path');
});

test('[AgentIntroPaths]: goal query finds a target before pathing', () => {
    const data = fixtureData();
    data.contactEvidence = {
        'raw-target-id': [{ kind: 'profile', label: 'EU crypto insurance partner', detail: 'EU crypto insurance partner' }],
    };

    const out = buildAgentIntroPaths(data, { goal: 'EU crypto insurance partners', limit: 1 });

    assert.equal(out.status, 'ok');
    assert.equal(out.query.goal, 'EU crypto insurance partners');
    assert.equal(out.paths[0].target.name, 'Maya Target');
    assert.equal(out.paths[0].intermediary.name, 'Priya Warm');
});

test('[AgentIntroPaths]: redacts raw ids and group names echoed in selector fields', () => {
    const out = buildAgentIntroPaths(fixtureData(), {
        target: 'Maya Target raw-target-id RAW-GROUP-ID-SEED@g.us secret seed group RAW-LINKEDIN-HANDLE maya-secret@example.test raw-phone-555-0101',
        limit: 1,
    });

    const serialized = JSON.stringify(out).toLowerCase();
    for (const forbidden of [
        'raw-target-id',
        'raw-group-id-seed',
        'secret seed group',
        'raw-linkedin-handle',
        'maya-secret@example.test',
        'raw-phone-555-0101',
    ]) {
        assert.equal(serialized.includes(forbidden), false, `must not echo ${forbidden}`);
    }
    assert.equal(out.query.target.includes('[redacted'), true);
});

test('[AgentIntroPaths]: redacts short known ids echoed in selectors', () => {
    const data = fixtureData();
    data.contacts[0].id = 'abc';
    data.contacts[0].sources.linkedin.publicIdentifier = 'xy';
    data.contacts[0].groupMemberships[0].chatId = 'z@g.us';
    data.groupMemberships = { 'z@g.us': { name: 'AI', size: 3, members: ['abc', 'raw-warm-id'] } };

    const out = buildAgentIntroPaths(data, { target: 'Maya Target abc xy z@g.us AI', limit: 1 });
    const serialized = JSON.stringify(out).toLowerCase();

    for (const forbidden of ['abc', 'xy', 'z@g.us', ' ai']) {
        assert.equal(serialized.includes(forbidden), false, `must not echo ${forbidden}`);
    }
    assert.equal(out.query.target.includes('[redacted'), true);
});
