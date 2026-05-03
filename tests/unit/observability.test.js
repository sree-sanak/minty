'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scrubEvent } = require('../../crm/observability');

describe('scrubEvent', () => {
    it('strips cookies, data, and query_string from request', () => {
        const event = {
            request: {
                cookies: { session: 'abc' },
                data: '{"password":"secret"}',
                query_string: 'token=xyz',
                method: 'POST',
            },
        };
        const result = scrubEvent(event);
        assert.equal(result.request.cookies, undefined);
        assert.equal(result.request.data, undefined);
        assert.equal(result.request.query_string, undefined);
        assert.equal(result.request.method, 'POST'); // non-sensitive kept
    });

    it('strips authorization, cookie, and x-* headers', () => {
        const event = {
            request: {
                headers: {
                    'Authorization': 'Bearer tok_123',
                    'Cookie': 'session=abc',
                    'X-Custom-Token': 'secret',
                    'Content-Type': 'application/json',
                    'x-request-id': 'rid-456',
                },
            },
        };
        const result = scrubEvent(event);
        assert.equal(result.request.headers['Authorization'], undefined);
        assert.equal(result.request.headers['Cookie'], undefined);
        assert.equal(result.request.headers['X-Custom-Token'], undefined);
        assert.equal(result.request.headers['x-request-id'], undefined);
        assert.equal(result.request.headers['Content-Type'], 'application/json');
    });

    it('strips query string from URL', () => {
        const event = {
            request: {
                url: 'https://example.com/api/contacts?search=alice&token=secret',
            },
        };
        const result = scrubEvent(event);
        assert.equal(result.request.url, 'https://example.com/api/contacts');
    });

    it('handles malformed URL gracefully', () => {
        const event = {
            request: { url: 'not-a-url' },
        };
        const result = scrubEvent(event);
        assert.equal(result.request.url, 'not-a-url'); // unchanged
    });

    it('strips user PII fields', () => {
        const event = {
            user: {
                id: '42',
                email: 'alice@example.com',
                ip_address: '192.168.1.1',
                username: 'alice',
            },
        };
        const result = scrubEvent(event);
        assert.equal(result.user.id, '42'); // non-PII kept
        assert.equal(result.user.email, undefined);
        assert.equal(result.user.ip_address, undefined);
        assert.equal(result.user.username, undefined);
    });

    it('returns event unchanged when no request or user present', () => {
        const event = { exception: { values: [{ type: 'Error' }] } };
        const result = scrubEvent(event);
        assert.deepEqual(result, { exception: { values: [{ type: 'Error' }] } });
    });

    it('handles event with both request and user', () => {
        const event = {
            request: {
                url: 'https://example.com/crm?q=test',
                headers: { 'Authorization': 'Bearer x', 'Accept': 'text/html' },
                cookies: { sid: '1' },
            },
            user: { id: '1', email: 'u@x.com', ip_address: '10.0.0.1' },
        };
        const result = scrubEvent(event);
        assert.equal(result.request.url, 'https://example.com/crm');
        assert.equal(result.request.cookies, undefined);
        assert.equal(result.request.headers['Authorization'], undefined);
        assert.equal(result.request.headers['Accept'], 'text/html');
        assert.equal(result.user.id, '1');
        assert.equal(result.user.email, undefined);
    });

    // --- Breadcrumb scrubbing (PII in navigation/HTTP URLs) ---

    it('strips breadcrumbs to prevent PII leaks in navigation URLs', () => {
        const event = {
            breadcrumbs: [
                { category: 'navigation', data: { from: '/contacts?search=alice', to: '/contacts/c_42' } },
                { category: 'http', data: { url: 'https://example.com/api/search?q=bob+smith' } },
                { category: 'console', message: 'loaded contact Alice Chen' },
            ],
        };
        const result = scrubEvent(event);
        assert.equal(result.breadcrumbs, undefined, 'breadcrumbs should be stripped entirely');
    });

    it('handles event with empty breadcrumbs array', () => {
        const event = { breadcrumbs: [] };
        const result = scrubEvent(event);
        assert.equal(result.breadcrumbs, undefined);
    });

    // --- Extra data scrubbing ---

    it('strips extra field which may contain arbitrary debug PII', () => {
        const event = {
            extra: { contactName: 'Alice Chen', query: 'investors in SF' },
            exception: { values: [{ type: 'Error' }] },
        };
        const result = scrubEvent(event);
        assert.equal(result.extra, undefined);
        assert.ok(result.exception, 'non-PII fields preserved');
    });

    // --- Server name scrubbing ---

    it('strips server_name to prevent hostname leaking', () => {
        const event = {
            server_name: 'sree-macbook-pro.local',
            exception: { values: [{ type: 'Error' }] },
        };
        const result = scrubEvent(event);
        assert.equal(result.server_name, undefined);
        assert.ok(result.exception);
    });

    it('strips breadcrumbs, extra, and server_name together', () => {
        const event = {
            request: { url: 'https://example.com/api?token=secret' },
            user: { id: '1', email: 'a@b.com' },
            breadcrumbs: [{ category: 'http', data: { url: '/api/contacts' } }],
            extra: { debug: true },
            server_name: 'prod-1',
        };
        const result = scrubEvent(event);
        assert.equal(result.breadcrumbs, undefined);
        assert.equal(result.extra, undefined);
        assert.equal(result.server_name, undefined);
        assert.equal(result.request.url, 'https://example.com/api');
        assert.equal(result.user.email, undefined);
    });
});
