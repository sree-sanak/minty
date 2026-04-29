'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseQuery,
    filterIndex,
    extractLocations,
    extractRoles,
    extractIntent,
    buildMeetScore,
    buildIndexEntry,
    extractContactFields,
    getSeniorityTier,
    getRolesFromTitle,
    normalizeLocation,
    describeQuery,
    phoneToLocation,
    emailToLocation,
    inferLocation,
} = require('../../crm/network-query');

// ---------------------------------------------------------------------------
// extractLocations
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractLocations — recognises london', () => {
    assert.deepEqual(extractLocations('who do i know in london'), ['london']);
});

test('[NetworkQuery]: extractLocations — recognises nyc alias', () => {
    assert.deepEqual(extractLocations('investors in nyc'), ['new york']);
});

test('[NetworkQuery]: extractLocations — recognises sf alias', () => {
    const locs = extractLocations('founders in sf');
    assert.ok(locs.includes('san francisco'));
});

test('[NetworkQuery]: extractLocations — handles multiple cities', () => {
    const locs = extractLocations('people in london and new york');
    assert.ok(locs.includes('london'));
    assert.ok(locs.includes('new york'));
});

test('[NetworkQuery]: extractLocations — empty for no city', () => {
    assert.deepEqual(extractLocations('who are the best engineers'), []);
});

test('[NetworkQuery]: extractLocations — word boundary: india not in indiana', () => {
    // "indiana" contains "india" but should not match "india" due to word boundary check
    const locs = extractLocations('contacts at indiana university');
    assert.ok(!locs.includes('india'), 'should not match india inside indiana');
});

test('[NetworkQuery]: extractLocations — recognises uk country-level', () => {
    const locs = extractLocations('founders in the uk');
    assert.ok(locs.includes('uk'));
});

// ---------------------------------------------------------------------------
// extractRoles
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractRoles — founder', () => {
    const roles = extractRoles('who are the founders i know');
    assert.ok(roles.includes('founder'));
});

test('[NetworkQuery]: extractRoles — investor via vc keyword', () => {
    const roles = extractRoles('vc and angel investors in my network');
    assert.ok(roles.includes('investor'));
});

test('[NetworkQuery]: extractRoles — engineer via cto', () => {
    const roles = extractRoles('cto connections worth meeting');
    assert.ok(roles.includes('engineer'));
});

test('[NetworkQuery]: extractRoles — consultant via mckinsey', () => {
    const roles = extractRoles('people from mckinsey');
    assert.ok(roles.includes('consultant'));
});

test('[NetworkQuery]: extractRoles — empty for generic query', () => {
    const roles = extractRoles('who do i know in london');
    assert.deepEqual(roles, []);
});

test('[NetworkQuery]: extractRoles — multiple roles', () => {
    const roles = extractRoles('founders and investors in fintech');
    assert.ok(roles.includes('founder'));
    assert.ok(roles.includes('investor'));
});

// ---------------------------------------------------------------------------
// extractIntent
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractIntent — meet intent', () => {
    assert.equal(extractIntent("who should i meet in london"), 'meet');
});

test('[NetworkQuery]: extractIntent — reconnect intent', () => {
    assert.equal(extractIntent("investors i haven't spoken to in months"), 'reconnect');
});

test('[NetworkQuery]: extractIntent — intro intent', () => {
    assert.equal(extractIntent('can you intro me to a cto'), 'intro');
});

test('[NetworkQuery]: extractIntent — find intent via who do i know', () => {
    assert.equal(extractIntent('who do i know in berlin'), 'find');
});

test('[NetworkQuery]: extractIntent — defaults to find', () => {
    assert.equal(extractIntent('london founders'), 'find');
});

// ---------------------------------------------------------------------------
// parseQuery — integration
// ---------------------------------------------------------------------------

test('[NetworkQuery]: parseQuery — full query parsing', () => {
    const result = parseQuery("who do i know in London that is a founder i should meet?");
    assert.ok(result.locations.includes('london'), `locations: ${JSON.stringify(result.locations)}`);
    assert.ok(result.roles.includes('founder'), `roles: ${JSON.stringify(result.roles)}`);
    assert.equal(result.intent, 'meet');
    assert.equal(result.raw, "who do i know in London that is a founder i should meet?");
});

test('[NetworkQuery]: parseQuery — empty query returns defaults', () => {
    const result = parseQuery('');
    assert.deepEqual(result.locations, []);
    assert.deepEqual(result.roles, []);
    assert.equal(result.intent, 'find');
});

test('[NetworkQuery]: parseQuery — null query returns defaults', () => {
    const result = parseQuery(null);
    assert.deepEqual(result.locations, []);
    assert.deepEqual(result.roles, []);
    assert.equal(result.intent, 'find');
});

// ---------------------------------------------------------------------------
// getSeniorityTier
// ---------------------------------------------------------------------------

test('[NetworkQuery]: getSeniorityTier — ceo is c-suite', () => {
    const { tier, rank } = getSeniorityTier('CEO at Acme');
    assert.equal(tier, 'c-suite');
    assert.equal(rank, 5);
});

test('[NetworkQuery]: getSeniorityTier — founder is c-suite', () => {
    const { tier } = getSeniorityTier('Co-Founder & CTO');
    assert.equal(tier, 'c-suite');
});

test('[NetworkQuery]: getSeniorityTier — vp is vp tier', () => {
    const { tier, rank } = getSeniorityTier('VP Engineering');
    assert.equal(tier, 'vp');
    assert.equal(rank, 4);
});

test('[NetworkQuery]: getSeniorityTier — director tier', () => {
    const { tier } = getSeniorityTier('Director of Product');
    assert.equal(tier, 'director');
});

test('[NetworkQuery]: getSeniorityTier — no title defaults to ic', () => {
    const { tier, rank } = getSeniorityTier(null);
    assert.equal(tier, 'ic');
    assert.equal(rank, 1);
});

// ---------------------------------------------------------------------------
// getRolesFromTitle
// ---------------------------------------------------------------------------

test('[NetworkQuery]: getRolesFromTitle — founder title', () => {
    const roles = getRolesFromTitle('Co-Founder');
    assert.ok(roles.includes('founder'));
});

test('[NetworkQuery]: getRolesFromTitle — multiple roles from title', () => {
    const roles = getRolesFromTitle('Founder & CEO');
    assert.ok(roles.includes('founder'));
    assert.ok(roles.includes('operator'));
});

test('[NetworkQuery]: getRolesFromTitle — empty for null', () => {
    assert.deepEqual(getRolesFromTitle(null), []);
});

// ---------------------------------------------------------------------------
// normalizeLocation
// ---------------------------------------------------------------------------

test('[NetworkQuery]: normalizeLocation — full location string', () => {
    const loc = normalizeLocation('London, England, United Kingdom');
    assert.equal(loc, 'london');
});

test('[NetworkQuery]: normalizeLocation — nyc alias', () => {
    const loc = normalizeLocation('New York, NY, United States');
    assert.equal(loc, 'new york');
});

test('[NetworkQuery]: normalizeLocation — null for no match', () => {
    assert.equal(normalizeLocation(''), null);
    assert.equal(normalizeLocation(null), null);
});

test('[NetworkQuery]: normalizeLocation — city takes priority over country', () => {
    // "London, United Kingdom" should resolve to city "london", not country "uk"
    const loc = normalizeLocation('London, United Kingdom');
    assert.equal(loc, 'london');
});

test('[NetworkQuery]: normalizeLocation — country fallback when no city matches', () => {
    // A location string that mentions a country but no recognized city
    const loc = normalizeLocation('Small Town, India');
    assert.equal(loc, 'india');
});

test('[NetworkQuery]: normalizeLocation — case insensitive', () => {
    assert.equal(normalizeLocation('BERLIN, Germany'), 'berlin');
    assert.equal(normalizeLocation('SAN FRANCISCO, CA'), 'san francisco');
});

test('[NetworkQuery]: normalizeLocation — recognizes city aliases', () => {
    assert.equal(normalizeLocation('Bay Area, California'), 'san francisco');
    assert.equal(normalizeLocation('Silicon Valley'), 'san francisco');
    assert.equal(normalizeLocation('Brooklyn, NY'), 'new york');
});

test('[NetworkQuery]: normalizeLocation — returns null for unrecognized location', () => {
    assert.equal(normalizeLocation('Mars Colony'), null);
    assert.equal(normalizeLocation('Unknown Place'), null);
});

test('[NetworkQuery]: normalizeLocation — multi-word city alias matched correctly', () => {
    // "mountain view" is a san francisco alias — should not partially match "mountain"
    assert.equal(normalizeLocation('Mountain View, CA'), 'san francisco');
});

test('[NetworkQuery]: normalizeLocation — country only string', () => {
    assert.equal(normalizeLocation('India'), 'india');
    assert.equal(normalizeLocation('Germany'), 'germany');
    assert.equal(normalizeLocation('United Kingdom'), 'uk');
});

// ---------------------------------------------------------------------------
// buildMeetScore
// ---------------------------------------------------------------------------

test('[NetworkQuery]: buildMeetScore — high score for senior + dormant + strong', () => {
    const score = buildMeetScore({ relationshipScore: 80, daysSinceContact: 90, title: 'CEO' });
    // 80*0.5 + 100*0.3 + 100*0.2 = 40 + 30 + 20 = 90
    assert.equal(score, 90);
});

test('[NetworkQuery]: buildMeetScore — zero relationship score', () => {
    const score = buildMeetScore({ relationshipScore: 0, daysSinceContact: 100, title: 'CEO' });
    // 0*0.5 + 100*0.3 + 100*0.2 = 0 + 30 + 20 = 50
    assert.equal(score, 50);
});

test('[NetworkQuery]: buildMeetScore — recent contact reduces recency penalty', () => {
    const score = buildMeetScore({ relationshipScore: 80, daysSinceContact: 5, title: 'CEO' });
    // 80*0.5 + 100*0.3 + 0*0.2 = 40 + 30 + 0 = 70
    assert.equal(score, 70);
});

test('[NetworkQuery]: buildMeetScore — null daysSince treated as 50 penalty', () => {
    const score = buildMeetScore({ relationshipScore: 0, daysSinceContact: null, title: '' });
    // 0*0.5 + 20*0.3 + 50*0.2 = 0 + 6 + 10 = 16
    assert.equal(score, 16);
});

// ---------------------------------------------------------------------------
// filterIndex
// ---------------------------------------------------------------------------

const SAMPLE_INDEX = [
    { id: 'c1', name: 'Alice Founder', city: 'london', roles: ['founder'], seniority: 'c-suite', seniority_rank: 5, relationshipScore: 80, daysSinceContact: 90, meetScore: 85 },
    { id: 'c2', name: 'Bob Investor', city: 'new york', roles: ['investor'], seniority: 'vp', seniority_rank: 4, relationshipScore: 60, daysSinceContact: 30, meetScore: 60 },
    { id: 'c3', name: 'Carol Engineer', city: 'london', roles: ['engineer'], seniority: 'ic', seniority_rank: 1, relationshipScore: 70, daysSinceContact: 10, meetScore: 45 },
    { id: 'c4', name: 'Dave Director', city: 'berlin', roles: ['operator'], seniority: 'director', seniority_rank: 3, relationshipScore: 50, daysSinceContact: 200, meetScore: 55 },
];

test('[NetworkQuery]: filterIndex — filters by location', () => {
    const parsed = { locations: ['london'], roles: [], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.ok(results.every(r => r.city === 'london'));
    assert.equal(results.length, 2);
});

test('[NetworkQuery]: filterIndex — filters by role', () => {
    const parsed = { locations: [], roles: ['founder'], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.ok(results.every(r => r.roles.includes('founder')));
    assert.equal(results.length, 1);
});

test('[NetworkQuery]: filterIndex — filters by location AND role', () => {
    const parsed = { locations: ['london'], roles: ['founder'], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'c1');
});

test('[NetworkQuery]: filterIndex — meet intent sorts by meetScore', () => {
    const parsed = { locations: [], roles: [], intent: 'meet' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].meetScore >= results[i].meetScore);
    }
});

test('[NetworkQuery]: filterIndex — reconnect intent sorts by daysSinceContact desc', () => {
    const parsed = { locations: [], roles: [], intent: 'reconnect' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    for (let i = 1; i < results.length; i++) {
        assert.ok((results[i - 1].daysSinceContact || 0) >= (results[i].daysSinceContact || 0));
    }
});

test('[NetworkQuery]: filterIndex — returns at most 20 results', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
        id: `c${i}`, name: `Person ${i}`, city: 'london', roles: [],
        seniority: 'ic', seniority_rank: 1, relationshipScore: i,
        daysSinceContact: i, meetScore: i,
    }));
    const parsed = { locations: [], roles: [], intent: 'find' };
    const results = filterIndex(big, parsed);
    assert.equal(results.length, 20);
});

test('[NetworkQuery]: filterIndex — no location/role filter returns all (up to 20)', () => {
    const parsed = { locations: [], roles: [], intent: 'find' };
    const results = filterIndex(SAMPLE_INDEX, parsed);
    assert.equal(results.length, SAMPLE_INDEX.length);
});

// ---------------------------------------------------------------------------
// buildIndexEntry
// ---------------------------------------------------------------------------

test('[NetworkQuery]: buildIndexEntry — extracts from apollo location', () => {
    const contact = {
        id: 'c1', name: 'Alice', isGroup: false,
        apollo: { location: 'London, England, United Kingdom', headline: 'CEO at Acme' },
        sources: { linkedin: null },
        relationshipScore: 75, daysSinceContact: 90, interactionCount: 10,
    };
    const entry = buildIndexEntry(contact);
    assert.equal(entry.city, 'london');
    assert.equal(entry.seniority, 'c-suite');
    assert.ok(entry.meetScore > 0);
});

test('[NetworkQuery]: buildIndexEntry — fallback to linkedin position', () => {
    const contact = {
        id: 'c2', name: 'Bob',
        apollo: null,
        sources: { linkedin: { position: 'VP Engineering', company: 'Tech Co', location: 'New York, NY' } },
        relationshipScore: 50, daysSinceContact: 45, interactionCount: 5,
    };
    const entry = buildIndexEntry(contact);
    assert.equal(entry.title, 'VP Engineering');
    assert.equal(entry.company, 'Tech Co');
    assert.equal(entry.city, 'new york');
    assert.equal(entry.seniority, 'vp');
});

// ---------------------------------------------------------------------------
// describeQuery
// ---------------------------------------------------------------------------

test('[NetworkQuery]: describeQuery — full parsed query', () => {
    const parsed = { locations: ['london'], roles: ['founder'], intent: 'meet' };
    const desc = describeQuery(parsed);
    assert.ok(desc.includes('London'));
    assert.ok(desc.includes('founder'));
    assert.ok(desc.includes('meet'));
});

test('[NetworkQuery]: describeQuery — no filters', () => {
    const parsed = { locations: [], roles: [], intent: 'find' };
    const desc = describeQuery(parsed);
    assert.ok(typeof desc === 'string' && desc.length > 0);
});

test('[NetworkQuery]: describeQuery — title-cases multi-word locations', () => {
    const parsed = { locations: ['san francisco'], roles: ['founder'], intent: 'find' };
    const desc = describeQuery(parsed);
    assert.ok(desc.includes('San Francisco'), `expected "San Francisco" but got: ${desc}`);
});

test('[NetworkQuery]: describeQuery — title-cases multiple multi-word locations', () => {
    const parsed = { locations: ['new york', 'tel aviv'], roles: [], intent: 'intro' };
    const desc = describeQuery(parsed);
    assert.ok(desc.includes('New York'), `expected "New York" but got: ${desc}`);
    assert.ok(desc.includes('Tel Aviv'), `expected "Tel Aviv" but got: ${desc}`);
});

test('[NetworkQuery]: describeQuery — collapses extra spaces in location names', () => {
    const parsed = { locations: ['new  york'], roles: [], intent: 'find' };
    const desc = describeQuery(parsed);
    assert.ok(desc.includes('New York'), `expected "New York" but got: ${desc}`);
    assert.ok(!desc.includes('New  York'), `expected collapsed spaces but got: ${desc}`);
});

test('[NetworkQuery]: describeQuery — uppercases short abbreviation locations (UK, US, UAE)', () => {
    assert.ok(describeQuery({ locations: ['uk'], roles: [], intent: 'find' }).includes('UK'));
    assert.ok(describeQuery({ locations: ['us'], roles: [], intent: 'find' }).includes('US'));
    assert.ok(describeQuery({ locations: ['uae'], roles: [], intent: 'find' }).includes('UAE'));
    // Should not break normal title-casing
    assert.ok(describeQuery({ locations: ['london'], roles: [], intent: 'find' }).includes('London'));
});

test('[NetworkQuery]: describeQuery — uppercases abbreviation words in multi-word locations', () => {
    assert.ok(describeQuery({ locations: ['washington dc'], roles: [], intent: 'find' }).includes('Washington DC'));
});

// ---------------------------------------------------------------------------
// phoneToLocation
// ---------------------------------------------------------------------------

test('[NetworkQuery]: phoneToLocation — null/empty returns null', () => {
    assert.equal(phoneToLocation(null), null);
    assert.equal(phoneToLocation(''), null);
    assert.equal(phoneToLocation(undefined), null);
});

test('[NetworkQuery]: phoneToLocation — UK mobile +44', () => {
    assert.equal(phoneToLocation('+447911123456'), 'uk');
});

test('[NetworkQuery]: phoneToLocation — UK landline +44 without area 0 falls through to generic uk', () => {
    // Real international format drops leading 0: +442079460123 doesn't match +44020 prefix
    assert.equal(phoneToLocation('+442079460123'), 'uk');
});

test('[NetworkQuery]: phoneToLocation — UK landline +44020 prefix matches london', () => {
    // The prefix map expects +44020... (with the 0 retained)
    assert.equal(phoneToLocation('+440207946012'), 'london');
});

test('[NetworkQuery]: phoneToLocation — UK local 020 → london', () => {
    assert.equal(phoneToLocation('02079460123'), 'london');
});

test('[NetworkQuery]: phoneToLocation — UK local 0161 → manchester', () => {
    assert.equal(phoneToLocation('01611234567'), 'manchester');
});

test('[NetworkQuery]: phoneToLocation — UK mobile 07xxx without +44', () => {
    assert.equal(phoneToLocation('07911123456'), 'uk');
});

test('[NetworkQuery]: phoneToLocation — US number +1', () => {
    assert.equal(phoneToLocation('+14155551234'), 'us');
});

test('[NetworkQuery]: phoneToLocation — India +91', () => {
    assert.equal(phoneToLocation('+919876543210'), 'india');
});

test('[NetworkQuery]: phoneToLocation — Germany +49', () => {
    assert.equal(phoneToLocation('+4930123456'), 'germany');
});

test('[NetworkQuery]: phoneToLocation — strips formatting characters', () => {
    assert.equal(phoneToLocation('+44 0207 946 0123'), 'london');
    assert.equal(phoneToLocation('+1 (415) 555-1234'), 'us');
});

test('[NetworkQuery]: phoneToLocation — unknown number returns null', () => {
    assert.equal(phoneToLocation('12345'), null);
    assert.equal(phoneToLocation('abcdef'), null);
});

// ---------------------------------------------------------------------------
// emailToLocation
// ---------------------------------------------------------------------------

test('[NetworkQuery]: emailToLocation — null/empty returns null', () => {
    assert.equal(emailToLocation(null), null);
    assert.equal(emailToLocation(''), null);
    assert.equal(emailToLocation(undefined), null);
});

test('[NetworkQuery]: emailToLocation — .co.uk → uk', () => {
    assert.equal(emailToLocation('alice@company.co.uk'), 'uk');
});

test('[NetworkQuery]: emailToLocation — .de → germany', () => {
    assert.equal(emailToLocation('bob@firma.de'), 'germany');
});

test('[NetworkQuery]: emailToLocation — .fr → france', () => {
    assert.equal(emailToLocation('marie@entreprise.fr'), 'france');
});

test('[NetworkQuery]: emailToLocation — .com returns null (not country-specific)', () => {
    assert.equal(emailToLocation('user@gmail.com'), null);
});

test('[NetworkQuery]: emailToLocation — .org returns null', () => {
    assert.equal(emailToLocation('admin@nonprofit.org'), null);
});

test('[NetworkQuery]: emailToLocation — case insensitive', () => {
    assert.equal(emailToLocation('USER@COMPANY.CO.UK'), 'uk');
});

test('[NetworkQuery]: emailToLocation — .co.uk matches before shorter .uk would', () => {
    // Ensures the sorted-by-length-desc strategy works
    assert.equal(emailToLocation('test@example.co.uk'), 'uk');
});

test('[NetworkQuery]: emailToLocation — .in → india', () => {
    assert.equal(emailToLocation('dev@startup.in'), 'india');
});

test('[NetworkQuery]: emailToLocation — .sg → singapore', () => {
    assert.equal(emailToLocation('ops@company.sg'), 'singapore');
});

// ---------------------------------------------------------------------------
// inferLocation
// ---------------------------------------------------------------------------

test('[NetworkQuery]: inferLocation — returns null when explicit location exists (Apollo)', () => {
    const contact = { apollo: { location: 'San Francisco, CA' }, phones: ['+447911123456'] };
    assert.equal(inferLocation(contact), null);
});

test('[NetworkQuery]: inferLocation — returns null when explicit location exists (LinkedIn)', () => {
    const contact = { sources: { linkedin: { location: 'London' } }, phones: ['+14155551234'] };
    assert.equal(inferLocation(contact), null);
});

test('[NetworkQuery]: inferLocation — infers from phones when no explicit location', () => {
    const contact = { phones: ['+447911123456'], emails: [] };
    assert.equal(inferLocation(contact), 'uk');
});

test('[NetworkQuery]: inferLocation — infers from emails when no phones match', () => {
    const contact = { phones: [], emails: ['user@firma.de'] };
    assert.equal(inferLocation(contact), 'germany');
});

test('[NetworkQuery]: inferLocation — phones take priority over emails', () => {
    const contact = { phones: ['+33612345678'], emails: ['user@firma.de'] };
    assert.equal(inferLocation(contact), 'france');
});

test('[NetworkQuery]: inferLocation — checks googleContacts phones', () => {
    const contact = { phones: [], emails: [], sources: { googleContacts: { phones: ['+919876543210'], emails: [] } } };
    assert.equal(inferLocation(contact), 'india');
});

test('[NetworkQuery]: inferLocation — checks sms phone', () => {
    const contact = { phones: [], emails: [], sources: { sms: { phone: '+14155551234' } } };
    assert.equal(inferLocation(contact), 'us');
});

test('[NetworkQuery]: inferLocation — checks googleContacts emails', () => {
    const contact = { phones: [], emails: [], sources: { googleContacts: { phones: [], emails: ['user@company.co.uk'] } } };
    assert.equal(inferLocation(contact), 'uk');
});

test('[NetworkQuery]: inferLocation — checks email source', () => {
    const contact = { phones: [], emails: [], sources: { email: { email: 'user@startup.sg' } } };
    assert.equal(inferLocation(contact), 'singapore');
});

test('[NetworkQuery]: inferLocation — returns null when no signals', () => {
    assert.equal(inferLocation({ phones: [], emails: [] }), null);
    assert.equal(inferLocation({}), null);
});

// ---------------------------------------------------------------------------
// extractContactFields
// ---------------------------------------------------------------------------

test('[NetworkQuery]: extractContactFields — extracts all fields from a rich contact', () => {
    const contact = {
        id: 'c1',
        name: 'Alice Chen',
        apollo: { headline: 'VP of Engineering', location: 'San Francisco, CA' },
        sources: { linkedin: { company: 'Acme Corp' } },
        phones: [], emails: [],
        relationshipScore: 85,
        daysSinceContact: 3,
        interactionCount: 42,
    };
    const result = extractContactFields(contact);
    assert.equal(result.id, 'c1');
    assert.equal(result.name, 'Alice Chen');
    assert.equal(result.title, 'VP of Engineering');
    assert.equal(result.company, 'Acme Corp');
    assert.equal(result.city, 'san francisco');
    assert.deepEqual(result.roles, ['engineer', 'operator']);
    assert.equal(result.seniority, 'vp');
    assert.equal(result.relationshipScore, 85);
    assert.equal(result.daysSinceContact, 3);
    assert.equal(result.interactionCount, 42);
});

test('[NetworkQuery]: extractContactFields — falls back through title sources', () => {
    // linkedin position is second priority after apollo headline
    const contact = {
        id: 'c2', name: 'Bob',
        sources: { linkedin: { position: 'Software Engineer', company: 'StartupCo' } },
        phones: [], emails: [],
    };
    const result = extractContactFields(contact);
    assert.equal(result.title, 'Software Engineer');
    assert.equal(result.company, 'StartupCo');
});

test('[NetworkQuery]: extractContactFields — falls back to googleContacts for title and org', () => {
    const contact = {
        id: 'c3', name: 'Carol',
        sources: { googleContacts: { title: 'Product Manager', org: 'BigCo' } },
        phones: [], emails: [],
    };
    const result = extractContactFields(contact);
    assert.equal(result.title, 'Product Manager');
    assert.equal(result.company, 'BigCo');
});

test('[NetworkQuery]: extractContactFields — falls back to employmentHistory for company', () => {
    const contact = {
        id: 'c4', name: 'Dan',
        apollo: { headline: 'Designer', employmentHistory: [{ organization_name: 'DesignCo' }] },
        phones: [], emails: [],
    };
    const result = extractContactFields(contact);
    assert.equal(result.company, 'DesignCo');
});

test('[NetworkQuery]: extractContactFields — handles minimal/empty contact', () => {
    const result = extractContactFields({ id: 'c5', phones: [], emails: [] });
    assert.equal(result.id, 'c5');
    assert.equal(result.name, '');
    assert.equal(result.title, '');
    assert.equal(result.company, '');
    assert.equal(result.city, null);
    assert.deepEqual(result.roles, []);
    assert.equal(result.relationshipScore, 0);
    assert.equal(result.daysSinceContact, null);
    assert.equal(result.interactionCount, 0);
});

test('[NetworkQuery]: extractContactFields — infers location from phone when no text location', () => {
    const contact = {
        id: 'c6', name: 'Eve',
        phones: ['+44 7911 123456'], emails: [],
    };
    const result = extractContactFields(contact);
    assert.equal(result.city, 'uk');
});

test('[NetworkQuery]: extractContactFields — text location takes priority over phone inference', () => {
    const contact = {
        id: 'c7', name: 'Frank',
        apollo: { location: 'New York' },
        phones: ['+44 7911 123456'], emails: [],
    };
    const result = extractContactFields(contact);
    assert.equal(result.city, 'new york');
});
