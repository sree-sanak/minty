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
