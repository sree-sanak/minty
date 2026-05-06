'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSafetyConfig, envBool, envInt } = require('../../sources/_shared/safety');

test('[source-safety] defaults to safe and incremental mode', () => {
  const cfg = buildSafetyConfig('slack', {}, { defaultMaxApiCalls: 300, defaultDelayMs: 1500 });
  assert.equal(cfg.safeMode, true);
  assert.equal(cfg.incremental, true);
  assert.equal(cfg.maxApiCalls, 300);
  assert.equal(cfg.delayMs, 1500);
});

test('[source-safety] source-specific env overrides global env', () => {
  const cfg = buildSafetyConfig('slack', {
    MINTY_SAFE_MODE: '1',
    SLACK_SAFE_MODE: '0',
    MINTY_INCREMENTAL: '0',
    SLACK_INCREMENTAL: '1',
    SLACK_MAX_API_CALLS: '42',
    SLACK_API_DELAY_MS: '250',
  }, { defaultMaxApiCalls: 300, unsafeMaxApiCalls: 3000, defaultDelayMs: 1500, unsafeDelayMs: 0 });
  assert.equal(cfg.safeMode, false);
  assert.equal(cfg.incremental, true);
  assert.equal(cfg.maxApiCalls, 42);
  assert.equal(cfg.delayMs, 250);
});

test('[source-safety] malformed numeric env falls back to safe defaults', () => {
  const cfg = buildSafetyConfig('google_contacts', {
    GOOGLE_CONTACTS_MAX_API_CALLS: 'lol',
    GOOGLE_CONTACTS_API_DELAY_MS: '-5',
  }, { defaultMaxApiCalls: 100, defaultDelayMs: 500 });
  assert.equal(cfg.maxApiCalls, 100);
  assert.equal(cfg.delayMs, 500);
});

test('[source-safety] envBool and envInt parse conservative values', () => {
  assert.equal(envBool('X', { X: 'off' }, true), false);
  assert.equal(envBool('X', { X: 'yes' }, false), true);
  assert.equal(envInt('N', { N: '12' }, 3, 1), 12);
  assert.equal(envInt('N', { N: '0' }, 3, 1), 3);
});
