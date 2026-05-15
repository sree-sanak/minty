'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchEmailsViaGmailAPI } = require('../../sources/email/import');

test('[EmailImport] Gmail API counts skipped message diagnostics while preserving successful imports', async () => {
  const calls = [];
  const warnings = [];
  const gmailGet = async (_token, endpoint) => {
    calls.push(endpoint);
    if (endpoint.startsWith('messages?')) {
      return { messages: [{ id: 'ok-1' }, { id: 'bad-error' }, { id: 'bad-throw' }] };
    }
    if (endpoint.startsWith('messages/ok-1?')) {
      return {
        id: 'ok-1',
        payload: {
          headers: [
            { name: 'From', value: 'Safe Sender <safe.sender@example.test>' },
            { name: 'To', value: 'Recipient <recipient@example.test>' },
            { name: 'Subject', value: 'Safe subject' },
            { name: 'Date', value: 'Fri, 15 May 2026 10:00:00 +0000' },
          ],
        },
      };
    }
    if (endpoint.startsWith('messages/bad-error?')) {
      return {
        error: {
          message: 'provider leaked bad.person@example.test subject Secret Fundraise',
          token: 'raw-token-should-not-leak',
        },
      };
    }
    throw new Error('raw stack leaked bad.thrower@example.test subject Private Body raw-token-should-not-leak');
  };

  const result = await fetchEmailsViaGmailAPI('access-token-sentinel', {
    gmailGet,
    logger: { warn: message => warnings.push(String(message)) },
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, 'ok-1');
  assert.equal(result.contacts.length, 2);
  assert.deepEqual(result.diagnostics, { skippedMessages: 2 });
  assert.deepEqual(warnings, ['Gmail API: 2 messages failed to import']);
  assert.equal(calls.filter(endpoint => endpoint.startsWith('messages/')).length, 3);

  const serialized = JSON.stringify({ warnings, result });
  assert.equal(serialized.includes('raw-token-should-not-leak'), false);
  assert.equal(serialized.includes('bad.person@example.test'), false);
  assert.equal(serialized.includes('bad.thrower@example.test'), false);
  assert.equal(serialized.includes('Secret Fundraise'), false);
  assert.equal(serialized.includes('Private Body'), false);
});

test('[EmailImport] Gmail API ignores malformed headers without dropping the whole message', async () => {
  const gmailGet = async (_token, endpoint) => {
    if (endpoint.startsWith('messages?')) return { messages: [{ id: 'messy-1' }] };
    return {
      id: 'messy-1',
      payload: {
        headers: [
          { value: 'missing name should be ignored' },
          { name: 123, value: 'non-string name should be ignored' },
          { name: 'From', value: 'Sender <sender@example.test>' },
          { name: 'To', value: 'Recipient <recipient@example.test>' },
          { name: 'Date', value: 'not a real date' },
          { name: 'Subject', value: 'Still imported' },
        ],
      },
    };
  };

  const result = await fetchEmailsViaGmailAPI('access-token-sentinel', {
    gmailGet,
    logger: { warn: () => assert.fail('malformed non-critical headers should not warn as skipped messages') },
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, 'messy-1');
  assert.equal(result.messages[0].timestamp, null);
  assert.equal(result.messages[0].subject, 'Still imported');
  assert.deepEqual(result.contacts.map(c => c.email).sort(), ['recipient@example.test', 'sender@example.test']);
  assert.deepEqual(result.diagnostics, { skippedMessages: 0 });
});
