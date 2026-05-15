'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentGoalActions } = require('../../crm/agent-goal-actions');

function contact(id, overrides = {}) {
    return {
        id,
        name: id,
        relationshipScore: 50,
        daysSinceContact: null,
        interactionCount: 1,
        emails: ['raw-email-sentinel@example.com'],
        phones: ['raw-phone-555-0101'],
        sources: { linkedin: { company: 'ExampleCo', position: 'Founder' } },
        ...overrides,
    };
}

function assertTrustEnvelope(brief) {
    assert.ok(Array.isArray(brief.citations));
    assert.ok(brief.citations.length >= 1);
    assert.match(brief.citations[0].ref, /^result:\d+:cite:\d+$/);
    assert.ok(['contact', 'interaction', 'group', 'insights'].includes(brief.citations[0].source));
    assert.ok(['role', 'company', 'daysSinceContact', 'relationshipScore', 'profile', 'topics'].includes(brief.citations[0].field));
    assert.ok(['local-contact', 'local-insight', 'derived-local'].includes(brief.citations[0].provenance));
    assert.ok(Array.isArray(brief.confidenceDrivers));
    assert.ok(brief.confidenceDrivers.length >= 1);
    assert.ok(brief.confidenceDrivers.every(driver => [
        'cited_evidence',
        'warm_relationship',
        'recent_or_known_contact',
        'stale_contact_penalty',
    ].includes(driver)));
    assert.ok(brief.freshness);
    assert.equal(typeof brief.freshness.label, 'string');
    if (brief.freshness.latestEvidenceAt) assert.match(brief.freshness.latestEvidenceAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Array.isArray(brief.matchedSources));
    assert.ok(brief.matchedSources.length >= 1);
    assert.ok(brief.matchedSources.every(source => /^[a-z][a-z0-9_-]{0,31}$/.test(source)));
    assert.ok(Array.isArray(brief.answerSources));
    assert.ok(brief.answerSources.length >= 1);
    assert.equal(typeof brief.sourceSummary, 'string');
}

test('[AgentGoalActions]: prioritizes active pipeline follow-up before new asks', () => {
    const goals = [{
        id: 'raw-goal-id-seed',
        text: 'raise seed round',
        active: true,
        assignments: { c_stuck: { stage: 'contacted', updatedAt: '2026-04-10T00:00:00Z' } },
    }];
    const contacts = [
        contact('c_stuck', { name: 'Maya Partner', relationshipScore: 82 }),
        contact('c_new', { name: 'Alex Angel', relationshipScore: 90 }),
    ];

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships: {} }, {
        now: '2026-05-15T09:00:00Z',
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.safety.readOnly, true);
    assert.equal(out.safety.noOutreachTriggered, true);
    assert.equal(out.briefs[0].goalRef, 'goal:1');
    assert.equal(out.briefs[0].nextAction.type, 'pipeline_follow_up');
    assert.equal(out.briefs[0].pipelineFollowUps[0].stage, 'contacted');
    assert.match(out.briefs[0].nextAction.label, /Maya Partner/);
    assertTrustEnvelope(out.briefs[0]);
    assert.deepEqual(out.briefs[0].matchedSources, ['contact', 'interaction']);
    assert.deepEqual(out.briefs[0].answerSources, ['contact', 'interaction']);
    assert.deepEqual(out.briefs[0].citations.find(c => c.field === 'daysSinceContact'), {
        ref: 'result:1:cite:3',
        source: 'interaction',
        field: 'daysSinceContact',
        matchType: 'recent',
        provenance: 'derived-local',
    });
    assert.equal(out.briefs[0].freshness.stale, true);
    assert.ok(out.briefs[0].confidenceDrivers.includes('stale_contact_penalty'));
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('raw-goal-id-seed'), false);
    assert.equal(serialized.includes('c_stuck'), false);
    assert.equal(serialized.includes('raw-email-sentinel@example.com'), false);
    assert.equal(serialized.includes('raw-phone-555-0101'), false);
});

test('[AgentGoalActions]: includes warm intro path when direct relationship is cold', () => {
    const goals = [{ id: 'raw-goal-id-intro', text: 'target investor', active: true }];
    const contacts = [
        contact('c_target', {
            name: 'Target Investor',
            relationshipScore: 10,
            sources: { linkedin: { company: 'Target Capital', position: 'Partner' } },
            groupMemberships: [{ chatId: 'raw-group-id-seed@g.us' }],
        }),
        contact('c_warm', {
            name: 'Warm Founder',
            relationshipScore: 85,
            groupMemberships: [{ chatId: 'raw-group-id-seed@g.us' }],
        }),
    ];
    const groupMemberships = {
        'raw-group-id-seed@g.us': { name: 'Sensitive Group Name', size: 3, members: ['c_target', 'c_warm'] },
    };

    const out = buildAgentGoalActions({ goals, contacts, interactions: [], groupMemberships }, {
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.briefs[0].introPaths[0].target.name, 'Target Investor');
    assert.equal(out.briefs[0].introPaths[0].intermediary.name, 'Warm Founder');
    assert.ok(out.briefs[0].matchedSources.includes('group'));
    assert.deepEqual(out.briefs[0].citations.find(c => c.field === 'relationshipScore'), {
        ref: 'result:1:cite:3',
        source: 'group',
        field: 'relationshipScore',
        matchType: 'warmth',
        provenance: 'derived-local',
    });
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('raw-group-id-seed'), false);
    assert.equal(serialized.includes('Sensitive Group Name'), false);
    assert.equal(serialized.includes('c_target'), false);
    assert.equal(serialized.includes('c_warm'), false);
});

test('[AgentGoalActions]: new asks cite local contact profile instead of fabricated insight topics', () => {
    const out = buildAgentGoalActions({
        goals: [{ id: 'raw-goal-id-profile', text: 'meet atlas advisor', active: true }],
        contacts: [contact('c_profile', {
            name: 'Atlas Advisor',
            relationshipScore: 60,
            sources: {},
        })],
        interactions: [],
        groupMemberships: {},
    }, {
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.briefs[0].nextAction.type, 'new_ask');
    assert.deepEqual(out.briefs[0].matchedSources, ['contact']);
    assert.deepEqual(out.briefs[0].citations, [{
        ref: 'result:1:cite:1',
        source: 'contact',
        field: 'profile',
        matchType: 'keyword',
        provenance: 'local-contact',
    }]);
    assert.equal(JSON.stringify(out).includes('topics'), false);
    assert.equal(JSON.stringify(out).includes('local-insight'), false);
});

test('[AgentGoalActions]: redacts direct contact details and returns honest empty state', () => {
    const out = buildAgentGoalActions({ goals: [], contacts: [contact('c_1')], interactions: [], groupMemberships: {} }, {
        now: '2026-05-04T09:00:00Z',
    });

    const serialized = JSON.stringify(out);
    assert.equal(out.status, 'empty');
    assert.equal(out.briefs.length, 0);
    assert.equal(serialized.includes('raw-email-sentinel@example.com'), false);
    assert.equal(serialized.includes('raw-phone-555-0101'), false);
});

test('[AgentGoalActions]: redacts direct details from action labels and rejects invalid pipeline dates', () => {
    const out = buildAgentGoalActions({
        goals: [{
            text: 'raise seed with contact@example.com',
            active: true,
            assignments: { c_leaky: { stage: 'contact@example.com', updatedAt: '2026-02-30T00:00:00Z' } },
        }],
        contacts: [contact('c_leaky', {
            name: 'Leaky Person +44 20 7123 4567 leaky@example.com',
            relationshipScore: 80,
        })],
        interactions: [],
        groupMemberships: {},
    }, {
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.status, 'ok');
    assert.equal(out.briefs[0].pipelineFollowUps[0].updatedAt, null);
    assert.equal(out.briefs[0].pipelineFollowUps[0].ageDays, null);
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('contact@example.com'), false);
    assert.equal(serialized.includes('leaky@example.com'), false);
    assert.equal(serialized.includes('+44 20 7123 4567'), false);
});

test('[AgentGoalActions]: matching a missing goal returns an empty low-confidence state', () => {
    const out = buildAgentGoalActions({
        goals: [{ id: 'raw-goal-id-seed', text: 'raise seed', active: true }],
        contacts: [contact('c_1', { name: 'Seed Investor', relationshipScore: 90 })],
        interactions: [],
        groupMemberships: {},
    }, {
        goal: 'hire designer',
        now: '2026-05-04T09:00:00Z',
    });

    assert.equal(out.status, 'empty');
    assert.equal(out.confidence, 'low');
    assert.equal(out.safety.readOnly, true);
    assert.equal(out.safety.noOutreachTriggered, true);
});
