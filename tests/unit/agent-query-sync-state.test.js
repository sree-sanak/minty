'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadData } = require('../../scripts/agent-query');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

test('[AgentQuery]: loadData loads sync state for source health tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'sync-state.json'), {
        telegram: { lastSyncAt: '2026-05-06T07:00:00Z', status: 'ok', tokenPath: '/secret/token.json' },
    });

    const data = loadData(dir);

    assert.equal(data.syncState.telegram.lastSyncAt, '2026-05-06T07:00:00Z');
    assert.equal(data.syncState.telegram.status, 'ok');
    assert.equal(Object.hasOwn(data.syncState.telegram, 'tokenPath'), false);
});

test('[AgentQuery]: loadData falls back to empty sync state when missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);

    assert.deepEqual(loadData(dir).syncState, {});

    fs.writeFileSync(path.join(dir, 'sync-state.json'), '{not-json');
    assert.deepEqual(loadData(dir).syncState, {});
});

test('[AgentQuery]: loadData preserves bounded calendar meeting prep input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-calendar-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'sync-state.json'), {
        calendar: {
            lastSyncAt: '2026-04-30T08:55:00Z',
            status: 'ok',
            stale: false,
            evidenceBearing: true,
            answerable: true,
            tokenPath: '/secret/google-token.json',
            upcomingMeetings: [{
                id: 'raw-event-id-loader-001',
                title: 'Coffee with Alice',
                startAt: '2026-04-30T11:00:00Z',
                endAt: '2026-04-30T11:30:00Z',
                location: 'Zoom https://meet.private.example/raw',
                description: 'must-not-load-description',
                attendees: [{
                    email: 'alice-private@example.com',
                    displayName: 'Alice',
                    contactId: 'raw-contact-id-alice-001',
                    relationshipScore: 82,
                    daysSinceContact: 5,
                    topics: ['EU insurance'],
                    openLoops: ['Send deck'],
                    meetingBrief: 'Warm investor contact',
                    responseStatus: 'accepted',
                    secretField: 'must-not-load-attendee-secret',
                }],
            }],
        },
    });

    const calendar = loadData(dir).syncState.calendar;

    assert.equal(calendar.lastSyncAt, '2026-04-30T08:55:00Z');
    assert.equal(calendar.status, 'ok');
    assert.equal(calendar.stale, false);
    assert.equal(calendar.evidenceBearing, true);
    assert.equal(calendar.answerable, true);
    assert.equal(Object.hasOwn(calendar, 'tokenPath'), false);
    assert.equal(calendar.upcomingMeetings.length, 1);
    assert.deepEqual(calendar.upcomingMeetings[0], {
        id: 'raw-event-id-loader-001',
        title: 'Coffee with Alice',
        startAt: '2026-04-30T11:00:00Z',
        endAt: '2026-04-30T11:30:00Z',
        location: 'Zoom https://meet.private.example/raw',
        attendees: [{
            email: 'alice-private@example.com',
            displayName: 'Alice',
            name: null,
            contactId: 'raw-contact-id-alice-001',
            relationshipScore: 82,
            daysSinceContact: 5,
            topics: ['EU insurance'],
            openLoops: ['Send deck'],
            meetingBrief: 'Warm investor contact',
            responseStatus: 'accepted',
            lastInteractionAt: null,
            updatedAt: null,
            analyzedAt: null,
        }],
    });
});
