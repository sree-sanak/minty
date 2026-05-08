'use strict';

const { test, expect } = require('@playwright/test');

test.describe('@smoke export', () => {
    test('unencrypted export returns a non-empty bundle', async ({ request }) => {
        const res = await request.get('/api/export');
        expect(res.ok()).toBeTruthy();
        const buf = await res.body();
        expect(buf.length).toBeGreaterThan(0);
    });

    test('encrypted export accepts passphrase only in POST body', async ({ request }) => {
        const queryRes = await request.get('/api/export?passphrase=leaky-secret');
        expect(queryRes.status()).toBe(400);
        expect(queryRes.headers()['content-type']).toContain('application/json');
        const queryPayload = await queryRes.json();
        expect(queryPayload.error).toContain('POST body');

        for (const invalidPayload of [{}, { passphrase: '' }, { passphrase: 123 }]) {
            const invalidPostRes = await request.post('/api/export', { data: invalidPayload });
            expect(invalidPostRes.status()).toBe(400);
            expect((await invalidPostRes.json()).error).toContain('passphrase');
        }

        const postRes = await request.post('/api/export', { data: { passphrase: 'correct-horse' } });
        expect(postRes.ok()).toBeTruthy();
        expect(postRes.headers()['x-minty-encrypted']).toBe('1');
        expect(postRes.headers()['content-disposition']).toContain('.minty.bundle');
        const buf = await postRes.body();
        expect(buf.length).toBeGreaterThan(0);
    });
});
