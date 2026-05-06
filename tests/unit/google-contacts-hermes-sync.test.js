const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveTokenProfiles,
  normalizePeoplePerson,
  buildPeopleUrl,
  latestSyncedAtForProfile,
  mergeByIdentity,
} = require('../../sources/google-contacts/sync-hermes');

test('resolveTokenProfiles: defaults to HERMES_HOME/google_token.json', () => {
  const profiles = resolveTokenProfiles({ HERMES_HOME: '/tmp/hermes-home' });
  assert.deepEqual(profiles, [{ label: 'default', tokenPath: path.join('/tmp/hermes-home', 'google_token.json') }]);
});

test('resolveTokenProfiles: supports comma-separated explicit token files with labels', () => {
  const profiles = resolveTokenProfiles({
    MINTY_GOOGLE_TOKEN_FILES: 'work=/tokens/work.json,personal=/tokens/personal.json,/tokens/other.json',
  });
  assert.deepEqual(profiles, [
    { label: 'work', tokenPath: '/tokens/work.json' },
    { label: 'personal', tokenPath: '/tokens/personal.json' },
    { label: 'profile3', tokenPath: '/tokens/other.json' },
  ]);
});

test('normalizePeoplePerson: maps People API fields to Minty contact schema', () => {
  const contact = normalizePeoplePerson({
    resourceName: 'people/c123',
    names: [{ displayName: 'Ada Lovelace', givenName: 'Ada', familyName: 'Lovelace' }],
    emailAddresses: [{ value: 'ADA@EXAMPLE.COM', type: 'work' }],
    phoneNumbers: [{ value: '(555) 123-4567', type: 'mobile' }],
    organizations: [{ name: 'Analytical Engines Ltd', title: 'Founder' }],
    urls: [{ value: 'https://example.com/ada' }],
    biographies: [{ value: 'Met at demo day.' }],
    birthdays: [{ date: { year: 1815, month: 12, day: 10 } }],
    metadata: { sources: [{ updateTime: '2026-04-01T00:00:00Z' }] },
  }, 'personal');

  assert.equal(contact.name, 'Ada Lovelace');
  assert.equal(contact.org, 'Analytical Engines Ltd');
  assert.equal(contact.title, 'Founder');
  assert.deepEqual(contact.emails, ['ada@example.com']);
  assert.deepEqual(contact.phones, ['5551234567']);
  assert.equal(contact.source, 'google-contacts');
  assert.equal(contact.sourceProfile, 'personal');
  assert.equal(contact.externalId, 'people/c123');
  assert.equal(contact.lastSyncedAt, '2026-04-01T00:00:00Z');
  assert.equal(contact.note, 'Met at demo day.');
  assert.deepEqual(contact.urls, ['https://example.com/ada']);
  assert.equal(contact.birthday, '1815-12-10');
});

test('normalizePeoplePerson: drops empty people records', () => {
  assert.equal(normalizePeoplePerson({ resourceName: 'people/empty' }, 'work'), null);
});


test('normalizePeoplePerson: supports birthday without year', () => {
  const contact = normalizePeoplePerson({
    names: [{ displayName: 'No Year' }],
    birthdays: [{ date: { month: 3, day: 14 } }],
  }, 'personal');
  assert.equal(contact.birthday, '03-14');
});

test('mergeByIdentity: merges duplicate contacts across profiles without dropping fields', () => {
  const merged = mergeByIdentity([
    {
      name: 'Ada Lovelace',
      emails: ['ada@example.com'],
      emailDetails: [{ email: 'ada@example.com', types: ['work'] }],
      phones: [],
      phoneDetails: [],
      urls: ['https://work.example/ada'],
      org: 'Work Org',
      title: null,
      note: null,
      birthday: null,
      sourceProfile: 'work',
      externalId: 'people/work',
      lastSyncedAt: '2026-03-01T00:00:00Z',
    },
    {
      name: 'Ada L.',
      emails: ['ada@example.com', 'ada@personal.example'],
      emailDetails: [{ email: 'ada@personal.example', types: ['home'] }],
      phones: ['5551234567'],
      phoneDetails: [{ number: '5551234567', types: ['mobile'] }],
      urls: ['https://personal.example/ada'],
      org: null,
      title: 'Founder',
      note: 'Personal note',
      birthday: '1815-12-10',
      sourceProfile: 'personal',
      externalId: 'people/personal',
      lastSyncedAt: '2026-04-01T00:00:00Z',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].emails, ['ada@example.com', 'ada@personal.example']);
  assert.deepEqual(merged[0].phones, ['5551234567']);
  assert.deepEqual(merged[0].urls, ['https://work.example/ada', 'https://personal.example/ada']);
  assert.equal(merged[0].org, 'Work Org');
  assert.equal(merged[0].title, 'Founder');
  assert.equal(merged[0].note, 'Personal note');
  assert.equal(merged[0].birthday, '1815-12-10');
  assert.equal(merged[0].sourceProfile, 'work,personal');
  assert.equal(merged[0].externalId, 'people/work,people/personal');
  assert.equal(merged[0].lastSyncedAt, '2026-04-01T00:00:00Z');
});

test('buildPeopleUrl: includes page size and source-backed field mask', () => {
  const url = buildPeopleUrl('abc', 250);
  assert.match(url, /^https:\/\/people\.googleapis\.com\/v1\/people\/me\/connections\?/);
  assert.match(url, /pageToken=abc/);
  assert.match(url, /pageSize=250/);
  assert.match(url, /personFields=/);
  assert.match(decodeURIComponent(url), /names,emailAddresses,phoneNumbers,organizations/);
});

test('latestSyncedAtForProfile returns newest timestamp for one profile only', () => {
  const latest = latestSyncedAtForProfile([
    { sourceProfile: 'work', lastSyncedAt: '2026-04-01T00:00:00Z' },
    { sourceProfile: 'personal', lastSyncedAt: '2026-05-01T00:00:00Z' },
    { sourceProfile: 'work,personal', lastSyncedAt: '2026-04-15T00:00:00Z' },
    { sourceProfile: 'work', lastSyncedAt: null },
  ], 'work');
  assert.equal(latest, '2026-04-15T00:00:00Z');
});
