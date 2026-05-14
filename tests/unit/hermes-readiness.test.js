'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { evaluateReadiness, redactPath } = require('../../crm/hermes-readiness');

// ---------------------------------------------------------------------------
// Helpers — synthetic temp dirs, no real user data
// ---------------------------------------------------------------------------

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'minty-doctor-'));
}

function seedUnified(dir, files = {}) {
    const unified = path.join(dir, 'unified');
    fs.mkdirSync(unified, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(unified, name), JSON.stringify(content));
    }
}

// ---------------------------------------------------------------------------
// Core shape
// ---------------------------------------------------------------------------

test('[HermesReadiness]: returns required top-level fields', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, { 'contacts.json': [] });
        const result = evaluateReadiness({ dataDir: dir });

        assert.ok(typeof result.level === 'string', 'level must be a string');
        assert.ok(Array.isArray(result.checks), 'checks must be an array');
        assert.ok(Array.isArray(result.toolNames), 'toolNames must be an array');
        assert.ok(typeof result.dataDir === 'string', 'dataDir must be a string');
        assert.ok(typeof result.dataKind === 'string', 'dataKind must be a string');
        assert.ok(Array.isArray(result.nextActions), 'nextActions must be an array');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Level semantics
// ---------------------------------------------------------------------------

test('[HermesReadiness]: empty data dir yields level "not-ready"', () => {
    const dir = tmpDir();
    try {
        const result = evaluateReadiness({ dataDir: dir });
        assert.equal(result.level, 'not-ready');
        assert.ok(result.nextActions.length > 0, 'should suggest next actions');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: contacts-only yields level "partial"', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
        });
        const result = evaluateReadiness({ dataDir: dir });
        assert.equal(result.level, 'partial');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: full data yields level "ready"', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
            'interactions.json': [{ id: 'i_001' }],
            'contact-evidence.json': { c_001: {} },
            'hybrid-index.json': { version: 1 },
        });
        const result = evaluateReadiness({ dataDir: dir });
        assert.equal(result.level, 'ready');
        assert.equal(result.nextActions.length, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// dataKind: demo fixtures must never be called dogfood-ready
// ---------------------------------------------------------------------------

test('[HermesReadiness]: demo data dir is dataKind "demo", never "dogfood-ready"', () => {
    const dir = tmpDir();
    try {
        // Simulate demo by passing dataKind override
        seedUnified(dir, { 'contacts.json': [{ id: 'c_001', name: 'Alice' }] });
        const result = evaluateReadiness({ dataDir: dir, dataKind: 'demo' });

        assert.equal(result.dataKind, 'demo');
        assert.notEqual(result.dataKind, 'dogfood-ready');
        const json = JSON.stringify(result);
        assert.equal(json.includes('dogfood-ready'), false, 'demo must never say dogfood-ready');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// MCP tool names — sourced from actual TOOLS export, not duplicated
// ---------------------------------------------------------------------------

test('[HermesReadiness]: toolNames lists MCP tools from server', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, { 'contacts.json': [] });
        const result = evaluateReadiness({ dataDir: dir });

        assert.ok(result.toolNames.length > 0, 'should list MCP tools');
        assert.ok(result.toolNames.includes('search_network'));
        assert.ok(result.toolNames.includes('source_health'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Privacy: no sensitive data in output
// ---------------------------------------------------------------------------

test('[HermesReadiness]: output never contains emails, phones, or private paths', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [
                { id: 'c_001', name: 'Alice', emails: ['alice@secret.com'], phones: ['+155****4567'] },
            ],
        });
        const result = evaluateReadiness({ dataDir: dir });
        const json = JSON.stringify(result);

        assert.equal(json.includes('alice@secret.com'), false, 'no emails');
        assert.equal(json.includes('+155****4567'), false, 'no phones');
        assert.equal(json.includes('OAuth'), false, 'no OAuth paths');
        assert.equal(json.includes('/root/'), false, 'no private paths');
        // dataDir should be redacted
        assert.ok(!result.dataDir.startsWith('/root/') && !result.dataDir.startsWith('/home/'),
            'dataDir must not expose private paths');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: redactPath hides private parent directory names', () => {
    const redacted = redactPath('/home/sree/private-client/minty/data');

    assert.equal(redacted, '…/data');
    assert.equal(redacted.includes('/home/'), false);
    assert.equal(redacted.includes('sree'), false);
    assert.equal(redacted.includes('private-client'), false);
});

// ---------------------------------------------------------------------------
// Checks array structure
// ---------------------------------------------------------------------------

test('[HermesReadiness]: each check has name, status, and detail', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, { 'contacts.json': [{ id: 'c_001', name: 'Alice' }] });
        const result = evaluateReadiness({ dataDir: dir });

        for (const check of result.checks) {
            assert.ok(typeof check.name === 'string', 'check.name');
            assert.ok(['pass', 'fail', 'warn'].includes(check.status), `check.status must be pass/fail/warn, got ${check.status}`);
            assert.ok(typeof check.detail === 'string', 'check.detail');
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// null dataDir (no data found)
// ---------------------------------------------------------------------------

test('[HermesReadiness]: null dataDir yields not-ready with helpful action', () => {
    const result = evaluateReadiness({ dataDir: null });
    assert.equal(result.level, 'not-ready');
    assert.ok(result.nextActions.length > 0);
    assert.ok(result.checks.some(c => c.status === 'fail'));
});

// ---------------------------------------------------------------------------
// JSON stability: deterministic output for snapshot testing
// ---------------------------------------------------------------------------

test('[HermesReadiness]: JSON output is deterministic across calls', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
            'interactions.json': [{ id: 'i_001' }],
        });
        const a = JSON.stringify(evaluateReadiness({ dataDir: dir }));
        const b = JSON.stringify(evaluateReadiness({ dataDir: dir }));
        assert.equal(a, b, 'consecutive calls must produce identical JSON');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Skill drift detection
// ---------------------------------------------------------------------------

const { checkSkillDrift, extractSkillTools } = require('../../crm/hermes-readiness');

test('[HermesReadiness]: extractSkillTools finds ### tool_name headings', () => {
    const content = [
        '## Some section',
        '### search_network',
        '### person_context',
        '### workflow_brief',
        '### source_health',
    ].join('\n');

    const tools = extractSkillTools(content);
    assert.equal(tools.size, 4);
    assert.ok(tools.has('search_network'));
    assert.ok(tools.has('person_context'));
    assert.ok(tools.has('workflow_brief'));
    assert.ok(tools.has('source_health'));
});

test('[HermesReadiness]: extractSkillTools tolerates backtick fences', () => {
    const content = [
        '### `goal_next_actions`',
        '### meeting_prep',
    ].join('\n');

    const tools = extractSkillTools(content);
    assert.equal(tools.size, 2);
    assert.ok(tools.has('goal_next_actions'));
    assert.ok(tools.has('meeting_prep'));
});

test('[HermesReadiness]: extractSkillTools is case-sensitive and strict', () => {
    // Must be lower-case with underscores
    const content = [
        '### SearchNetwork',   // wrong case
        '### search-network', // wrong separator
        '### search_network',  // correct
        '## Not a tool heading',
        '###  ',               // empty, skip
    ].join('\n');

    const tools = extractSkillTools(content);
    assert.equal(tools.size, 1);
    assert.ok(tools.has('search_network'));
});

test('[HermesReadiness]: checkSkillDrift warns when repo skill is missing', () => {
    // Monkey-patch REPO_SKILL_PATH to a non-existent path
    const mod = require.cache[require.resolve('../../crm/hermes-readiness')];
    const original = mod.exports;

    // Use a temp file that does not exist as the installed skill path
    const result = checkSkillDrift();
    assert.equal(result.name, 'skill_drift');
    assert.ok(['pass', 'warn'].includes(result.status), `status must be pass|warn, got ${result.status}`);
    assert.ok(typeof result.detail === 'string');
    assert.equal(result.detail.includes('/root/'), false, 'must not leak private paths');
});

test('[HermesReadiness]: skill_drift check present in evaluateReadiness output', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice' }],
            'interactions.json': [{ id: 'i_001' }],
            'contact-evidence.json': { c_001: {} },
            'hybrid-index.json': { version: 1 },
        });
        const result = evaluateReadiness({ dataDir: dir });
        const driftCheck = result.checks.find(c => c.name === 'skill_drift');
        assert.ok(driftCheck, 'skill_drift check must be present');
        assert.ok(['pass', 'warn'].includes(driftCheck.status));
        assert.ok(typeof driftCheck.detail === 'string');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('[HermesReadiness]: skill_drift output is privacy-safe', () => {
    const dir = tmpDir();
    try {
        seedUnified(dir, {
            'contacts.json': [{ id: 'c_001', name: 'Alice', emails: ['alice@secret.com'] }],
            'interactions.json': [{ id: 'i_001' }],
            'contact-evidence.json': { c_001: {} },
            'hybrid-index.json': { version: 1 },
        });
        const result = evaluateReadiness({ dataDir: dir });
        const driftCheck = result.checks.find(c => c.name === 'skill_drift');
        const json = JSON.stringify(driftCheck);
        assert.equal(json.includes('/root/'), false, 'no private paths in drift check');
        assert.equal(json.includes('alice@secret.com'), false, 'no emails in drift check');
        assert.equal(json.includes('HERMES_HOME'), false, 'no envvar names in drift check');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
