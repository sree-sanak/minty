/**
 * crm/evaluation.js — relationship-memory evaluation harness.
 */

'use strict';

function evidenceKinds(result) {
    return new Set((result && Array.isArray(result.evidence) ? result.evidence : []).map(e => e && e.kind).filter(Boolean));
}

function evaluateOne(testCase, queryFn) {
    const output = queryFn(testCase.query);
    const results = Array.isArray(output && output.results) ? output.results : [];
    const diagnostics = output && output.diagnostics || {};
    const failures = [];
    const minResults = Number.isInteger(testCase.minResults) ? testCase.minResults : 0;
    const maxResults = Number.isInteger(testCase.maxResults) ? testCase.maxResults : null;
    if (results.length < minResults) failures.push('too_few_results');
    if (maxResults != null && results.length > maxResults) failures.push('too_many_results');
    if (testCase.disallowFallback !== false && diagnostics.usedFallback) failures.push('fallback_used');
    const requiredKinds = Array.isArray(testCase.requireEvidenceKinds) ? testCase.requireEvidenceKinds : [];
    if (requiredKinds.length) {
        const anyRequired = results.some(r => {
            const kinds = evidenceKinds(r);
            return requiredKinds.every(kind => kinds.has(kind));
        });
        if (!anyRequired) failures.push('missing_required_evidence');
    }
    const evidenceBackedResults = results.filter(r => (r.evidence || []).length > 0 || r.evidenceBacked).length;
    return {
        query: testCase.query,
        passed: failures.length === 0,
        failures,
        resultCount: results.length,
        evidenceBackedResults,
        usedFallback: !!diagnostics.usedFallback,
    };
}

function evaluateRelationshipQueries(cases = [], queryFn) {
    if (typeof queryFn !== 'function') throw new TypeError('queryFn is required');
    const rows = (Array.isArray(cases) ? cases : []).map(testCase => evaluateOne(testCase, queryFn));
    const passed = rows.filter(r => r.passed).length;
    return {
        total: rows.length,
        passed,
        failed: rows.length - passed,
        cases: rows,
    };
}

module.exports = { evaluateRelationshipQueries };
