'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOOLS } = require('../../scripts/minty-mcp-server');
const pkg = require('../../package.json');

const ROOT = path.join(__dirname, '..', '..');
const DOC_PATHS = [
    'docs/HERMES_INTEGRATION.md',
    'hermes/minty-network-memory/SKILL.md',
];

function readDoc(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function assertDocContainsAll(docText, relPath, requiredTerms) {
    for (const term of requiredTerms) {
        assert.ok(
            docText.includes(term),
            `${relPath} must mention ${term}`
        );
    }
}

test('[AgentSurfaceDocs]: Hermes docs and skill mention every MCP tool', () => {
    const toolNames = TOOLS.map(tool => tool.name).sort();
    assert.deepEqual(toolNames, ['person_context', 'search_network', 'source_health', 'workflow_brief']);

    for (const relPath of DOC_PATHS) {
        const doc = readDoc(relPath);
        assertDocContainsAll(doc, relPath, toolNames);
    }
});

test('[AgentSurfaceDocs]: Hermes docs and skill mention required workflow commands', () => {
    const requiredScripts = ['mcp', 'agent', 'memory:refresh', 'hermes:doctor', 'gbrain:export'];
    for (const script of requiredScripts) {
        assert.ok(pkg.scripts[script], `package.json must define npm script ${script}`);
    }

    const requiredCommands = requiredScripts.map(script => `npm run ${script}`);
    for (const relPath of DOC_PATHS) {
        const doc = readDoc(relPath);
        assertDocContainsAll(doc, relPath, requiredCommands);
    }
});

test('[AgentSurfaceDocs]: Hermes skill includes source-health and readiness operating rules', () => {
    const skill = readDoc('hermes/minty-network-memory/SKILL.md');
    for (const phrase of [
        'call `source_health` before source-specific',
        '`source` / `sources` filters',
        'Demo-ready',
        'Dogfood-ready',
        'Hermes-native',
        'Never answer source-specific relationship questions from vibes',
    ]) {
        assert.ok(skill.includes(phrase), `skill must include operating rule: ${phrase}`);
    }
});
