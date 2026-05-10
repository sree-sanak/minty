/**
 * crm/evaluation.js — relationship-memory evaluation harness.
 */

'use strict';

const { isDeepStrictEqual } = require('node:util');

function evidenceKinds(result) {
    return new Set((result && Array.isArray(result.evidence) ? result.evidence : []).map(e => e && e.kind).filter(Boolean));
}

function getPathValue(value, path) {
    if (typeof path !== 'string' || path.trim() === '') return { exists: false, value: undefined };
    let current = value;
    for (const part of path.split('.')) {
        if (current == null || (typeof current !== 'object' && typeof current !== 'function')) return { exists: false, value: undefined };
        if (!Object.hasOwn(current, part)) return { exists: false, value: undefined };
        current = current[part];
    }
    return { exists: current !== undefined, value: current };
}

function hasPath(value, path) {
    return getPathValue(value, path).exists;
}

function sameJsonValue(actual, expected) {
    return isDeepStrictEqual(actual, expected);
}

function containsSubstring(value, needle) {
    if (typeof needle !== 'string' || needle === '') return false;
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.includes(needle);
}

function evaluateOne(testCase, queryFn) {
    const runnerInput = testCase && testCase.arguments ? testCase : testCase.query;
    const output = queryFn(runnerInput);
    const results = Array.isArray(output && output.results) ? output.results : [];
    const diagnostics = output && output.diagnostics || {};
    const queryLabel = testCase.query || (testCase.arguments && testCase.arguments.query) || testCase.name || '';
    const failures = [];
    const minResults = Number.isInteger(testCase.minResults) ? testCase.minResults : 0;
    const maxResults = Number.isInteger(testCase.maxResults) ? testCase.maxResults : null;
    if (results.length < minResults) failures.push('too_few_results');
    if (maxResults != null && results.length > maxResults) failures.push('too_many_results');
    if (testCase.expectEmpty === true && results.length > 0) failures.push('expected_empty_results');
    if (testCase.disallowFallback !== false && diagnostics.usedFallback) failures.push('fallback_used');
    const requiredKinds = Array.isArray(testCase.requireEvidenceKinds) ? testCase.requireEvidenceKinds : [];
    if (requiredKinds.length) {
        const anyRequired = results.some(r => {
            const kinds = evidenceKinds(r);
            return requiredKinds.every(kind => kinds.has(kind));
        });
        if (!anyRequired) failures.push('missing_required_evidence');
    }
    const requiredPaths = Array.isArray(testCase.requirePaths) ? testCase.requirePaths : [];
    for (const path of requiredPaths) {
        if (!hasPath(output, path)) failures.push(`missing_required_path:${path}`);
    }
    const requiredPathValues = testCase && testCase.requirePathValues && typeof testCase.requirePathValues === 'object' && !Array.isArray(testCase.requirePathValues)
        ? testCase.requirePathValues
        : {};
    for (const [path, expected] of Object.entries(requiredPathValues)) {
        const actual = getPathValue(output, path);
        if (!actual.exists || !sameJsonValue(actual.value, expected)) failures.push(`required_path_value_mismatch:${path}`);
    }
    const forbiddenPaths = Array.isArray(testCase.forbidPaths) ? testCase.forbidPaths : [];
    for (const path of forbiddenPaths) {
        if (hasPath(output, path)) failures.push(`forbidden_path_present:${path}`);
    }
    const forbiddenSubstrings = Array.isArray(testCase.forbidSubstrings) ? testCase.forbidSubstrings : [];
    if (forbiddenSubstrings.some(needle => containsSubstring(output, needle))) failures.push('forbidden_substring_present');
    const evidenceBackedResults = results.filter(r => (r.evidence || []).length > 0 || r.evidenceBacked).length;
    return {
        query: queryLabel,
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
