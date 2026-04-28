const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { stripFences } = require('../../crm/ai');

describe('stripFences', () => {
    it('returns plain JSON unchanged', () => {
        assert.equal(stripFences('{"a":1}'), '{"a":1}');
    });

    it('strips ```json fences', () => {
        assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
    });

    it('strips ``` fences without language tag', () => {
        assert.equal(stripFences('```\n[1,2,3]\n```'), '[1,2,3]');
    });

    it('strips ```JSON fences (case-insensitive)', () => {
        assert.equal(stripFences('```JSON\n{"x":"y"}\n```'), '{"x":"y"}');
    });

    it('handles fences without trailing newline before closing', () => {
        assert.equal(stripFences('```json\n{"a":1}```'), '{"a":1}');
    });

    it('handles fences without leading newline after opening', () => {
        assert.equal(stripFences('```json{"a":1}\n```'), '{"a":1}');
    });

    it('trims surrounding whitespace when no fences', () => {
        assert.equal(stripFences('  {"a":1}  '), '{"a":1}');
    });

    it('does not strip fences with leading whitespace (anchored regex)', () => {
        // Fences must start at position 0 — this matches real AI output
        assert.equal(stripFences('  ```json\n{"a":1}\n```  '), '```json\n{"a":1}\n```');
    });

    it('preserves inner newlines in multiline JSON', () => {
        const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
        assert.equal(stripFences(input), '{\n  "a": 1,\n  "b": 2\n}');
    });

    it('returns empty string for empty input', () => {
        assert.equal(stripFences(''), '');
    });

    it('returns trimmed string when no fences present', () => {
        assert.equal(stripFences('  hello world  '), 'hello world');
    });
});
