/**
 * tests/unit/minty-mcp-server.test.js — Unit tests for the Minty MCP server.
 *
 * Tests the MCP protocol handler, tool definitions, and tool execution
 * without spawning a real stdio process.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

// The server exports a handleMessage(json) function for unit testing
const { handleMessage, TOOLS, clampLimit, safeResult } = require('../../scripts/minty-mcp-server');

// ---------------------------------------------------------------------------
// Test fixtures — same shape as agent-retrieval tests
// ---------------------------------------------------------------------------

const CONTACTS = [
    {
        id: 'wa_001', name: 'Alice Müller',
        phones: ['+491234'], emails: ['alice@example.com'],
        sources: { whatsapp: { id: '491234@c.us', name: 'Alice Müller' } },
        lastContactedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        relationshipScore: 72, daysSinceContact: 3, interactionCount: 18,
        activeChannels: ['whatsapp'],
    },
    {
        id: 'li_002', name: 'Bob van Dijk',
        phones: [], emails: ['bob@corp.eu'],
        sources: { linkedin: { name: 'Bob van Dijk', company: 'Munich Re Digital', title: 'Director Crypto Risk' } },
        lastContactedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
        relationshipScore: 55, daysSinceContact: 30, interactionCount: 6,
        activeChannels: ['linkedin'],
    },
    {
        id: 'wa_003', name: 'Carol Chen',
        phones: ['+14155550100'], emails: ['carol@startup.io'],
        sources: { whatsapp: { id: '14155550100@c.us', name: 'Carol Chen' } },
        lastContactedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
        relationshipScore: 30, daysSinceContact: 90, interactionCount: 2,
        activeChannels: ['whatsapp'],
    },
];

const INSIGHTS = {
    wa_001: { topics: ['EU insurance distribution', 'DeFi coverage'], keywords: ['crypto', 'insurance'], sentiment: 'warm' },
    li_002: { topics: ['crypto regulation', 'reinsurance'], keywords: ['crypto', 'risk'], sentiment: 'neutral' },
    wa_003: { topics: ['Node.js', 'devtools'], keywords: ['node', 'startup'], sentiment: 'warm' },
};

function flattenStrings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v => flattenStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach(v => flattenStrings(v, out));
    return out;
}

function assertNoDirectContactDetails(value) {
    const text = flattenStrings(value).join('\n');
    assert.equal(text.includes('alice@example.com'), false, 'must not leak fixture email');
    assert.equal(text.includes('bob@corp.eu'), false, 'must not leak fixture email');
    assert.equal(text.includes('carol@startup.io'), false, 'must not leak fixture email');
    assert.equal(text.includes('+491234'), false, 'must not leak fixture phone');
    assert.equal(text.includes('+141'), false, 'must not leak fixture phone');
}

// ---------------------------------------------------------------------------
// MCP protocol tests
// ---------------------------------------------------------------------------

describe('MCP protocol', () => {
    it('responds to initialize with capabilities', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
        });
        assert.equal(resp.jsonrpc, '2.0');
        assert.equal(resp.id, 1);
        assert.ok(resp.result);
        assert.equal(resp.result.protocolVersion, '2024-11-05');
        assert.ok(resp.result.capabilities);
        assert.ok(resp.result.serverInfo);
        assert.equal(resp.result.serverInfo.name, 'minty');
    });

    it('returns null for notifications/initialized (no response expected)', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', method: 'notifications/initialized',
        });
        assert.equal(resp, null);
    });

    it('returns null for any JSON-RPC notification without id', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', method: 'notifications/somethingNew', params: { ok: true },
        });
        assert.equal(resp, null);
    });

    it('responds to tools/list with all tool definitions', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
        });
        assert.equal(resp.id, 2);
        const tools = resp.result.tools;
        assert.ok(Array.isArray(tools));
        assert.equal(tools.length, 3);
        const names = tools.map(t => t.name).sort();
        assert.deepEqual(names, ['person_context', 'search_network', 'workflow_brief']);
    });

    it('returns error for unknown method', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 99, method: 'bogus/method', params: {},
        });
        assert.ok(resp.error);
        assert.equal(resp.error.code, -32601);
    });
});

// ---------------------------------------------------------------------------
// Tool definition shape tests
// ---------------------------------------------------------------------------

describe('tool definitions', () => {
    it('search_network has query and optional limit', () => {
        const tool = TOOLS.find(t => t.name === 'search_network');
        assert.ok(tool);
        assert.ok(tool.inputSchema.properties.query);
        assert.ok(tool.inputSchema.properties.limit);
        assert.deepEqual(tool.inputSchema.required, ['query']);
    });

    it('person_context has person and optional limit', () => {
        const tool = TOOLS.find(t => t.name === 'person_context');
        assert.ok(tool);
        assert.ok(tool.inputSchema.properties.person);
        assert.deepEqual(tool.inputSchema.required, ['person']);
    });

    it('workflow_brief has goal and optional limit', () => {
        const tool = TOOLS.find(t => t.name === 'workflow_brief');
        assert.ok(tool);
        assert.ok(tool.inputSchema.properties.goal);
        assert.deepEqual(tool.inputSchema.required, ['goal']);
    });
});

// ---------------------------------------------------------------------------
// tools/call tests — search_network
// ---------------------------------------------------------------------------

describe('search_network tool', () => {
    it('returns results for a valid query', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 10, method: 'tools/call',
            params: { name: 'search_network', arguments: { query: 'crypto insurance' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        assert.equal(resp.id, 10);
        assert.ok(resp.result);
        const content = resp.result.content[0];
        assert.equal(content.type, 'text');
        const parsed = JSON.parse(content.text);
        assert.ok(parsed.query);
        assert.ok(Array.isArray(parsed.results));
        assert.ok(parsed.safety);
        assert.equal(parsed.safety.contactDetailsOmitted, true);
        assert.equal(parsed.safety.readOnly, true);
    });

    it('omits emails, phones, rawContact from results', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 11, method: 'tools/call',
            params: { name: 'search_network', arguments: { query: 'Alice' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        const parsed = JSON.parse(resp.result.content[0].text);
        assertNoDirectContactDetails(parsed);
        for (const r of parsed.results) {
            assert.equal(r.emails, undefined, 'emails must not appear');
            assert.equal(r.phones, undefined, 'phones must not appear');
            assert.equal(r.rawContact, undefined, 'rawContact must not appear');
        }
    });

    it('respects limit parameter', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 12, method: 'tools/call',
            params: { name: 'search_network', arguments: { query: 'anyone', limit: 1 } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.ok(parsed.results.length <= 1);
    });

    it('clamps invalid limit values to a safe default', async () => {
        for (const limit of [0, -1, 'abc', 1000]) {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 13, method: 'tools/call',
                params: { name: 'search_network', arguments: { query: 'anyone', limit } },
            }, { contacts: CONTACTS, insights: INSIGHTS });

            const parsed = JSON.parse(resp.result.content[0].text);
            assert.ok(parsed.results.length <= CONTACTS.length);
            assertNoDirectContactDetails(parsed);
        }
    });
});

// ---------------------------------------------------------------------------
// tools/call tests — person_context
// ---------------------------------------------------------------------------

describe('person_context tool', () => {
    it('returns context for a matching person', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 20, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Alice' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        assert.equal(resp.id, 20);
        const content = resp.result.content[0];
        assert.equal(content.type, 'text');
        const parsed = JSON.parse(content.text);
        assertNoDirectContactDetails(parsed);
        assert.ok(parsed.person);
        assert.ok(Array.isArray(parsed.matches));
        assert.ok(parsed.matches.length > 0);
        // Must not contain emails/phones
        for (const m of parsed.matches) {
            assert.equal(m.emails, undefined);
            assert.equal(m.phones, undefined);
        }
    });

    it('returns empty matches for unknown person', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 21, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: 'Nonexistent Person XYZ' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.matches.length, 0);
    });
});

// ---------------------------------------------------------------------------
// tools/call tests — workflow_brief
// ---------------------------------------------------------------------------

describe('workflow_brief tool', () => {
    it('returns brief with required shape', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 30, method: 'tools/call',
            params: { name: 'workflow_brief', arguments: { goal: 'Find EU crypto insurance partners' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        assert.equal(resp.id, 30);
        const parsed = JSON.parse(resp.result.content[0].text);
        assertNoDirectContactDetails(parsed);
        assert.ok(parsed.goal);
        assert.ok(Array.isArray(parsed.topPeople));
        assert.ok(parsed.safety);
        assert.equal(parsed.safety.readOnly, true);
        assert.equal(parsed.safety.contactDetailsOmitted, true);
        // Each person has name, why, suggestedAction
        for (const p of parsed.topPeople) {
            assert.ok(p.name);
            assert.ok(p.why);
            assert.ok(p.suggestedAction);
            assert.equal(p.emails, undefined);
            assert.equal(p.phones, undefined);
        }
    });

    it('includes dataFreshness metadata', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 31, method: 'tools/call',
            params: { name: 'workflow_brief', arguments: { goal: 'anything' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.ok(parsed.dataFreshness);
        assert.ok(parsed.dataFreshness.contactCount != null);
        assert.ok(parsed.dataFreshness.generatedAt);
    });

    it('handles contacts with invalid lastContactedAt without crashing', async () => {
        const badContacts = [
            { id: 'bad_1', name: 'Bad Date', lastContactedAt: 'not-a-date', sources: {}, relationshipScore: 50 },
            ...CONTACTS,
        ];
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 32, method: 'tools/call',
            params: { name: 'workflow_brief', arguments: { goal: 'test resilience' } },
        }, { contacts: badContacts, insights: INSIGHTS });

        assert.equal(resp.id, 32);
        assert.ok(resp.result);
        assert.equal(resp.result.isError, undefined);
        const parsed = JSON.parse(resp.result.content[0].text);
        assert.ok(parsed.dataFreshness);
        // oldestContactDate should be a valid ISO string or null, never "Invalid Date"
        if (parsed.dataFreshness.oldestContactDate) {
            assert.doesNotThrow(() => new Date(parsed.dataFreshness.oldestContactDate).toISOString());
        }
    });

    it('handles contacts where all lastContactedAt are null/missing', async () => {
        const noDateContacts = [
            { id: 'nd_1', name: 'No Date', sources: {}, relationshipScore: 40 },
            { id: 'nd_2', name: 'Also No Date', lastContactedAt: null, sources: {}, relationshipScore: 30 },
        ];
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 33, method: 'tools/call',
            params: { name: 'workflow_brief', arguments: { goal: 'test null dates' } },
        }, { contacts: noDateContacts, insights: {} });

        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.dataFreshness.oldestContactDate, null);
    });
});

// ---------------------------------------------------------------------------
// Malformed / missing loaded data guard
// ---------------------------------------------------------------------------

describe('malformed data guard', () => {
    const MALFORMED_CASES = [
        { label: 'contacts undefined, insights null', data: { contacts: undefined, insights: null } },
        { label: 'contacts null, insights undefined', data: { contacts: null, insights: undefined } },
        { label: 'contacts string, insights string', data: { contacts: 'not-array', insights: 'bad' } },
        { label: 'contacts number, insights boolean', data: { contacts: 42, insights: true } },
        { label: 'empty object', data: {} },
    ];

    for (const { label, data } of MALFORMED_CASES) {
        it(`workflow_brief does not throw with ${label}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 70, method: 'tools/call',
                params: { name: 'workflow_brief', arguments: { goal: 'test resilience' } },
            }, data);

            assert.equal(resp.jsonrpc, '2.0');
            assert.equal(resp.id, 70);
            assert.ok(resp.result);
            const parsed = JSON.parse(resp.result.content[0].text);
            assert.deepEqual(parsed.topPeople, []);
            assert.equal(parsed.dataFreshness.contactCount, 0);
            assert.equal(parsed.safety.readOnly, true);
            assert.equal(parsed.safety.noLlmCalls, true);
            assert.equal(parsed.safety.contactDetailsOmitted, true);
        });

        it(`search_network does not throw with ${label}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 71, method: 'tools/call',
                params: { name: 'search_network', arguments: { query: 'anyone' } },
            }, data);

            assert.equal(resp.jsonrpc, '2.0');
            assert.equal(resp.id, 71);
            assert.ok(resp.result);
            const parsed = JSON.parse(resp.result.content[0].text);
            assert.ok(Array.isArray(parsed.results));
        });

        it(`person_context does not throw with ${label}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 72, method: 'tools/call',
                params: { name: 'person_context', arguments: { person: 'Alice' } },
            }, data);

            assert.equal(resp.jsonrpc, '2.0');
            assert.equal(resp.id, 72);
            assert.ok(resp.result);
            const parsed = JSON.parse(resp.result.content[0].text);
            assert.ok(Array.isArray(parsed.matches));
        });
    }
});

// ---------------------------------------------------------------------------
// Stdio transport regression tests
// ---------------------------------------------------------------------------

describe('stdio transport', () => {
    it('handles Content-Length frames split after the header line', async () => {
        const serverPath = path.join(__dirname, '..', '..', 'scripts', 'minty-mcp-server.js');
        const msg = { jsonrpc: '2.0', id: 77, method: 'initialize', params: {} };
        const body = JSON.stringify(msg);
        const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });

        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n`);
        await new Promise(resolve => setTimeout(resolve, 20));
        child.stdin.end(`\r\n${body}`);

        const exitCode = await new Promise(resolve => child.on('close', resolve));
        assert.equal(exitCode, 0, stderr);
        assert.match(stdout, /^Content-Length: /);
        const payload = stdout.split('\r\n\r\n')[1];
        const parsed = JSON.parse(payload);
        assert.equal(parsed.id, 77);
        assert.equal(parsed.result.serverInfo.name, 'minty');
    });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
    it('returns error for unknown tool name', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 40, method: 'tools/call',
            params: { name: 'delete_everything', arguments: {} },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        assert.ok(resp.error || resp.result.isError);
    });

    it('returns error for missing required argument', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 41, method: 'tools/call',
            params: { name: 'search_network', arguments: {} },
        }, { contacts: CONTACTS, insights: INSIGHTS });

        assert.ok(resp.error || resp.result.isError);
    });
});

// ---------------------------------------------------------------------------
// Blank/whitespace rejection and input trimming
// ---------------------------------------------------------------------------

describe('blank query rejection', () => {
    for (const blank of ['', '   ', '\t', '\n', ' \n\t ']) {
        it(`search_network rejects blank query ${JSON.stringify(blank)}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 50, method: 'tools/call',
                params: { name: 'search_network', arguments: { query: blank } },
            }, { contacts: CONTACTS, insights: INSIGHTS });
            assert.equal(resp.result.isError, true);
            assert.equal(resp.result.content[0].text, 'Missing required argument: query');
        });

        it(`person_context rejects blank person ${JSON.stringify(blank)}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 51, method: 'tools/call',
                params: { name: 'person_context', arguments: { person: blank } },
            }, { contacts: CONTACTS, insights: INSIGHTS });
            assert.equal(resp.result.isError, true);
            assert.equal(resp.result.content[0].text, 'Missing required argument: person');
        });

        it(`workflow_brief rejects blank goal ${JSON.stringify(blank)}`, async () => {
            const resp = await handleMessage({
                jsonrpc: '2.0', id: 52, method: 'tools/call',
                params: { name: 'workflow_brief', arguments: { goal: blank } },
            }, { contacts: CONTACTS, insights: INSIGHTS });
            assert.equal(resp.result.isError, true);
            assert.equal(resp.result.content[0].text, 'Missing required argument: goal');
        });
    }
});

describe('input trimming', () => {
    it('search_network trims query in envelope', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 60, method: 'tools/call',
            params: { name: 'search_network', arguments: { query: '  crypto insurance  ' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });
        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.query, 'crypto insurance');
    });

    it('person_context trims person in envelope', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 61, method: 'tools/call',
            params: { name: 'person_context', arguments: { person: '  Alice  ' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });
        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.person, 'Alice');
    });

    it('workflow_brief trims goal in envelope', async () => {
        const resp = await handleMessage({
            jsonrpc: '2.0', id: 62, method: 'tools/call',
            params: { name: 'workflow_brief', arguments: { goal: '  Find partners  ' } },
        }, { contacts: CONTACTS, insights: INSIGHTS });
        const parsed = JSON.parse(resp.result.content[0].text);
        assert.equal(parsed.goal, 'Find partners');
    });
});

// ---------------------------------------------------------------------------
// clampLimit characterization — documents existing clamping behavior
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
    it('returns fallback for non-finite values', () => {
        assert.equal(clampLimit(undefined, 10), 10);
        assert.equal(clampLimit(null, 10), 10);
        assert.equal(clampLimit(NaN, 10), 10);
        assert.equal(clampLimit(Infinity, 10), 10);
        assert.equal(clampLimit(-Infinity, 10), 10);
        assert.equal(clampLimit('abc', 5), 5);
    });

    it('floors fractional values', () => {
        assert.equal(clampLimit(3.9, 10), 3);
        assert.equal(clampLimit(1.1, 10), 1);
        assert.equal(clampLimit(49.9, 10), 49);
    });

    it('clamps to [1, 50] range', () => {
        assert.equal(clampLimit(0, 10), 1);
        assert.equal(clampLimit(-5, 10), 1);
        assert.equal(clampLimit(1, 10), 1);
        assert.equal(clampLimit(50, 10), 50);
        assert.equal(clampLimit(51, 10), 50);
        assert.equal(clampLimit(1000, 10), 50);
    });

    it('passes through valid integers unchanged', () => {
        assert.equal(clampLimit(5, 10), 5);
        assert.equal(clampLimit(25, 10), 25);
    });
});

// ---------------------------------------------------------------------------
// safeResult characterization — documents privacy-safe field allowlist
// ---------------------------------------------------------------------------

describe('safeResult', () => {
    const FULL_RESULT = {
        name: 'Test User',
        title: 'CTO',
        company: 'Acme Inc',
        city: 'Berlin',
        warmth: 'warm',
        relationshipScore: 80,
        confidence: 'high',
        evidence: [{ field: 'keywords', matched: 'fintech' }],
        suggestedAction: 'Send a message',
        daysSinceContact: 5,
        interactionCount: 12,
        // Sensitive fields that MUST be stripped:
        emails: ['test@example.com'],
        phones: ['+4912345'],
        rawContact: { internal: 'data' },
        sources: { whatsapp: { id: '12345@c.us' } },
        id: 'wa_999',
        activeChannels: ['whatsapp'],
    };

    it('includes only the allowlisted fields', () => {
        const safe = safeResult(FULL_RESULT);
        const keys = Object.keys(safe).sort();
        assert.deepEqual(keys, [
            'city', 'company', 'confidence', 'daysSinceContact',
            'evidence', 'interactionCount', 'name', 'relationshipScore',
            'suggestedAction', 'title', 'warmth',
        ]);
    });

    it('preserves allowed field values exactly', () => {
        const safe = safeResult(FULL_RESULT);
        assert.equal(safe.name, 'Test User');
        assert.equal(safe.title, 'CTO');
        assert.equal(safe.company, 'Acme Inc');
        assert.equal(safe.city, 'Berlin');
        assert.equal(safe.warmth, 'warm');
        assert.equal(safe.relationshipScore, 80);
        assert.equal(safe.confidence, 'high');
        assert.deepEqual(safe.evidence, [{ field: 'keywords', matched: 'fintech' }]);
        assert.equal(safe.suggestedAction, 'Send a message');
        assert.equal(safe.daysSinceContact, 5);
        assert.equal(safe.interactionCount, 12);
    });

    it('strips emails, phones, rawContact, sources, id, activeChannels', () => {
        const safe = safeResult(FULL_RESULT);
        assert.equal(safe.emails, undefined);
        assert.equal(safe.phones, undefined);
        assert.equal(safe.rawContact, undefined);
        assert.equal(safe.sources, undefined);
        assert.equal(safe.id, undefined);
        assert.equal(safe.activeChannels, undefined);
    });

    it('handles result with missing optional fields gracefully', () => {
        const minimal = { name: 'Sparse Contact' };
        const safe = safeResult(minimal);
        assert.equal(safe.name, 'Sparse Contact');
        assert.equal(safe.title, undefined);
        assert.equal(safe.company, undefined);
        assert.equal(safe.emails, undefined);
    });
});
