#!/usr/bin/env node

/**
 * scripts/minty-mcp-server.js — Local MCP server for Minty network memory.
 *
 * Implements MCP JSON-RPC over stdio for Hermes native MCP client.
 * Read-only, no LLM calls, no outreach, source-backed outputs only.
 *
 * Protocol: JSON-RPC 2.0 with Content-Length framing (LSP-style).
 * Supported methods: initialize, notifications/initialized, tools/list, tools/call.
 */

'use strict';

const { queryNetwork } = require('../crm/agent-retrieval');
const { canonicalSafeSource } = require('../crm/source-events');
const { buildAgentSourceHealth, canonicalSource } = require('../crm/agent-source-health');
const { resolveDataDir, loadData } = require('./agent-query');

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
    {
        name: 'search_network',
        description:
            'Search your private network for people matching a natural-language query. ' +
            'Returns ranked results with relationship evidence, warmth, and suggested actions. ' +
            'Read-only — no messages sent, no contacts mutated. Contact details (emails/phones) omitted by default.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Natural-language query, e.g. "investors in London" or "who knows about crypto insurance"' },
                limit: { type: 'number', description: 'Max results (1-50, default 10)' },
                source: { type: 'string', description: 'Restrict to a single source (telegram, whatsapp, linkedin, slack, email, sms, googlecontacts)' },
                sources: { type: 'array', items: { type: 'string' }, description: 'Restrict to multiple sources (telegram, whatsapp, linkedin, slack, email, sms, googlecontacts)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'person_context',
        description:
            'Get context about a specific person in your network. ' +
            'Returns matching contacts with relationship evidence, topics, and warmth. ' +
            'No emails, phones, or raw contact details included.',
        inputSchema: {
            type: 'object',
            properties: {
                person: { type: 'string', description: 'Person name to look up' },
                limit: { type: 'number', description: 'Max matches to return (default 3)' },
            },
            required: ['person'],
        },
    },
    {
        name: 'workflow_brief',
        description:
            'Generate a concise brief for a Hermes workflow goal. ' +
            'Returns top relevant people, why each matters, suggested safe next steps, ' +
            'and data freshness/safety metadata. Read-only, source-backed.',
        inputSchema: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'Workflow goal, e.g. "Find EU crypto insurance partners"' },
                limit: { type: 'number', description: 'Max people to include (default 5)' },
            },
            required: ['goal'],
        },
    },
    {
        name: 'source_health',
        description:
            'Check which Minty sources are fresh, evidence-bearing, and safe for source-specific agent queries. ' +
            'Read-only and redacted. No contact details, raw rows, or token paths exposed.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Optional source filter, e.g. telegram, email, linkedin, whatsapp, sms, googlecontacts, slack' },
                sources: { type: 'array', items: { type: 'string' }, description: 'Optional list of source filters.' },
                query: { type: 'string', description: 'Optional query to infer source filters from diagnostics without returning people.' },
            },
        },
    },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
function clampLimit(value, fallback = 10) {
    if (value == null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(50, Math.floor(n)));
}

function inferSourcesFromQuery(query) {
    if (typeof query !== 'string' || !query.trim()) return [];
    const normalized = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const candidates = new Set();
    for (const token of normalized.split(/\s+/).filter(Boolean)) {
        const source = canonicalSource(token);
        if (source) candidates.add(source);
    }
    for (const phrase of ['google contacts', 'google contact']) {
        if (normalized.includes(phrase)) candidates.add('googleContacts');
    }
    return [...candidates].sort();
}

function safeEvidence(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.map(e => {
        if (!e || typeof e !== 'object') return e;
        const safe = { ...e };
        // Insight topic details can contain raw conversation-derived text.
        // Preserve the evidence signal, but not the sensitive topic string.
        if (safe.kind === 'topic') delete safe.detail;
        return safe;
    });
}

function safeResult(r) {
    const safe = {
        name: r.name,
        title: r.title,
        company: r.company,
        city: r.city,
        warmth: r.warmth,
        relationshipScore: r.relationshipScore,
        confidence: r.confidence,
        evidence: safeEvidence(r.evidence),
        suggestedAction: r.suggestedAction,
        daysSinceContact: r.daysSinceContact,
        interactionCount: r.interactionCount,
    };
    if (r.matchedSources) safe.matchedSources = r.matchedSources;
    return safe;
}

function safeSourceName(value) {
    return canonicalSafeSource(value);
}

function buildDataFreshness(contacts, sourceEvents, sourceCoverage) {
    const oldestContact = contacts.reduce((oldest, c) => {
        if (!c.lastContactedAt) return oldest;
        const t = Date.parse(c.lastContactedAt);
        if (Number.isNaN(t)) return oldest;
        const d = new Date(t);
        return (!oldest || d < oldest) ? d : oldest;
    }, null);

    const generatedAt = new Date();
    const bySource = {};
    const coverage = (sourceCoverage && typeof sourceCoverage === 'object') ? sourceCoverage : {};
    const profileCounts = (coverage.profileContactsBySource && typeof coverage.profileContactsBySource === 'object')
        ? coverage.profileContactsBySource
        : {};
    const hasCoverageEventCounts = coverage.eventCountsBySource && typeof coverage.eventCountsBySource === 'object';
    const eventCounts = hasCoverageEventCounts ? coverage.eventCountsBySource : {};

    for (const [rawSource, count] of Object.entries(profileCounts)) {
        const source = safeSourceName(rawSource);
        if (!source) continue;
        bySource[source] = { profileContactCount: Number.isFinite(count) ? count : 0, eventCount: 0, latestEventAt: null, daysSinceLatestEvent: null };
    }
    for (const [rawSource, count] of Object.entries(eventCounts)) {
        const source = safeSourceName(rawSource);
        if (!source) continue;
        if (!bySource[source]) bySource[source] = { profileContactCount: 0, eventCount: 0, latestEventAt: null, daysSinceLatestEvent: null };
        bySource[source].eventCount = Number.isFinite(count) ? count : 0;
    }

    if (Array.isArray(sourceEvents)) {
        for (const event of sourceEvents) {
            const source = safeSourceName(event && event.source);
            if (!source) continue;
            if (!bySource[source]) bySource[source] = { profileContactCount: 0, eventCount: 0, latestEventAt: null, daysSinceLatestEvent: null };
            if (!hasCoverageEventCounts) bySource[source].eventCount += 1;
            const t = Date.parse(event.timestamp);
            if (Number.isNaN(t)) continue;
            const iso = new Date(t).toISOString();
            if (!bySource[source].latestEventAt || iso > bySource[source].latestEventAt) bySource[source].latestEventAt = iso;
        }
    }

    for (const value of Object.values(bySource)) {
        if (!value.latestEventAt) continue;
        value.daysSinceLatestEvent = Math.max(0, Math.floor((generatedAt.getTime() - Date.parse(value.latestEventAt)) / 86400000));
    }

    return {
        contactCount: contacts.length,
        generatedAt: generatedAt.toISOString(),
        oldestContactDate: oldestContact ? oldestContact.toISOString() : null,
        sourceFreshness: bySource,
        missingCoreSources: Array.isArray(coverage.missingCoreSources) ? coverage.missingCoreSources.map(safeSourceName).filter(Boolean) : [],
    };
}

function executeTool(name, args, data) {
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    const interactions = Array.isArray(data.interactions) ? data.interactions : [];
    const insights = (data.insights && typeof data.insights === 'object' && !Array.isArray(data.insights)) ? data.insights : {};
    const contactEvidence = (data.contactEvidence && typeof data.contactEvidence === 'object' && !Array.isArray(data.contactEvidence)) ? data.contactEvidence : {};
    const sourceEvents = Array.isArray(data.sourceEvents) ? data.sourceEvents : undefined;
    const hybridIndex = Array.isArray(data.hybridIndex) ? data.hybridIndex : undefined;

    if (name === 'search_network') {
        if (!args.query || typeof args.query !== 'string' || !args.query.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'Missing required argument: query' }] };
        }
        const query = args.query.trim();
        const queryOpts = {
            contacts,
            insights,
            interactions,
            contactEvidence,
            sourceEvents,
            hybridIndex,
            limit: clampLimit(args.limit, 10),
        };
        if (args.source) queryOpts.source = args.source;
        if (args.sources) queryOpts.sources = args.sources;
        const result = queryNetwork(query, queryOpts);
        const envelope = {
            query: result.query,
            intent: result.intent,
            results: result.results.map(safeResult),
            diagnostics: result.diagnostics,
            safety: result.safety,
        };
        return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }

    if (name === 'person_context') {
        if (!args.person || typeof args.person !== 'string' || !args.person.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'Missing required argument: person' }] };
        }
        const person = args.person.trim();
        const limit = clampLimit(args.limit, 3);
        const result = queryNetwork(person, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, limit });
        const matches = result.results.map(safeResult);
        const envelope = {
            person,
            matches,
            diagnostics: result.diagnostics,
            safety: result.safety,
        };
        return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }

    if (name === 'workflow_brief') {
        if (!args.goal || typeof args.goal !== 'string' || !args.goal.trim()) {
            return { isError: true, content: [{ type: 'text', text: 'Missing required argument: goal' }] };
        }
        const goal = args.goal.trim();
        const limit = clampLimit(args.limit, 5);
        const result = queryNetwork(goal, { contacts, insights, interactions, contactEvidence, sourceEvents, hybridIndex, limit });
        const topPeople = result.results.map(r => ({
            name: r.name,
            title: r.title,
            company: r.company,
            warmth: r.warmth,
            confidence: r.confidence,
            daysSinceContact: r.daysSinceContact,
            why: (r.evidence || []).map(e => e.label).join('; ') || 'General network match',
            suggestedAction: r.suggestedAction,
        }));
        const envelope = {
            goal,
            intent: result.intent,
            topPeople,
            dataFreshness: buildDataFreshness(contacts, sourceEvents, result.diagnostics && result.diagnostics.sourceCoverage),
            diagnostics: result.diagnostics,
            safety: {
                contactDetailsOmitted: true,
                readOnly: true,
                noLlmCalls: true,
                noOutreachTriggered: true,
            },
        };
        return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }

    if (name === 'source_health') {
        const syncState = (data.syncState && typeof data.syncState === 'object' && !Array.isArray(data.syncState)) ? data.syncState : {};
        let querySourceFilter;
        let inferredSources;
        if (args.query && typeof args.query === 'string' && args.query.trim()) {
            inferredSources = inferSourcesFromQuery(args.query);
            querySourceFilter = inferredSources;
        }
        const envelope = buildAgentSourceHealth(
            { contacts, interactions, contactEvidence, sourceEvents, syncState },
            {
                source: args.source,
                sources: args.sources || inferredSources,
                querySourceFilter,
                now: data.nowForTests,
            },
        );
        return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] };
    }

    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
}

// ---------------------------------------------------------------------------
// MCP message handler (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Handle a single MCP JSON-RPC message.
 * @param {object} msg - Parsed JSON-RPC message
 * @param {object} [data] - Optional pre-loaded { contacts, insights } for testing
 * @returns {object|null} JSON-RPC response, or null for notifications
 */
function handleMessage(msg, data) {
    const { id, method, params } = msg;

    // JSON-RPC notifications have no id and must not receive a response.
    // MCP sends notifications/initialized, but this also avoids noisy errors for
    // future client notifications we do not explicitly know yet.
    if (id === undefined) return null;

    if (method === 'initialize') {
        return {
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'minty', version: '0.3.2' },
            },
        };
    }

    if (method === 'tools/list') {
        return {
            jsonrpc: '2.0', id,
            result: { tools: TOOLS },
        };
    }

    if (method === 'tools/call') {
        const toolName = params && params.name;
        const args = (params && params.arguments) || {};

        // Load data if not provided (production path)
        if (!data) {
            const dataDir = resolveDataDir();
            if (!dataDir) {
                return {
                    jsonrpc: '2.0', id,
                    result: {
                        isError: true,
                        content: [{ type: 'text', text: 'No Minty data found. Run "npm run seed:demo" or set CRM_DATA_DIR.' }],
                    },
                };
            }
            data = loadData(dataDir);
        }

        const result = executeTool(toolName, args, data);
        return { jsonrpc: '2.0', id, result };
    }

    // Unknown method
    return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` },
    };
}

// ---------------------------------------------------------------------------
// Stdio transport — Content-Length framed JSON-RPC
// ---------------------------------------------------------------------------

if (require.main === module) {
    const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
    let buffer = Buffer.alloc(0);

    process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (buffer.length > MAX_MESSAGE_BYTES) {
            sendResponse({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Invalid request: MCP frame exceeds maximum size' },
            });
            buffer = Buffer.alloc(0);
            return;
        }
        processBuffer();
    });

    function processBuffer() {
        while (true) {
            // MCP stdio clients commonly use newline-delimited JSON. Some LSP-style
            // clients use Content-Length framing. Support both so Minty works across
            // Hermes, Claude Desktop, and low-level smoke tests.
            const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'));
            const firstNewline = buffer.indexOf(0x0a);
            const lowerPrefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString('ascii').toLowerCase();
            const startsFramed = lowerPrefix.startsWith('content-length:');
            const looksFramed = startsFramed && headerEnd !== -1;

            if (startsFramed && headerEnd === -1) return; // wait for complete framed header

            if (!looksFramed) {
                if (firstNewline === -1) return;
                const line = buffer.subarray(0, firstNewline).toString('utf8').trim();
                buffer = buffer.subarray(firstNewline + 1);
                if (!line) continue;
                handleBody(line, 'line');
                continue;
            }

            const header = buffer.subarray(0, headerEnd).toString('ascii');
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                buffer = buffer.subarray(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            if (contentLength > MAX_MESSAGE_BYTES) {
                sendResponse({
                    jsonrpc: '2.0', id: null,
                    error: { code: -32600, message: 'Invalid request: MCP frame exceeds maximum size' },
                });
                buffer = buffer.subarray(headerEnd + 4);
                continue;
            }
            const bodyStart = headerEnd + 4;
            if (buffer.length < bodyStart + contentLength) return; // wait for more data

            const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
            buffer = buffer.subarray(bodyStart + contentLength);
            handleBody(body, 'framed');
        }
    }

    function handleBody(body, responseMode) {
        let msg;
        try {
            msg = JSON.parse(body);
        } catch (err) {
            sendResponse({
                jsonrpc: '2.0', id: null,
                error: { code: -32700, message: 'Parse error: ' + err.message },
            }, responseMode);
            return;
        }

        try {
            const resp = handleMessage(msg);
            if (resp) sendResponse(resp, responseMode);
        } catch (err) {
            sendResponse({
                jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null,
                error: { code: -32603, message: 'Internal error: ' + err.message },
            }, responseMode);
        }
    }

    function sendResponse(resp, mode = 'line') {
        const body = JSON.stringify(resp);
        if (mode === 'framed') {
            const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
            process.stdout.write(header + body);
        } else {
            process.stdout.write(body + '\n');
        }
    }

    // Graceful shutdown
    process.stdin.on('end', () => process.exit(0));
}

module.exports = { handleMessage, TOOLS, clampLimit, safeResult };
