/**
 * Tests for crm/life-events.js — detecting announcements + job changes.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    detectAnnouncementEvents,
    detectBirthday,
    detectJobChange,
    detectAllEvents,
} = require('../../crm/life-events');

const NOW = new Date('2026-04-20T12:00:00Z').getTime();
const contact = { id: 'c_1', name: 'Alex Chen' };

function msg(from, body, overrides = {}) {
    return {
        from, body,
        timestamp: '2026-04-10T10:00:00Z',
        source: 'email',
        ...overrides,
    };
}

test('[Events] detects "joining <company>" as a job change', () => {
    const msgs = [msg('them', 'excited to announce I am joining Stripe next month')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'job_change');
});

test('[Events] detects fundraise announcements', () => {
    const msgs = [msg('them', 'We raised a $4M seed round led by Accel')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e.some(x => x.kind === 'funding'));
});

test('[Events] detects launch / milestone announcements', () => {
    const msgs = [msg('them', 'we just launched — live on Product Hunt today')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e.some(x => x.kind === 'milestone'));
});

test('[Events] ignores messages from the user themselves', () => {
    const msgs = [msg('me', 'I just started at Google')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 0);
});

test('[Events] ignores stale messages outside recentDays window', () => {
    const old = msg('them', 'joining Stripe', { timestamp: '2020-01-01T00:00:00Z' });
    const e = detectAnnouncementEvents(contact, [old], { now: NOW, recentDays: 180 });
    assert.equal(e.length, 0);
});

test('[Events] detects birthday within 14 days', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-04-25' } } };
    const b = detectBirthday(c, { now: NOW });
    assert.ok(b);
    assert.equal(b.kind, 'birthday');
    assert.ok(b.daysAway >= 4 && b.daysAway <= 5, 'expected ~5 days, got ' + b.daysAway);
});

test('[Events] birthday in far future returns null', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-10-01' } } };
    const b = detectBirthday(c, { now: NOW });
    assert.equal(b, null);
});

test('[Events] detects job change when LinkedIn company differs from Apollo most-recent employer', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { company: 'Stripe', position: 'Product Lead' } },
        apollo: { employmentHistory: [{ organization_name: 'Google', title: 'PM' }] },
    };
    const j = detectJobChange(c);
    assert.ok(j);
    assert.equal(j.kind, 'job_change');
    assert.ok(/Google.*Stripe/.test(j.label));
});

test('[Events] no job-change event if companies match', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { company: 'Stripe' } },
        apollo: { employmentHistory: [{ organization_name: 'Stripe' }] },
    };
    assert.equal(detectJobChange(c), null);
});

test('[Events] detectAllEvents ranks newer + higher-weight first', () => {
    const contacts = [
        { id: 'c_1', name: 'Alex' },
        { id: 'c_2', name: 'Priya' },
    ];
    const ixn = {
        c_1: [msg('them', 'excited to announce joining Stripe', { timestamp: '2026-04-18T00:00:00Z' })],
        c_2: [msg('them', 'we raised a seed round!', { timestamp: '2026-04-05T00:00:00Z' })],
    };
    const events = detectAllEvents({ contacts, interactionsByContactId: ixn, now: NOW });
    assert.ok(events.length >= 2);
});

test('[Events] first announcement in a message wins — one event per message', () => {
    const msgs = [msg('them', 'Hey — I am joining Stripe AND we just raised a seed round')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
});

test('[Events] snippet is bounded and readable', () => {
    const longMsg = 'Lots of context before. ' + 'Great news — we just launched today. ' + 'A lot of context after this. '.repeat(5);
    const msgs = [msg('them', longMsg)];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.ok(e[0].snippet.length < 150);
});

// ---------------------------------------------------------------------------
// detectBirthday — alternate formats and label branches
// ---------------------------------------------------------------------------

test('[Events] birthday with --MM-DD format (no year) is detected', () => {
    const midnight = new Date('2026-04-20T00:00:00Z').getTime();
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '--04-25' } } };
    const b = detectBirthday(c, { now: midnight });
    assert.ok(b);
    assert.equal(b.kind, 'birthday');
    assert.equal(b.daysAway, 5);
});

test('[Events] birthday with MM-DD format (no year prefix) is detected', () => {
    const midnight = new Date('2026-04-20T00:00:00Z').getTime();
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '04-25' } } };
    const b = detectBirthday(c, { now: midnight });
    assert.ok(b);
    assert.equal(b.kind, 'birthday');
    assert.equal(b.daysAway, 5);
});

test('[Events] birthday today shows "Birthday today" label', () => {
    // Use midnight so same-day comparison doesn't wrap to next year
    const midnight = new Date('2026-04-20T00:00:00Z').getTime();
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-04-20' } } };
    const b = detectBirthday(c, { now: midnight });
    assert.ok(b);
    assert.equal(b.label, 'Birthday today');
    assert.equal(b.daysAway, 0);
});

test('[Events] birthday tomorrow shows "Birthday tomorrow" label', () => {
    const midnight = new Date('2026-04-20T00:00:00Z').getTime();
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-04-21' } } };
    const b = detectBirthday(c, { now: midnight });
    assert.ok(b);
    assert.equal(b.label, 'Birthday tomorrow');
    assert.equal(b.daysAway, 1);
});

test('[Events] birthday with no sources returns null', () => {
    const c = { id: 'c_1', name: 'X' };
    assert.equal(detectBirthday(c, { now: NOW }), null);
});

test('[Events] birthday with empty googleContacts returns null', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: {} } };
    assert.equal(detectBirthday(c, { now: NOW }), null);
});

test('[Events] birthday with invalid string returns null', () => {
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: 'not-a-date' } } };
    assert.equal(detectBirthday(c, { now: NOW }), null);
});

test('[Events] birthday wraps to next year if date already passed', () => {
    // April 10 is before April 20 (NOW), so next occurrence is April 10 next year
    const c = { id: 'c_1', name: 'X', sources: { googleContacts: { birthday: '1990-04-10' } } };
    const b = detectBirthday(c, { now: NOW, within: 400 });
    assert.ok(b);
    assert.ok(b.daysAway > 300, 'should wrap to next year, got ' + b.daysAway);
});

// ---------------------------------------------------------------------------
// detectAnnouncementEvents — untested pattern kinds
// ---------------------------------------------------------------------------

test('[Events] detects promotion announcements', () => {
    const msgs = [msg('them', 'got promoted to VP of Engineering last week')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'job_change');
    assert.equal(e[0].label, 'Promotion');
});

test('[Events] detects life moment — engagement', () => {
    const msgs = [msg('them', 'we got engaged over the weekend!')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'life_moment');
});

test('[Events] detects reconnection pattern', () => {
    const msgs = [msg('them', 'great to catch up after such a long time!')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'reconnection');
});

test('[Events] detects acquisition announcement', () => {
    const msgs = [msg('them', 'big news — we got acquired by Microsoft')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 1);
    assert.equal(e[0].kind, 'milestone');
    assert.equal(e[0].label, 'Acquisition');
});

test('[Events] skips messages with very short body', () => {
    const msgs = [msg('them', 'hi')];
    const e = detectAnnouncementEvents(contact, msgs, { now: NOW });
    assert.equal(e.length, 0);
});

test('[Events] detectJobChange returns null when linkedin company is missing', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { position: 'Engineer' } },
        apollo: { employmentHistory: [{ organization_name: 'Google' }] },
    };
    assert.equal(detectJobChange(c), null);
});

test('[Events] detectJobChange returns null when apollo history is missing', () => {
    const c = {
        id: 'c_1', name: 'X',
        sources: { linkedin: { company: 'Stripe' } },
    };
    assert.equal(detectJobChange(c), null);
});

test('[Events] detectAllEvents skips group contacts', () => {
    const group = { id: 'g_1', name: 'Family Chat', isGroup: true };
    const ixn = { g_1: [msg('them', 'joining Stripe next month')] };
    const events = detectAllEvents({ contacts: [group], interactionsByContactId: ixn, now: NOW });
    assert.equal(events.length, 0);
});
