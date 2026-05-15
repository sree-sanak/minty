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

test('[AgentQuery]: loadData loads privacy-safe memory refresh status for source health tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-refresh-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);
    writeJson(path.join(dir, 'unified', 'memory-refresh-status.json'), {
        generatedAt: '2026-05-07T09:30:00Z',
        status: 'failed',
        failedStep: 'telegram',
        steps: [{
            id: 'telegram',
            status: 'failed',
            message: 'failed for alice-private@example.com using /root/.hermes/google_token.json api_key=super-secret',
        }],
        warnings: [
            'raw-phone-555-0101 in /root/private/source.log token abc123',
            'safe aggregate warning',
        ],
        nextActions: ['manual unsafe action should be ignored'],
        artifacts: {
            contacts: { status: 'ok', path: '/root/private/contacts.json' },
        },
    });

    const refresh = loadData(dir).memoryRefreshStatus;
    const serialized = JSON.stringify(refresh);

    assert.equal(refresh.status, 'failed');
    assert.equal(refresh.failedStep, 'telegram');
    assert.equal(refresh.generatedAt, '2026-05-07T09:30:00Z');
    assert.deepEqual(refresh.nextActions, ['Check Telegram importer credentials and recent export freshness.']);
    assert.equal(serialized.includes('alice-private@example.com'), false);
    assert.equal(serialized.includes('raw-phone-555-0101'), false);
    assert.equal(serialized.includes('/root/.hermes'), false);
    assert.equal(serialized.includes('super-secret'), false);
});

test('[AgentQuery]: loadData returns unknown refresh status when memory refresh status is missing or malformed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-agent-query-refresh-missing-'));
    writeJson(path.join(dir, 'unified', 'contacts.json'), []);

    assert.deepEqual(loadData(dir).memoryRefreshStatus, {
        status: 'unknown',
        failedStep: null,
        generatedAt: null,
        warnings: [],
        nextActions: [],
    });

    fs.writeFileSync(path.join(dir, 'unified', 'memory-refresh-status.json'), '{not-json');
    assert.deepEqual(loadData(dir).memoryRefreshStatus, {
        status: 'unknown',
        failedStep: null,
        generatedAt: null,
        warnings: [],
        nextActions: [],
    });
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
