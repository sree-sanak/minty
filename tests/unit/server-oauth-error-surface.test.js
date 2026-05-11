const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '../../crm/server.js'), 'utf8');

test('[ServerOAuthErrors]: redirect OAuth token failures use stable public messages', () => {
    assert.doesNotMatch(
        serverSource,
        /Token exchange failed:\s*['"]?\s*\+\s*(?:e|err|error)\.message/,
        'OAuth callback must not concatenate raw provider/network error messages into the client response'
    );
    assert.match(serverSource, /res\.end\('Token exchange failed\. Please retry from the app\.'\)/);
});

test('[ServerOAuthErrors]: provider OAuth errors do not echo raw provider descriptions', () => {
    assert.doesNotMatch(
        serverSource,
        /Google error:\s*['"]?\s*\+\s*\([^)]*error_description[^)]*\)/,
        'OAuth callback must not echo raw provider error_description/error text to clients'
    );
    assert.match(serverSource, /res\.end\('Google authorization failed\. Please retry from the app\.'\)/);
});

test('[ServerOAuthErrors]: device OAuth polling does not return raw exception messages', () => {
    assert.doesNotMatch(
        serverSource,
        /status:\s*'error',\s*message:\s*(?:e|err|error)\.message/,
        'OAuth device polling must not expose raw exception messages'
    );
    assert.doesNotMatch(
        serverSource,
        /status:\s*'error',\s*message:\s*tokens\.error_description\s*\|\|\s*tokens\.error/,
        'OAuth device polling must not expose raw provider error text'
    );
    assert.match(serverSource, /message:\s*'Token exchange failed\. Please restart sign-in from the app\.'/);
    assert.match(serverSource, /message:\s*'Authorization failed\. Please restart sign-in from the app\.'/);
});

test('[ServerOAuthErrors]: device OAuth start does not return raw provider descriptions', () => {
    assert.doesNotMatch(
        serverSource,
        /return json\(res, \{ error: r\.error_description \|\| r\.error \}, 400\)/,
        'OAuth device start must not return raw provider error descriptions'
    );
    assert.match(serverSource, /error:\s*'Microsoft authorization failed\. Please restart sign-in from the app\.'/);
});

test('[ServerOAuthErrors]: OAuth provider selection is allowlisted before starting flows', () => {
    assert.match(serverSource, /function parseOAuthProvider\(value\) \{/);
    assert.match(serverSource, /const provider = parseOAuthProvider\(rawProvider\);/);
    assert.match(serverSource, /if \(!provider\) return json\(res, \{ error: 'unknown provider' \}, 400\);/);
});

test('[ServerOAuthErrors]: OAuth provider failures retain diagnostic details in server logs only', () => {
    assert.match(
        serverSource,
        /logOAuthFailure\('microsoft device start rejected',\s*r\.error_description \|\| r\.error\)/,
        'device OAuth start errors should log provider diagnostics server-side'
    );
    assert.match(
        serverSource,
        /logOAuthFailure\(`\$\{provider \|\| 'unknown'\} device authorization rejected`,\s*tokens\.error_description \|\| tokens\.error\)/,
        'device OAuth provider errors should log provider diagnostics server-side'
    );
    assert.match(
        serverSource,
        /logOAuthFailure\('redirect authorization rejected',\s*tokens\.error_description \|\| tokens\.error\)/,
        'redirect OAuth provider errors should log provider diagnostics server-side'
    );
});
