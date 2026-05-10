'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRelationshipQueries } = require('../../crm/evaluation');
const { DEFAULT_CASES, readCases, runAgentEvalCase } = require('../../scripts/evaluate-network-memory');

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

test('enforces exact required path values in agent envelopes', () => {
    const cases = [
        {
            query: 'safe envelope',
            requirePathValues: {
                'safety.readOnly': true,
                'safety.contactDetailsOmitted': true,
                'results.0.confidence': 'high',
                'results.0.evidence': [{ kind: 'contact_evidence' }],
            },
        },
        {
            query: 'unsafe envelope',
            requirePathValues: {
                'safety.readOnly': true,
                'safety.contactDetailsOmitted': true,
            },
        },
        {
            query: 'missing envelope',
            requirePathValues: {
                'safety.readOnly': true,
            },
        },
    ];
    const queryFn = (query) => {
        if (query === 'safe envelope') {
            return {
                safety: { readOnly: true, contactDetailsOmitted: true },
                results: [{ confidence: 'high', evidence: [{ kind: 'contact_evidence' }] }],
                diagnostics: { usedFallback: false },
            };
        }
        if (query === 'unsafe envelope') {
            return {
                safety: { readOnly: false, contactDetailsOmitted: false },
                results: [],
                diagnostics: { usedFallback: false },
            };
        }
        return { results: [], diagnostics: { usedFallback: false } };
    };

    const report = evaluateRelationshipQueries(cases, queryFn);

    assert.equal(report.failed, 2);
    assert.deepEqual(report.cases[0].failures, []);
    assert.deepEqual(report.cases[1].failures, [
        'required_path_value_mismatch:safety.readOnly',
        'required_path_value_mismatch:safety.contactDetailsOmitted',
    ]);
    assert.deepEqual(report.cases[2].failures, ['required_path_value_mismatch:safety.readOnly']);
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

test('readCases rejects custom eval fixtures with private-looking strings before running', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-eval-cases-'));
    const emailCasesPath = path.join(tmpDir, 'email-cases.json');
    fs.writeFileSync(emailCasesPath, JSON.stringify([
        {
            name: 'unsafe-private-case',
            target: 'query_network',
            query: 'Find person@gmail.com',
        },
    ]));

    assert.throws(
        () => readCases(emailCasesPath),
        /private-looking eval case value: email-like value at \$\[0\]\.query/
    );

    const tokenCasesPath = path.join(tmpDir, 'token-cases.json');
    fs.writeFileSync(tokenCasesPath, JSON.stringify([
        {
            name: 'unsafe-token-case',
            target: 'query_network',
            query: 'Use sk-test-synthetic0000 for setup',
        },
    ]));

    assert.throws(
        () => readCases(tokenCasesPath),
        /private-looking eval case value: token-like value at \$\[0\]\.query/
    );

    const phoneCasesPath = path.join(tmpDir, 'phone-cases.json');
    fs.writeFileSync(phoneCasesPath, JSON.stringify([
        {
            name: 'unsafe-phone-case',
            target: 'query_network',
            query: 'Find (415) 555-2671',
        },
    ]));

    assert.throws(
        () => readCases(phoneCasesPath),
        /private-looking eval case value: phone-like value at \$\[0\]\.query/
    );

    assert.ok(DEFAULT_CASES.length >= 3, 'default synthetic eval cases still load');
});

test('readCases allows synthetic example domains and explicit sentinel strings', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minty-eval-cases-'));
    const casesPath = path.join(tmpDir, 'cases.json');
    fs.writeFileSync(casesPath, JSON.stringify([
        {
            name: 'safe-synthetic-case',
            target: 'query_network',
            query: 'Find founder@example.test but forbid raw-phone-555-0101',
            forbidSubstrings: ['raw-phone-555-0101', 'founder@example.test'],
        },
    ]));

    assert.deepEqual(readCases(casesPath), [
        {
            name: 'safe-synthetic-case',
            target: 'query_network',
            query: 'Find founder@example.test but forbid raw-phone-555-0101',
            forbidSubstrings: ['raw-phone-555-0101', 'founder@example.test'],
        },
    ]);
});

test('DEFAULT_CASES enforce agent envelope trust/privacy contracts', () => {
    for (const query of ['Who do I know for crypto insurance?', 'Who do I know for EU crypto insurance?']) {
        const positiveCase = DEFAULT_CASES.find(c => c.query === query);
        assert.ok(positiveCase, `${query} eval case should exist`);
        assert.equal(positiveCase.minResults, 1);
        assert.equal(positiveCase.disallowFallback, true);
        assert.deepEqual(positiveCase.requireEvidenceKinds, ['keyword', 'topic']);
        assert.deepEqual(positiveCase.requirePaths, ['safety.readOnly', 'results.0.evidenceBacked']);
        assert.deepEqual(positiveCase.requirePathValues, { 'safety.readOnly': true });
        assert.deepEqual(positiveCase.forbidPaths, ['results.0.email', 'results.0.phone']);
        assert.deepEqual(positiveCase.forbidSubstrings, ['raw-phone-555-0101']);
    }

    const mcpSearchCase = DEFAULT_CASES.find(c => c.name === 'crypto-insurance-mcp-search');
    assert.ok(mcpSearchCase, 'MCP search eval case should exist');
    assert.equal(mcpSearchCase.target, 'mcp:search_network');
    assert.deepEqual(mcpSearchCase.arguments, {
        query: 'Who do I know for crypto insurance?',
    });
    assert.equal(mcpSearchCase.minResults, 1);
    assert.equal(mcpSearchCase.disallowFallback, true);
    assert.deepEqual(mcpSearchCase.requireEvidenceKinds, ['keyword', 'topic']);
    assert.deepEqual(mcpSearchCase.requirePaths, ['safety.readOnly', 'results.0.evidence.0.kind']);
    assert.deepEqual(mcpSearchCase.requirePathValues, { 'safety.readOnly': true });
    assert.deepEqual(mcpSearchCase.forbidPaths, ['results.0.email', 'results.0.phone']);
    assert.deepEqual(mcpSearchCase.forbidSubstrings, ['raw-phone-555-0101']);

    const telegramHealthCase = DEFAULT_CASES.find(c => c.name === 'telegram-source-health-mcp');
    assert.ok(telegramHealthCase, 'MCP source_health eval case should exist');
    assert.equal(telegramHealthCase.target, 'mcp:source_health');
    assert.deepEqual(telegramHealthCase.arguments, { source: 'telegram' });
    assert.equal(telegramHealthCase.disallowFallback, true);
    assert.deepEqual(telegramHealthCase.requirePaths, [
        'safety.readOnly',
        'safety.contactDetailsOmitted',
        'sources.telegram.status',
        'sources.telegram.freshness',
    ]);
    assert.deepEqual(telegramHealthCase.requirePathValues, {
        'safety.readOnly': true,
        'safety.contactDetailsOmitted': true,
    });
    assert.deepEqual(telegramHealthCase.forbidPaths, ['results.0.name', 'results.0.email', 'results.0.phone']);
    assert.deepEqual(telegramHealthCase.forbidSubstrings, ['raw-phone-555-0101']);

    const blockedSourceCase = DEFAULT_CASES.find(c => c.name === 'telegram-source-filter-no-evidence-blocked');
    assert.ok(blockedSourceCase, 'blocked source-filter eval case should exist');
    assert.equal(blockedSourceCase.target, 'mcp:search_network');
    assert.deepEqual(blockedSourceCase.arguments, {
        query: 'impossible private codename zzqv',
        source: 'telegram',
    });
    assert.equal(blockedSourceCase.maxResults, 0);
    assert.equal(blockedSourceCase.disallowFallback, true);
    assert.deepEqual(blockedSourceCase.requirePaths, [
        'safety.readOnly',
        'answerability.status',
        'diagnostics.answerability.status',
    ]);
    assert.deepEqual(blockedSourceCase.requirePathValues, { 'safety.readOnly': true });
    assert.deepEqual(blockedSourceCase.forbidPaths, ['results.0.name', 'results.0.email', 'results.0.phone']);
    assert.deepEqual(blockedSourceCase.forbidSubstrings, ['raw-phone-555-0101']);

    const impossibleCase = DEFAULT_CASES.find(c => c.query === 'Who do I know for impossible private codename zzqv?');
    assert.ok(impossibleCase, 'impossible-query eval case should exist');
    assert.equal(impossibleCase.maxResults, 0);
    assert.equal(impossibleCase.disallowFallback, true);
});
