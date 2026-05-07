'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { createPacer, envFlag, intEnv, safeInt, sourceSafeMode } = require('../../sources/_shared/safety');
const { redactDirectContactDetails, stripDirectContactDetails, agentSafetyEnvelope } = require('../../crm/privacy-envelope');

test('envFlag treats safe mode as on by default and supports explicit opt-out', () => {
  assert.equal(envFlag('MISSING', true, {}), true);
  assert.equal(envFlag('MISSING', false, {}), false);
  assert.equal(envFlag('X', true, { X: '0' }), false);
  assert.equal(envFlag('X', true, { X: 'false' }), false);
  assert.equal(envFlag('X', false, { X: '1' }), true);
});

test('sourceSafeMode honors source-specific setting before global default', () => {
  assert.equal(sourceSafeMode('slack', { MINTY_SAFE_MODE: '0' }), false);
  assert.equal(sourceSafeMode('slack', { MINTY_SAFE_MODE: '0', SLACK_SAFE_MODE: '1' }), true);
  assert.equal(sourceSafeMode('google-contacts', { GOOGLE_CONTACTS_SAFE_MODE: '0' }), false);
});

test('intEnv clamps values and falls back on invalid input', () => {
  assert.equal(intEnv('N', 5, { min: 1, max: 10 }, { N: '99' }), 10);
  assert.equal(intEnv('N', 5, { min: 1, max: 10 }, { N: '-2' }), 1);
  assert.equal(intEnv('N', 5, { min: 1, max: 10 }, { N: 'wat' }), 5);
});

test('safeInt selects safe defaults unless safe mode is explicitly disabled', () => {
  assert.equal(safeInt('email', 'LIMIT', 250, 1000, {}, {}), 250);
  assert.equal(safeInt('email', 'LIMIT', 250, 1000, {}, { EMAIL_SAFE_MODE: '0' }), 1000);
  assert.equal(safeInt('email', 'LIMIT', 250, 1000, {}, { EMAIL_LIMIT: '42' }), 42);
});

test('createPacer enforces max calls', async () => {
  const pacer = createPacer({ source: 'test', maxCalls: 2, delayMs: 0 });
  await pacer.pace();
  await pacer.pace();
  await assert.rejects(() => pacer.pace(), /safety stop/);
  assert.equal(pacer.calls, 2);
});

test('privacy envelope redacts phone-like details without stripping dates', () => {
  assert.equal(redactDirectContactDetails('call +44 7700 900123 after 2025-01-01'), 'call [redacted phone] after 2025-01-01');
  assert.equal(stripDirectContactDetails('find 2025-01-01 fintech +1 206 555 0100'), 'find 2025-01-01 fintech');
});

test('agent safety envelope cannot override hard privacy invariants', () => {
  const envelope = agentSafetyEnvelope({
    contactDetailsOmitted: false,
    contactIdsOmitted: false,
    noLlmCalls: false,
    readOnly: false,
    omittedFields: ['customField', 'phones', 'customField'],
  });
  assert.equal(envelope.contactDetailsOmitted, true);
  assert.equal(envelope.contactIdsOmitted, true);
  assert.equal(envelope.noLlmCalls, true);
  assert.equal(envelope.readOnly, true);
  assert.deepEqual(envelope.omittedFields, ['emails', 'phones', 'rawContact', 'sourceDerivedContactIds', 'customField']);
});

test('agent safety envelope ignores caller extras except omitted field declarations', () => {
  const envelope = agentSafetyEnvelope({
    reason: 'source freshness preflight',
    emails: ['person@example.com'],
    phones: ['+12065550100'],
    rawContact: { id: 'raw-1' },
    contactIds: ['contact-1'],
    sourceDerivedContactIds: ['telegram:123'],
    sourceHandles: ['@private'],
    messages: ['private body'],
    metadata: { emails: ['nested@example.com'] },
  });
  assert.equal(Object.hasOwn(envelope, 'reason'), false);
  assert.equal(Object.hasOwn(envelope, 'emails'), false);
  assert.equal(Object.hasOwn(envelope, 'phones'), false);
  assert.equal(Object.hasOwn(envelope, 'rawContact'), false);
  assert.equal(Object.hasOwn(envelope, 'contactIds'), false);
  assert.equal(Object.hasOwn(envelope, 'sourceDerivedContactIds'), false);
  assert.equal(Object.hasOwn(envelope, 'sourceHandles'), false);
  assert.equal(Object.hasOwn(envelope, 'messages'), false);
  assert.equal(Object.hasOwn(envelope, 'metadata'), false);
});

test('agent safety envelope filters malformed omitted field declarations', () => {
  const envelope = agentSafetyEnvelope({
    omittedFields: [
      'safeField',
      'nested.safeField',
      'unsafe@example.com',
      '+12065550100',
      { field: 'rawContact' },
      null,
      ['phones'],
      'x'.repeat(82),
      '__proto__',
      'constructor.prototype',
      'safe.__proto__.field',
    ],
  });
  assert.deepEqual(envelope.omittedFields, [
    'emails',
    'phones',
    'rawContact',
    'sourceDerivedContactIds',
    'safeField',
    'nested.safeField',
  ]);
});

test('agent safety envelope tolerates null and primitive extras', () => {
  for (const extra of [null, 'unsafe@example.com', 42, true, ['phones']]) {
    assert.deepEqual(agentSafetyEnvelope(extra), agentSafetyEnvelope());
  }
});
