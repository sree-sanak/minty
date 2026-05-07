'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const { createPacer, envFlag, intEnv, safeInt, sourceSafeMode } = require('../../sources/_shared/safety');

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
