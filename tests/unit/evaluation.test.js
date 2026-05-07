'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRelationshipQueries } = require('../../crm/evaluation');

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
    ];
    const queryFn = (query) => {
        if (query.includes('missing safety')) {
            return {
                results: [{ id: 'c2', evidenceBacked: true }],
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

    assert.equal(report.failed, 2);
    assert.deepEqual(report.cases[0].failures, ['forbidden_path_present', 'forbidden_substring_present']);
    assert.deepEqual(report.cases[1].failures, ['missing_required_path']);
});
