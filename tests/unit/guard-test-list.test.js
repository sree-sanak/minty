const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('guard: explicit npm test list', () => {
  it('every test file under tests/unit and tests/integration is listed in scripts.test', () => {
    const root = path.resolve(__dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const testScript = pkg.scripts.test;

    // Collect all *.test.js files from both directories
    const dirs = ['tests/unit', 'tests/integration'];
    const allTestFiles = [];
    for (const dir of dirs) {
      const abs = path.join(root, dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs)) {
        if (f.endsWith('.test.js')) {
          allTestFiles.push(`${dir}/${f}`);
        }
      }
    }

    assert.ok(allTestFiles.length > 0, 'expected to find test files');

    const missing = allTestFiles.filter(f => !testScript.includes(f));
    assert.deepStrictEqual(
      missing,
      [],
      `Test files not listed in package.json scripts.test:\n  ${missing.join('\n  ')}`
    );
  });
});
