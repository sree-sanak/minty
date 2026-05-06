'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { maxSlackTs, slimMessage } = require('../../sources/slack/import-messages');

test('[slack messages] maxSlackTs chooses newest Slack timestamp lexicographically', () => {
  assert.equal(maxSlackTs(['1700000000.000001', null, '1700000001.000000']), '1700000001.000000');
  assert.equal(maxSlackTs([]), null);
});

test('[slack messages] slimMessage preserves local-only raw text but keeps stable source actor fields', () => {
  const msg = slimMessage({
    ts: '1700000000.000001',
    user: 'U123',
    text: 'hello world',
    thread_ts: '1700000000.000001',
    reply_count: 2,
  }, { id: 'C123', name: 'general', is_private: false });
  assert.equal(msg.id, 'C123:1700000000.000001');
  assert.equal(msg.user, 'U123');
  assert.equal(msg.channelId, 'C123');
  assert.equal(msg.text, 'hello world');
  assert.equal(msg.type, 'message');
});
