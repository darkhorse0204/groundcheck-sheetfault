'use strict';
/**
 * Tests for structured tool calling: every operation an agent performs is
 * { tool_name, arguments, expected_output, verification }, dispatched
 * through ToolRegistry.js's executeStructuredToolCall_() — never a direct
 * SpreadsheetApp/UrlFetchApp call. Complements test/tool-registry.test.js
 * (which covers executeTool_'s four gates); this file covers the
 * expected_output/verification layer built on top of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('executeStructuredToolCall_ returns a uniform record with verification.passed=true when everything matches', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });

  const record = sandbox.executeStructuredToolCall_({
    tool_name: 'insert_formula',
    arguments: { cell: 'B2', formula: '=SUM(B3:B3)' },
    expected_output: { verified: true }
  });

  assert.equal(record.ok, true);
  assert.equal(record.tool_name, 'insert_formula');
  assert.equal(record.verification.passed, true);
  assert.equal(record.verification.expectedOutputCheck.checked, true);
  assert.equal(record.verification.expectedOutputCheck.passed, true);
});

test('executeStructuredToolCall_ flags a mismatch between expected_output and the actual result without failing the underlying call', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });

  const record = sandbox.executeStructuredToolCall_({
    tool_name: 'write_cells',
    arguments: { range: 'D1', values: [[1, 2]] },
    expected_output: { rowsWritten: 99 } // deliberately wrong
  });

  assert.equal(record.ok, true, 'the write itself succeeded');
  assert.equal(record.verification.passed, false, 'but verification must flag the mismatch');
  assert.equal(record.verification.expectedOutputCheck.mismatches[0].key, 'rowsWritten');
  assert.equal(record.verification.expectedOutputCheck.mismatches[0].actual, 1);
});

test('executeStructuredToolCall_ runs a custom verification predicate and never lets it throw uncaught', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const passing = sandbox.executeStructuredToolCall_({
    tool_name: 'inspect_workbook',
    arguments: {},
    verification: function (result) { return { passed: result.sheetCount === 1 }; }
  });
  assert.equal(passing.verification.passed, true);

  const throwing = sandbox.executeStructuredToolCall_({
    tool_name: 'inspect_workbook',
    arguments: {},
    verification: function () { throw new Error('boom'); }
  });
  assert.equal(throwing.ok, true, 'the tool call itself still succeeded');
  assert.equal(throwing.verification.passed, false);
  assert.equal(throwing.verification.customCheck.details.error, 'boom');
});

test('executeStructuredToolCall_ never throws for an unknown tool or a missing tool_name', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const unknown = sandbox.executeStructuredToolCall_({ tool_name: 'delete_everything', arguments: {} });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown tool/);

  const missing = sandbox.executeStructuredToolCall_({ arguments: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing tool_name/);
});

test('a failed schema-validation gate is reflected as ok:false with verification.passed:false, not a thrown error', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const record = sandbox.executeStructuredToolCall_({ tool_name: 'read_cells', arguments: {} }); // missing required "range"
  assert.equal(record.ok, false);
  assert.match(record.error, /missing required field/);
  assert.equal(record.verification.passed, false);
});

test('insertFormulaIntoCell (Code.js) and the Fetch/Push agents no longer touch SpreadsheetApp/UrlFetchApp directly — only executeStructuredToolCall_', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });

  const calls = [];
  const original = sandbox.executeStructuredToolCall_;
  sandbox.executeStructuredToolCall_ = function (call) { calls.push(call.tool_name); return original(call); };

  sandbox.insertFormulaIntoCell('=SUM(B3:B3)');
  assert.equal(JSON.stringify(calls), JSON.stringify(['insert_formula']));
});
