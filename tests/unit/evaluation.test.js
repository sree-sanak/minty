'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRelationshipQueries } = require('../../crm/evaluation');
const { DEFAULT_CASES, runAgentEvalCase } = require('../../scripts/evaluate-network-memory');

test('evaluates relationship query quality using evidence-backed criteria', () => {
    const cases = [
        { query: 'who do I know in DeFi?', minResults: 1, requireEvidenceKinds: ['contact_evidence'] },
        { query: 'who knows impossible codename?', maxResults: 0 },
    ];
    const queryFn = (query) => {
        if (query.includes('DeFi')) {
            return { results: [{ id: 'c1', evidence: [{ kind: 'contact_evidence' }], confidence: 'high' }], diagnostics: { usedFallback: false } };
        }
        return { results: [], diagnostics: { usedFallback: false } };
    };

    const report = evaluateRelationshipQueries(cases, queryFn);

    assert.equal(report.total, 2);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 0);
    assert.equal(report.cases[0].evidenceBackedResults, 1);
});

test('fails cases that return fallback-only or unevidenced answers', () => {
    const cases = [{ query: 'who knows DeFi?', minResults: 1, requireEvidenceKinds: ['contact_evidence'], disallowFallback: true }];
    const queryFn = () => ({ results: [{ id: 'c1', evidence: [] }], diagnostics: { usedFallback: true } });

    const report = evaluateRelationshipQueries(cases, queryFn);

    assert.equal(report.failed, 1);
    assert.equal(report.cases[0].passed, false);
    assert.equal(report.cases[0].failures.includes('fallback_used'), true);
    assert.equal(report.cases[0].failures.includes('missing_required_evidence'), true);
});

test('enforces required paths, forbidden paths, and forbidden substrings in agent envelopes', () => {
    const cases = [
        {
            query: 'who can help with private sentinel?',
            minResults: 1,
            requirePaths: ['safety.readOnly', 'results.0.evidenceBacked'],
            forbidPaths: ['results.0.email', 'results.0.phone'],
            forbidSubstrings: ['raw-phone-555-0101'],
        },
        {
            query: 'who is missing safety?',
            minResults: 1,
            requirePaths: ['safety.readOnly', 'results.0.evidenceBacked'],
        },
        {
            query: 'who should return no results?',
            expectEmpty: true,
        },
    ];
    const queryFn = (query) => {
        if (query.includes('missing safety')) {
            return {
                results: [{ id: 'c2', evidenceBacked: true }],
                diagnostics: { usedFallback: false },
            };
        }
        if (query.includes('no results')) {
            return {
                results: [{ id: 'c3', evidenceBacked: true }],
                diagnostics: { usedFallback: false },
            };
        }
        return {
            safety: { readOnly: true },
            results: [{
                id: 'c1',
                evidenceBacked: true,
                email: 'founder@example.test',
                summary: 'Reach via redacted context, not raw-phone-555-0101.',
            }],
            diagnostics: { usedFallback: false },
        };
    };

    const report = evaluateRelationshipQueries(cases, queryFn);

    assert.equal(report.failed, 3);
    assert.deepEqual(report.cases[0].failures, ['forbidden_path_present:results.0.email', 'forbidden_substring_present']);
    assert.deepEqual(report.cases[1].failures, ['missing_required_path:safety.readOnly']);
    assert.deepEqual(report.cases[2].failures, ['expected_empty_results']);
});

test('agent-workflows fixture exists, is synthetic, and DEFAULT_CASES loads from it', () => {
    const fs = require('fs');
    const path = require('path');
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'agent-workflows.json');

    // fixture file must exist
    assert.ok(fs.existsSync(fixturePath), 'tests/fixtures/agent-workflows.json must exist');

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    // must be an array of at least 3 cases
    assert.ok(Array.isArray(fixture), 'fixture must be an array');
    assert.ok(fixture.length >= 3, 'fixture must have at least 3 cases');

    // every case must have target and name fields (schema future-proofing)
    for (const c of fixture) {
        assert.ok('target' in c, `case "${c.query || '?'}" must have a target field`);
        assert.ok('name' in c, `case "${c.query || '?'}" must have a name field`);
    }

    // no private-looking data: no real emails, phones, or API keys
    const raw = fs.readFileSync(fixturePath, 'utf8');
    assert.ok(!/@[a-z]+\.[a-z]{2,}/.test(raw.replace(/"[^"]*example\.(com|test|org)[^"]*"/g, '')),
        'fixture must not contain real-looking email addresses');
    assert.ok(!/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(raw.replace(/555-0\d{3}/g, '')),
        'fixture must not contain real-looking phone numbers');

    // DEFAULT_CASES must match the fixture (loaded from file, not inline)
    const defaultCaseQueries = DEFAULT_CASES.map(c => c.query).sort();
    const fixtureCaseQueries = fixture.map(c => c.query).sort();
    assert.deepEqual(defaultCaseQueries, fixtureCaseQueries,
        'DEFAULT_CASES queries must match fixture cases');
});

test('passes structured eval case arguments to the runner while preserving legacy query strings', () => {
    const structuredCases = [{
        name: 'telegram-filtered-query',
        target: 'query_network',
        arguments: { query: 'telegram defi operators', source: 'telegram' },
        minResults: 1,
        requirePaths: ['results.0.matchedSources.0'],
    }];
    const seenStructured = [];
    const structuredReport = evaluateRelationshipQueries(structuredCases, (testCase) => {
        seenStructured.push(testCase.arguments);
        return {
            results: [{ name: 'Tara Telegram', matchedSources: ['telegram'], evidence: [{ kind: 'contact_evidence' }] }],
            diagnostics: { usedFallback: false },
            safety: { readOnly: true },
        };
    });

    assert.deepEqual(seenStructured, [{ query: 'telegram defi operators', source: 'telegram' }]);
    assert.equal(structuredReport.failed, 0);
    assert.equal(structuredReport.cases[0].query, 'telegram defi operators');

    const seenLegacy = [];
    const legacyReport = evaluateRelationshipQueries([{ query: 'who knows DeFi?', maxResults: 0 }], (query) => {
        seenLegacy.push(query);
        return { results: [], diagnostics: { usedFallback: false } };
    });

    assert.deepEqual(seenLegacy, ['who knows DeFi?']);
    assert.equal(legacyReport.failed, 0);
});

test('runAgentEvalCase executes MCP source_health cases as parsed envelopes', async () => {
    const out = await runAgentEvalCase({
        target: 'mcp:source_health',
        arguments: { source: 'telegram' },
    }, {
        contacts: [],
        interactions: [],
        insights: {},
        contactEvidence: {},
        sourceEvents: [],
        hybridIndex: [],
        syncState: { telegram: { lastSyncAt: '2026-05-08T00:00:00Z', status: 'ok' } },
        nowForTests: '2026-05-08T01:00:00Z',
    });

    assert.equal(out.sources && typeof out.sources === 'object' && !Array.isArray(out.sources), true);
    assert.ok(out.sources.telegram);
    assert.equal(out.safety.contactDetailsOmitted, true);
    assert.equal(out.results, undefined, 'source_health must not return people');
});

test('DEFAULT_CASES enforce agent envelope trust/privacy contracts', () => {
    for (const query of ['Who do I know for crypto insurance?', 'Who do I know for EU crypto insurance?']) {
        const positiveCase = DEFAULT_CASES.find(c => c.query === query);
        assert.ok(positiveCase, `${query} eval case should exist`);
        assert.equal(positiveCase.minResults, 1);
        assert.equal(positiveCase.disallowFallback, true);
        assert.deepEqual(positiveCase.requireEvidenceKinds, ['keyword', 'topic']);
        assert.deepEqual(positiveCase.requirePaths, ['safety.readOnly', 'results.0.evidenceBacked']);
        assert.deepEqual(positiveCase.forbidPaths, ['results.0.email', 'results.0.phone']);
        assert.deepEqual(positiveCase.forbidSubstrings, ['raw-phone-555-0101']);
    }

    const impossibleCase = DEFAULT_CASES.find(c => c.query === 'Who do I know for impossible private codename zzqv?');
    assert.ok(impossibleCase, 'impossible-query eval case should exist');
    assert.equal(impossibleCase.maxResults, 0);
    assert.equal(impossibleCase.disallowFallback, true);
});
