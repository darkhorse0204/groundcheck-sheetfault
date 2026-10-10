'use strict';
/**
 * Regression guard for the very first bug found in this codebase:
 * Code.js used to contain two complete, unmerged definitions of onOpen,
 * showSidebar, handleRequest, insertFormulaIntoCell, getActiveCellFormula,
 * clearChatMemory, and the legacy GAS stubs. Because every .js file at the
 * repo root shares one global GAS namespace, a duplicate top-level
 * `function name() {}` anywhere — within one file OR across two files —
 * silently shadows the earlier one, and the shadowed code never runs again.
 *
 * This test scans every source file (the same way GAS would see them, as
 * one concatenated namespace) and fails if any top-level function name is
 * declared more than once anywhere in the project.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCE_FILES } = require('./support/gasEnvironment');

const REPO_ROOT = path.resolve(__dirname, '..');

test('no top-level function name is declared more than once across the project', () => {
  const declarations = {}; // name -> [{ file, line }]

  for (const file of SOURCE_FILES) {
    const content = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      // Only top-level (no leading whitespace) function declarations count —
      // GAS's global namespace collision only applies to top-level bindings.
      const m = line.match(/^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      if (!m) return;
      const name = m[1];
      declarations[name] = declarations[name] || [];
      declarations[name].push({ file, line: idx + 1 });
    });
  }

  const duplicates = Object.keys(declarations).filter((name) => declarations[name].length > 1);

  if (duplicates.length > 0) {
    const detail = duplicates
      .map((name) => name + ': ' + declarations[name].map((d) => d.file + ':' + d.line).join(', '))
      .join('\n');
    assert.fail('Duplicate top-level function declarations found (last one wins, shadowing the rest):\n' + detail);
  }
});
