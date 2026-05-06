#!/usr/bin/env node
/**
 * Hermes Google Contacts Sync
 *
 * Pulls Google Contacts through an existing Hermes Google OAuth token and writes
 * Minty-compatible contacts to data/google-contacts/contacts.json.
 *
 * Usage:
 *   node sources/google-contacts/sync-hermes.js
 *   HERMES_HOME=/root/.hermes/google-personal node sources/google-contacts/sync-hermes.js
 *   MINTY_GOOGLE_TOKEN_FILES="work=/root/.hermes/google_token.json,personal=/root/.hermes/google-personal/google_token.json" node sources/google-contacts/sync-hermes.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { URLSearchParams } = require('url');
const { buildSafetyConfig, envInt } = require('../_shared/safety');

const OUT_DIR = process.env.GOOGLE_CONTACTS_OUT_DIR || path.join(__dirname, '../../data/google-contacts');
const sourceSafety = buildSafetyConfig('google_contacts', process.env, { defaultMaxApiCalls: 200, unsafeMaxApiCalls: 1000, defaultDelayMs: 0, unsafeDelayMs: 0 });
const LIMIT = envInt('GOOGLE_CONTACTS_LIMIT', process.env, sourceSafety.safeMode ? 500 : 2000, 1);
const PAGE_SIZE = Math.min(sourceSafety.safeMode ? 100 : 1000, Math.max(1, envInt('GOOGLE_CONTACTS_PAGE_SIZE', process.env, sourceSafety.safeMode ? 100 : 1000, 1)));
const INCREMENTAL = sourceSafety.incremental;
const PERSON_FIELDS = [
  'names',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'urls',
  'biographies',
  'birthdays',
  'metadata',
].join(',');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveTokenProfiles(env = process.env) {
  const explicit = env.MINTY_GOOGLE_TOKEN_FILES || env.GOOGLE_TOKEN_FILES;
  if (explicit) {
    return explicit.split(',').map(s => s.trim()).filter(Boolean).map((entry, i) => {
      const eq = entry.indexOf('=');
      if (eq > 0) {
        return { label: entry.slice(0, eq).trim() || `profile${i + 1}`, tokenPath: expandHome(entry.slice(eq + 1).trim()) };
      }
      return { label: `profile${i + 1}`, tokenPath: expandHome(entry) };
    });
  }
  const home = expandHome(env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
  return [{ label: 'default', tokenPath: path.join(home, 'google_token.json') }];
}

function requestJson(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; }
        catch (e) { return reject(new Error(`Bad JSON from ${options.hostname}: ${data.slice(0, 200)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsed.error_description || parsed.error?.message || parsed.error || data.slice(0, 200);
          return reject(new Error(`HTTP ${res.statusCode} from ${options.hostname}: ${message}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshAccessToken(token) {
  if (!token.refresh_token || !token.client_id || !token.client_secret) {
    if (token.token && token.expiry && Date.now() < token.expiry) return token.token;
    if (token.access_token && token.expiry_date && Date.now() < token.expiry_date) return token.access_token;
    throw new Error('Google token lacks refresh_token/client_id/client_secret; re-authorize Hermes Google Workspace');
  }

  const body = new URLSearchParams({
    client_id: token.client_id,
    client_secret: token.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  // Intentionally do not write the refreshed token back to the Hermes token file:
  // Hermes owns that credential lifecycle, while Minty only needs a short-lived
  // access token for this read-only sync.
  const refreshed = await requestJson({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (!refreshed.access_token) throw new Error('Google token refresh did not return an access_token');
  return refreshed.access_token;
}

function buildPeopleUrl(pageToken = '', pageSize = PAGE_SIZE) {
  const params = new URLSearchParams({
    personFields: PERSON_FIELDS,
    pageSize: String(pageSize),
    sortOrder: 'LAST_MODIFIED_DESCENDING',
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `https://people.googleapis.com/v1/people/me/connections?${params.toString()}`;
}

async function peopleGet(accessToken, pageToken = '') {
  const url = new URL(buildPeopleUrl(pageToken, PAGE_SIZE));
  return requestJson({
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function normalizePhone(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[^0-9+]/g, '');
  return normalized.length >= 7 ? normalized : null;
}

function normalizeBirthday(b) {
  const date = b && b.date;
  if (!date || !date.month || !date.day) return null;
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return date.year ? `${String(date.year).padStart(4, '0')}-${mm}-${dd}` : `${mm}-${dd}`;
}

function normalizePeoplePerson(person, sourceProfile) {
  const nameObj = (person.names || [])[0] || {};
  const orgObj = (person.organizations || [])[0] || {};
  const emails = [...new Set((person.emailAddresses || [])
    .map(e => String(e.value || '').trim().toLowerCase())
    .filter(v => v.includes('@')))];
  const phones = [...new Set((person.phoneNumbers || [])
    .map(p => normalizePhone(p.value || p.canonicalForm))
    .filter(Boolean))];
  const urls = [...new Set((person.urls || []).map(u => u.value).filter(Boolean))];
  const birthday = (person.birthdays || []).map(normalizeBirthday).find(Boolean) || null;
  const note = (person.biographies || []).map(b => b.value).find(Boolean) || null;
  const name = nameObj.displayName || [nameObj.givenName, nameObj.familyName].filter(Boolean).join(' ') || null;

  if (!name && emails.length === 0 && phones.length === 0) return null;

  return {
    name,
    phones,
    phoneDetails: (person.phoneNumbers || []).map(p => ({ number: normalizePhone(p.value || p.canonicalForm), types: [p.type].filter(Boolean) })).filter(p => p.number),
    emails,
    emailDetails: (person.emailAddresses || []).map(e => ({ email: String(e.value || '').trim().toLowerCase(), types: [e.type].filter(Boolean) })).filter(e => e.email.includes('@')),
    org: orgObj.name || null,
    title: orgObj.title || null,
    note,
    birthday,
    urls,
    source: 'google-contacts',
    sourceProfile,
    externalId: person.resourceName || null,
    lastSyncedAt: person.metadata?.sources?.map(s => s.updateTime).filter(Boolean).sort().pop() || null,
  };
}

function latestSyncedAtForProfile(existing, label) {
  const values = (existing || [])
    .filter(c => String(c.sourceProfile || '').split(',').includes(label))
    .map(c => c.lastSyncedAt)
    .filter(Boolean)
    .sort();
  return values.pop() || null;
}

async function fetchContactsForProfile(profile, existing = []) {
  if (!fs.existsSync(profile.tokenPath)) {
    throw new Error(`Google token not found for ${profile.label}: ${profile.tokenPath}`);
  }
  const token = JSON.parse(fs.readFileSync(profile.tokenPath, 'utf8'));
  const accessToken = await refreshAccessToken(token);
  const contacts = [];
  const previousLatest = INCREMENTAL ? latestSyncedAtForProfile(existing, profile.label) : null;
  let reachedKnownOlderPage = false;
  let pageToken = '';
  do {
    const response = await peopleGet(accessToken, pageToken);
    for (const person of response.connections || []) {
      const contact = normalizePeoplePerson(person, profile.label);
      if (contact) {
        if (previousLatest && contact.lastSyncedAt && contact.lastSyncedAt <= previousLatest) {
          reachedKnownOlderPage = true;
          break;
        }
        contacts.push(contact);
      }
      if (contacts.length >= LIMIT) break;
    }
    pageToken = response.nextPageToken || '';
  } while (pageToken && contacts.length < LIMIT && !reachedKnownOlderPage);
  return contacts;
}

function mergeContact(existing, incoming) {
  return {
    ...existing,
    name: existing.name || incoming.name,
    phones: [...new Set([...(existing.phones || []), ...(incoming.phones || [])])],
    phoneDetails: [...(existing.phoneDetails || []), ...(incoming.phoneDetails || [])],
    emails: [...new Set([...(existing.emails || []), ...(incoming.emails || [])])],
    emailDetails: [...(existing.emailDetails || []), ...(incoming.emailDetails || [])],
    org: existing.org || incoming.org,
    title: existing.title || incoming.title,
    note: existing.note || incoming.note,
    birthday: existing.birthday || incoming.birthday,
    urls: [...new Set([...(existing.urls || []), ...(incoming.urls || [])])],
    sourceProfile: [...new Set(String(existing.sourceProfile || '').split(',').concat(String(incoming.sourceProfile || '').split(',')).filter(Boolean))].join(','),
    externalId: [...new Set([existing.externalId, incoming.externalId].filter(Boolean))].join(',') || null,
    lastSyncedAt: [existing.lastSyncedAt, incoming.lastSyncedAt].filter(Boolean).sort().pop() || null,
  };
}

function mergeByIdentity(contacts) {
  const byKey = new Map();
  for (const contact of contacts) {
    const key = contact.emails[0] || contact.phones[0] || `${contact.sourceProfile}:${contact.externalId || contact.name}`;
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeContact(existing, contact) : contact);
  }
  return [...byKey.values()];
}

async function run() {
  const profiles = resolveTokenProfiles();
  const existingPath = path.join(OUT_DIR, 'contacts.json');
  const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, 'utf8')) : [];
  const all = [];
  for (const profile of profiles) {
    console.log(`Syncing Google Contacts from ${profile.label}…`);
    const contacts = await fetchContactsForProfile(profile, existing);
    console.log(`  ${profile.label}: ${contacts.length} contacts`);
    all.push(...contacts);
  }
  const contacts = mergeByIdentity((INCREMENTAL ? existing : []).concat(all));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'contacts.json'), `${JSON.stringify(contacts, null, 2)}\n`);
  console.log(`Saved ${contacts.length} contacts → ${path.join(OUT_DIR, 'contacts.json')} (incremental=${INCREMENTAL})`);
  return contacts;
}

if (require.main === module) {
  run().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPeopleUrl,
  latestSyncedAtForProfile,
  mergeByIdentity,
  normalizePeoplePerson,
  resolveTokenProfiles,
  run,
};
