# API/UI Error Redaction Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop Minty API and UI error paths from returning raw internal exception messages while keeping local debugging useful.

**Architecture:** Add one small public-error helper in `crm/server.js`, use it at the highest-risk API catch sites from issue #44, and render generic UI fallback copy for caught client-side exceptions. Keep detailed errors in local `console.error`/server logs only. This is a privacy hardening slice, not a full observability rewrite.

**Tech Stack:** Plain Node.js CommonJS, existing `createServer()` integration harness, inline SPA in `crm/ui.html.js`, Node built-in test runner. No new dependencies, provider calls, sends, uploads, deploys, or runtime LLM calls.

---

## Product context

Issue #44 is the remaining open `agent-ready` privacy bug after the source-quality and trust-contract work. Minty now has strong source readiness, MCP envelopes, source importer contracts, and source-quality workbench coverage, but several API/UI catch blocks still expose raw `e.message` text. In a local private-memory product, raw errors can include temp paths, parser details, OAuth/provider internals, filenames, stack fragments, or private source-state details.

This is not generic polish. Hermes/OpenClaw can only trust Minty as private network memory if failure states are also privacy-safe. The right product behavior is: users see stable, actionable public copy; local logs preserve enough detail for debugging.

## Current code anchors

- `crm/server.js:368-370` has the shared `json(res, data, status)` helper.
- `crm/server.js:373-384` parses JSON request bodies and currently rejects with raw parser errors.
- `crm/server.js:485-508` returns raw `e.message` from `POST /api/meetings/:id/debrief`.
- `crm/server.js:558-594` returns raw `e.message` from `GET /api/life-events`.
- `crm/server.js:1559-1572` returns raw `e.message` from `POST /api/settings/seed-demo`.
- `crm/server.js:2118-2130` logs import failures but returns raw `e.message` from `POST /api/upload/:source`.
- `crm/server.js:2133-2140` already has `safeErrorLogMetadata(err)` and `tests/integration/api-data-resilience.test.js:109-120` covers sanitized log metadata.
- `crm/server.js:4320` currently exports `{ createServer, safeErrorLogMetadata }`; extend this for new pure helpers.
- `crm/ui.html.js:2110`, `2122`, `2265`, `3958`, `5007`, `5154`, `5391`, `5791`, and `5914` render caught `e.message` directly.
- `tests/integration/api-data-resilience.test.js` already has `withServer()`, `seedDataDir()`, and read-only privacy regression tests. Extend this file instead of creating a new harness.

## Acceptance criteria

- API 500 responses use stable public messages such as `Request failed. Check local logs for details.` or route-specific safe copy, not raw exception text.
- 4xx validation errors may remain specific when authored by Minty and not derived from a raw parser/provider exception.
- Local `console.error` still receives useful detailed errors for debugging.
- Malformed JSON body errors return a generic parse message without raw `SyntaxError`, stack fragments, byte positions, local paths, provider names, or token-looking strings.
- High-risk API paths from issue #44 are covered first: debrief save, life events, seed demo, upload/import, and JSON body parsing.
- UI catch blocks no longer render raw caught `e.message` into HTML/alerts/log text for generic load/query/render failures.
- Tests prove sensitive sentinel strings from thrown errors do not appear in response bodies or UI helper output.

## Non-goals

- No broad API response schema migration.
- No removal of detailed local logs.
- No provider/OAuth flow rewrite.
- No masking of intentionally safe status/progress messages that are already sanitized by source-progress helpers.
- No attempt to eliminate every `console.error(e.message)` in local-only logs.
- No external sends, provider mutations, data export, deploys, or cron changes.

---

### Task 1: Add public error helpers and unit coverage

**Objective:** Create small reusable helpers that turn arbitrary exceptions into stable public API/UI copy.

**Files:**
- Modify: `crm/server.js`
- Modify: `tests/integration/api-data-resilience.test.js`

**Step 1: Write failing helper tests**

Update the import in `tests/integration/api-data-resilience.test.js` from:

```js
const { safeErrorLogMetadata } = require('../../crm/server');
```

to:

```js
const { publicErrorMessage, publicErrorPayload, safeErrorLogMetadata } = require('../../crm/server');
```

Append near the existing `safeErrorLogMetadata` test:

```js
test('publicErrorPayload redacts internal exception detail', () => {
    const err = new Error('ENOENT: no such file or directory, open ' + path.join(os.tmpdir(), 'private-source.json'));
    err.code = 'ENOENT';

    const payload = publicErrorPayload('load failed', err);

    assert.deepEqual(payload, {
        error: 'load failed',
        message: 'Request failed. Check local Minty logs for details.',
    });
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(os.tmpdir()), false);
    assert.equal(serialized.includes('private-source.json'), false);
    assert.equal(serialized.includes('ENOENT'), false);
});

test('publicErrorMessage never echoes raw parser or provider messages', () => {
    const raw = 'SyntaxError: Expected property name or provider token at /tmp/private.json';
    const message = publicErrorMessage(raw);

    assert.equal(message, 'Request failed. Check local Minty logs for details.');
    assert.equal(message.includes('SyntaxError'), false);
    assert.equal(message.includes('/tmp/private.json'), false);
    assert.equal(message.includes('token'), false);
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: FAIL because `publicErrorMessage` and `publicErrorPayload` are not exported.

**Step 3: Implement minimal helpers**

In `crm/server.js`, near `json()` add:

```js
const DEFAULT_PUBLIC_ERROR_MESSAGE = 'Request failed. Check local Minty logs for details.';

function publicErrorMessage(message) {
    if (typeof message === 'string' && /^[A-Za-z0-9 .,'():;_-]{1,160}$/.test(message)) {
        const lower = message.toLowerCase();
        const unsafe = lower.includes('syntaxerror')
            || lower.includes('token')
            || lower.includes('enoent')
            || lower.includes('stack')
            || lower.includes('at json.parse')
            || message.includes('/')
            || message.includes('\\')
            || message.includes('@');
        if (!unsafe) return message;
    }
    return DEFAULT_PUBLIC_ERROR_MESSAGE;
}

function publicErrorPayload(error, err, options = {}) {
    const payload = {
        error: publicErrorMessage(error),
        message: publicErrorMessage(options.message || DEFAULT_PUBLIC_ERROR_MESSAGE),
    };
    if (options.code && /^[a-z0-9_-]{1,40}$/i.test(options.code)) payload.code = options.code;
    if (err && options.logContext) console.error(options.logContext, err);
    return payload;
}
```

Then update the export:

```js
module.exports = { createServer, publicErrorMessage, publicErrorPayload, safeErrorLogMetadata };
```

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/server.js tests/integration/api-data-resilience.test.js
git commit -m "feat: add public error redaction helpers"
```

---

### Task 2: Redact malformed JSON body errors

**Objective:** Ensure raw JSON parser exceptions never become API responses.

**Files:**
- Modify: `crm/server.js`
- Modify: `tests/integration/api-data-resilience.test.js`

**Step 1: Add failing route regression test**

Append to `tests/integration/api-data-resilience.test.js`:

```js
test('malformed JSON request bodies return generic public errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-bad-body-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/meetings/private_event_ref/debrief`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"notes":',
        });
        assert.equal(res.status, 400);
        const text = await res.text();
        assert.doesNotMatch(text, /Expected|JSON|SyntaxError|position|private_event_ref|stack/i);
        const payload = JSON.parse(text);
        assert.equal(payload.error, 'Invalid JSON request body.');
        assert.equal(payload.message, 'Request failed. Check local Minty logs for details.');
    });
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: FAIL because `body()` currently rejects with the raw JSON parser exception and route catch blocks may echo it.

**Step 3: Mark JSON parse errors safely**

Modify `body()` in `crm/server.js`:

```js
req.on('end', () => {
    try {
        resolve(JSON.parse(s));
    } catch (e) {
        const err = new Error('Invalid JSON request body.');
        err.status = 400;
        err.publicMessage = 'Invalid JSON request body.';
        err.cause = e;
        reject(err);
    }
});
```

Keep the payload-too-large branch specific but safe:

```js
if (size > max) {
    req.destroy();
    const err = new Error('Request body too large.');
    err.status = 413;
    err.publicMessage = 'Request body too large.';
    reject(err);
    return;
}
```

**Step 4: Route through public payload in debrief save**

Update `handleSaveDebrief()` catch:

```js
} catch (e) {
    console.error('[meetings] failed to save debrief:', e);
    json(res, publicErrorPayload(e.publicMessage || 'Could not save debrief.', e), e.status || 400);
}
```

**Step 5: Run test to verify pass**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: PASS.

**Step 6: Commit**

```bash
git add crm/server.js tests/integration/api-data-resilience.test.js
git commit -m "fix: redact malformed JSON body errors"
```

---

### Task 3: Redact high-risk API 500 responses

**Objective:** Replace raw `e.message` responses on the highest-risk issue #44 routes with safe public payloads.

**Files:**
- Modify: `crm/server.js`
- Modify: `tests/integration/api-data-resilience.test.js`

**Step 1: Add route-level failing tests with synthetic private paths**

Add tests that monkeypatch safe anchors rather than touching real private data. Start with exported helpers where possible; if a route is hard to trigger without broad refactor, cover the catch block by corrupting temp fixture data.

Append:

```js
test('life-events route does not expose raw local parser errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-life-events-error-'));
    seedDataDir(dir, []);
    fs.writeFileSync(path.join(dir, 'unified/contacts.json'), '{bad private contacts json');

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/life-events`);
        assert.equal(res.status, 500);
        const text = await res.text();
        assert.doesNotMatch(text, /Expected|JSON|SyntaxError|contacts\.json|private|stack|at JSON\.parse/i);
        const payload = JSON.parse(text);
        assert.equal(payload.error, 'Could not load life events.');
    });
});

test('upload route failure does not expose importer internals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-upload-error-'));
    seedDataDir(dir, []);

    await withServer(dir, async (base) => {
        const res = await fetch(`${base}/api/upload/telegram`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ not: 'multipart' }),
        });
        assert.ok([400, 415, 500].includes(res.status));
        const text = await res.text();
        assert.doesNotMatch(text, /uploads|TELEGRAM_EXPORT_FILE|ENOENT|SyntaxError|stack|\/tmp\//i);
    });
});
```

If the upload route does not execute for JSON requests, adjust the fixture to a minimal malformed multipart request that reaches the existing catch block. Keep all files under `os.tmpdir()`.

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: FAIL on at least `GET /api/life-events` because it returns raw parser text today.

**Step 3: Replace high-risk raw `e.message` responses**

Patch these catch blocks in `crm/server.js`:

```js
// handleGetLifeEvents
} catch (e) {
    console.error('[life-events] failed:', e);
    json(res, publicErrorPayload('Could not load life events.', e), 500);
}

// handleSeedDemo
} catch (e) {
    console.error('[settings] seed demo failed:', e);
    json(res, publicErrorPayload('Could not regenerate demo data.', e), 500);
}

// upload/import catch around line 2127
} catch (e) {
    console.error('[upload] import failed:', e);
    json(res, publicErrorPayload('Could not import source file.', e), 500);
}
```

Also patch any nearby raw 500 response touched by tests, but do not chase every route in this task.

**Step 4: Run focused tests**

Run:

```bash
node --test tests/integration/api-data-resilience.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/server.js tests/integration/api-data-resilience.test.js
git commit -m "fix: redact high-risk api error responses"
```

---

### Task 4: Stop rendering generic caught UI exception messages

**Objective:** Prevent raw client-side or fetch exception strings from being rendered into the Minty UI for generic load/query failures.

**Files:**
- Modify: `crm/ui.html.js`
- Test: `tests/unit/ui-helpers.test.js` if it exists; otherwise add static regression coverage to `tests/unit/agent-surface-docs.test.js` or create `tests/unit/ui-error-redaction.test.js`.

**Step 1: Add static UI regression test**

Create `tests/unit/ui-error-redaction.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const UI = path.join(ROOT, 'crm/ui.html.js');

test('generic UI catch blocks do not render raw e.message', () => {
    const src = fs.readFileSync(UI, 'utf8');
    const unsafePatterns = [
        /Render error:\s*['"`]?\s*\+\s*esc\(e\.message\)/,
        /Failed to load contacts:\s*['"`]?\s*\+\s*esc\(e\.message\)/,
        /Query failed:\s*\$\{esc\(e\.message\)\}/,
        /alert\(e\.message\)/,
        /log\.textContent\s*=\s*'✗ '\s*\+\s*e\.message/,
    ];
    for (const pattern of unsafePatterns) {
        assert.equal(pattern.test(src), false, `UI still renders raw caught exception: ${pattern}`);
    }
});
```

**Step 2: Run test to verify failure**

Run:

```bash
node --test tests/unit/ui-error-redaction.test.js
```

Expected: FAIL because several generic catch blocks currently render `e.message`.

**Step 3: Add UI helper and patch generic catch blocks**

In `crm/ui.html.js`, near existing escape helpers, add:

```js
function publicUiError(prefix) {
  return prefix || 'Something went wrong. Check local Minty logs for details.';
}
```

Patch the catch blocks identified by the test to use generic copy, for example:

```js
if (listEl) listEl.innerHTML = '<div class="loading" style="color:#ef4444">' + esc(publicUiError('Render error. Check local Minty logs for details.')) + '</div>';
```

```js
if (listEl) listEl.innerHTML = '<div class="loading" style="color:#ef4444">' + esc(publicUiError('Failed to load contacts. Check local Minty logs for details.')) + '</div>';
```

```js
el.innerHTML = `<div style="color:var(--health-cold);padding:20px;text-align:center">${esc(publicUiError('Query failed. Check local Minty logs for details.'))}</div>`;
```

```js
} catch (e) { alert(publicUiError('Request failed. Check local Minty logs for details.')); }
```

For source-progress messages that come from sanitized server state (`s.progress.message`, `li.lastError?.message`, etc.), do not change behavior in this task unless the message is directly from a caught exception object.

**Step 4: Run test to verify pass**

Run:

```bash
node --test tests/unit/ui-error-redaction.test.js
```

Expected: PASS.

**Step 5: Commit**

```bash
git add crm/ui.html.js tests/unit/ui-error-redaction.test.js
git commit -m "fix: redact generic ui exception messages"
```

---

### Task 5: Final privacy and regression verification

**Objective:** Prove the slice closes issue #44 without breaking core Minty behavior.

**Files:**
- No new files unless fixing a failing check.

**Step 1: Run focused tests**

```bash
node --test tests/integration/api-data-resilience.test.js
node --test tests/unit/ui-error-redaction.test.js
```

Expected: PASS.

**Step 2: Run full tests**

```bash
npm test
```

Expected: PASS.

**Step 3: Run e2e because the SPA changed**

```bash
npm run test:e2e
```

Expected: PASS. If Playwright browser setup is missing, run `npx playwright install chromium` once and rerun.

**Step 4: Scan the diff for unsafe response/rendering patterns**

```bash
git diff --check HEAD~4..HEAD
git diff HEAD~4..HEAD -- crm/server.js crm/ui.html.js tests/integration/api-data-resilience.test.js tests/unit/ui-error-redaction.test.js | grep -E "json\(res, \{ error: e\.message|esc\(e\.message\)|alert\(e\.message\)|stack|ENOENT|SyntaxError|/root/|token=" || true
```

Expected: no production code emits raw `e.message`; any matches are split synthetic test sentinels or local log-only calls.

**Step 5: Close or update issue #44 after merge**

If all checks pass and the PR lands, comment on #44 with the exact routes hardened and verification commands. Close #44 only if no remaining raw API/UI `e.message` responses from the issue body are still present; otherwise leave it open with the remaining route list.

```bash
gh issue comment 44 --body "Hardened the first API/UI error-redaction slice: JSON body parsing, debrief save, life events, seed demo, upload/import, and generic UI catch blocks. Verified with node --test tests/integration/api-data-resilience.test.js, node --test tests/unit/ui-error-redaction.test.js, npm test, and npm run test:e2e."
```

## Builder notes

- Keep public errors boring and stable. Do not leak exception text to make UI copy feel helpful.
- Log detailed errors locally with route context; redact API/UI responses.
- Prefer exact route tests over broad snapshot tests.
- Do not introduce a new error framework or dependency.
- Do not change provider/OAuth behavior beyond public response copy unless a focused test requires it.
- Treat issue #44 as a staged hardening effort if the remaining raw responses are numerous; ship the safest high-risk slice first.
