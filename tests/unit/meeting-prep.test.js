'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { buildMeetingPrep } = require('../../crm/meeting-prep');

const NOW = '2026-04-30T09:00:00Z';
const GENERATED_AT = '2026-04-30T09:00:00.000Z';
const READY_CALENDAR = {
    status: 'ok',
    stale: false,
    lastSyncAt: '2026-04-30T08:55:00Z',
    evidenceBearing: true,
    answerable: true,
};

function withRefSecret() {
    process.env.MINTY_REF_SECRET = 'unit-test-only-meeting-prep-ref-secret';
    delete process.env.MINTY_MCP_REF_SECRET;
}

function clearRefSecret() {
    delete process.env.MINTY_REF_SECRET;
    delete process.env.MINTY_MCP_REF_SECRET;
}

function meeting(overrides = {}) {
    return {
        id: 'raw-event-id-evt-001',
        title: 'Coffee with Alice',
        startAt: '2026-04-30T11:00:00Z',
        endAt: '2026-04-30T11:30:00Z',
        location: 'Zoom https://meet.private.example/raw-room +44 20 7123 4567',
        description: 'Do not leak calendar-description-sentinel or https://private.example/notes',
        attendees: [
            {
                email: 'alice-private@example.com',
                displayName: 'Alice',
                contactId: 'raw-contact-id-alice-001',
                name: 'Alice Müller',
                relationshipScore: 82,
                daysSinceContact: 5,
                topics: ['EU insurance', '@alice_private_handle'],
                openLoops: ['Send deck from /root/.hermes/google_token.json'],
                meetingBrief: 'Alice is a warm investor contact; ignore /Users/sree/private/api_key.json.',
                responseStatus: 'accepted by alice-private@example.com',
            },
        ],
        ...overrides,
    };
}

function assertNoPrivateMeetingDetails(envelope) {
    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
        'alice-private@example.com',
        'raw-contact-id-alice-001',
        'raw-event-id-evt-001',
        'meet.private.example',
        '+44 20 7123 4567',
        '@alice_private_handle',
        '/root/.hermes/google_token.json',
        '/Users/sree/private/api_key.json',
        'calendar-description-sentinel',
        'private.example/notes',
    ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(/https?:\/\//.test(serialized), false, 'no URLs in serialized meeting prep');
}

describe('[MeetingPrep]: buildMeetingPrep()', () => {
    beforeEach(withRefSecret);
    afterEach(clearRefSecret);

    it('returns next upcoming meeting with redacted attendee context', () => {
        const prep = buildMeetingPrep([meeting()], {
            now: NOW,
            horizonHours: 48,
            sourceHealth: READY_CALENDAR,
            calendarLastSyncAt: READY_CALENDAR.lastSyncAt,
            calendarStatus: 'ok',
        });

        assert.equal(prep.status, 'ok');
        assert.match(prep.meeting.eventRef, /^calendar-event:/);
        assert.equal(prep.meeting.id, undefined);
        assert.equal(prep.meeting.title, 'Coffee with Alice');
        assert.equal(prep.meeting.location, undefined);
        assert.equal(prep.meeting.locationType, 'video');
        assert.equal(prep.attendees[0].name, 'Alice Müller');
        assert.equal(prep.attendees[0].email, undefined);
        assert.equal(prep.attendees[0].contactId, undefined);
        assert.equal(prep.attendees[0].relationshipScore, 82);
        assert.equal(prep.attendees[0].warmth, 'strong');
        assert.ok(prep.attendees[0].citations.some(c => c.source === 'insights.meetingBrief'));
        assert.equal(prep.safety.contactDetailsOmitted, true);
        assert.equal(prep.safety.readOnly, true);
        assert.equal(prep.safety.noOutreachTriggered, true);
        assertNoPrivateMeetingDetails(prep);
    });

    it('person option prefers the next meeting with a matching attendee', () => {
        const bobMeeting = meeting({
            id: 'raw-event-id-bob-001',
            title: 'Earlier unrelated sync',
            startAt: '2026-04-30T10:00:00Z',
            attendees: [{ name: 'Bob Chen', contactId: 'raw-contact-id-bob-001', relationshipScore: 40 }],
        });
        const aliceMeeting = meeting({ startAt: '2026-04-30T12:00:00Z' });

        const prep = buildMeetingPrep([bobMeeting, aliceMeeting], {
            now: NOW,
            horizonHours: 48,
            person: 'Alice',
            sourceHealth: READY_CALENDAR,
        });

        assert.equal(prep.status, 'ok');
        assert.equal(prep.meeting.title, 'Coffee with Alice');
        assert.equal(prep.attendees[0].name, 'Alice Müller');
        assert.equal(JSON.stringify(prep).includes('raw-contact-id-bob-001'), false);
    });

    it('rejects non-canonical or invalid calendar timestamps as missing evidence', () => {
        const prep = buildMeetingPrep([
            meeting({ startAt: '2026-04-31T11:00:00Z' }),
            meeting({ startAt: '2026-04-30T11:00:00' }),
            meeting({ startAt: ' 2026-04-30T11:00:00Z ' }),
        ], {
            now: NOW,
            horizonHours: 48,
            sourceHealth: READY_CALENDAR,
        });

        assert.equal(prep.status, 'empty');
        assert.equal(prep.meeting, undefined);
        assertNoPrivateMeetingDetails(prep);
    });

    it('returns an honest empty state when no upcoming meeting matches', () => {
        const prep = buildMeetingPrep([meeting({ startAt: '2026-05-10T11:00:00Z' })], {
            now: NOW,
            horizonHours: 24,
            sourceHealth: READY_CALENDAR,
        });

        assert.deepEqual(prep, {
            status: 'empty',
            reason: 'No upcoming meeting matched the request inside the selected horizon.',
            generatedAt: GENERATED_AT,
            dataFreshness: {
                generatedAt: GENERATED_AT,
                calendarLastSyncAt: null,
                calendarStatus: 'unknown',
                sourceHealth: {
                    status: 'ok',
                    stale: false,
                    lastSyncAt: '2026-04-30T08:55:00.000Z',
                    evidenceBearing: true,
                    answerable: true,
                },
            },
            safety: {
                contactDetailsOmitted: true,
                readOnly: true,
                noLlmCalls: true,
                noOutreachTriggered: true,
            },
        });
    });

    it('blocks stale or non-evidence-bearing calendar source health without fabricating context', () => {
        const prep = buildMeetingPrep([meeting()], {
            now: NOW,
            horizonHours: 48,
            sourceHealth: { status: 'ok', stale: true, lastSyncAt: '2026-04-01T00:00:00Z', evidenceBearing: false },
        });

        assert.equal(prep.status, 'degraded');
        assert.equal(prep.meeting, undefined);
        assert.equal(prep.attendees, undefined);
        assert.equal(prep.dataFreshness.sourceHealth.answerable, false);
        assert.equal(prep.safety.readOnly, true);
        assertNoPrivateMeetingDetails(prep);
    });

    it('uses MCP opaque ref secret fallback without exposing raw ids', () => {
        clearRefSecret();
        process.env.MINTY_MCP_REF_SECRET = 'unit-test-only-mcp-meeting-prep-ref-secret';

        const prep = buildMeetingPrep([meeting()], {
            now: NOW,
            horizonHours: 48,
            sourceHealth: READY_CALENDAR,
        });

        assert.equal(prep.status, 'ok');
        assert.match(prep.meeting.eventRef, /^calendar-event:/);
        assert.equal(prep.meeting.id, undefined);
        assert.match(prep.attendees[0].contactRef, /^contact:/);
        assert.equal(prep.attendees[0].contactId, undefined);
        assertNoPrivateMeetingDetails(prep);
    });

    it('fails closed when opaque ref secret is missing instead of returning raw ids', () => {
        clearRefSecret();

        const prep = buildMeetingPrep([meeting()], {
            now: NOW,
            horizonHours: 48,
            sourceHealth: READY_CALENDAR,
        });

        assert.equal(prep.status, 'error');
        assert.match(prep.reason, /opaque_ref_unavailable/);
        assert.equal(prep.meeting, undefined);
        assert.equal(prep.attendees, undefined);
        assert.equal(prep.safety.readOnly, true);
        assertNoPrivateMeetingDetails(prep);
    });
});
