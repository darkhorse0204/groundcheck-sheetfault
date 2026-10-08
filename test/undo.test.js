'use strict';
/**
 * Regression test for an undo "split-brain" bug that used to exist:
 * Tools.js declared its own top-level `undoLastAction()` / `hasUndoAvailable()`
 * backed by a single PropertiesService key (LAST_UNDO), which collided with
 * Code.js's ENTERPRISE-backed versions of the same names in the shared GAS
 * global namespace. Because clasp loads files
 * alphabetically and Tools.js sorts after Code.js, Tools.js's copies silently
 * won — so the sidebar's Undo button (which calls the ENTERPRISE-backed
 * undoLastEnterprise()) would find an empty stack even immediately after a
 * formula insertion, because insertFormulaIntoCell() and the Fetch Agent both
 * wrote to LAST_UNDO instead of ENTERPRISE.undo.
 *
 * These tests exercise the full push -> pop round trip through every entry
 * point the sidebar and Planner use, to prove there is now exactly one undo
 * system.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('insertFormulaIntoCell() pushes onto ENTERPRISE.undo (not a separate LAST_UNDO key)', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox, stores } = env;
  // Default active cell is B2, which currently holds 100 (East revenue).

  assert.equal(sandbox.hasUndoAvailable(), false, 'nothing should be undoable before any write');

  sandbox.insertFormulaIntoCell('=SUM(B3:B3)');

  assert.equal(stores.userProperties.getProperty('LAST_UNDO'), null, 'the legacy single-slot undo key must no longer be used');
  assert.ok(stores.userProperties.getProperty('ENT_UNDO'), 'ENTERPRISE.undo must have persisted a snapshot');

  assert.equal(sandbox.hasUndoAvailable(), true);
  assert.equal(sandbox.getUndoStack().length, 1);
});

test('undoLastEnterprise() restores the exact pre-write value, and the stack drains to empty', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox, spreadsheet } = env;

  sandbox.insertFormulaIntoCell('=SUM(B3:B3)');

  const sheet = spreadsheet.getActiveSheet();
  assert.equal(sheet.getRange('B2').getFormula(), '=SUM(B3:B3)');

  const message = sandbox.undoLastEnterprise();

  assert.match(message, /Undid:/);
  assert.equal(sheet.getRange('B2').getValue(), 100, 'the original value must be restored after undo');
  assert.equal(sheet.getRange('B2').getFormula(), '', 'the formula must be gone after undo');
  assert.equal(sandbox.hasUndoAvailable(), false, 'the stack must be empty after popping its only entry');

  assert.throws(() => sandbox.undoLastEnterprise(), /Nothing to undo/);
});

test('undoLastAction() (legacy stub) and undoLastEnterprise() are the same stack, not two', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100]
    ]
  });
  const { sandbox } = env;

  sandbox.insertFormulaIntoCell('=A1*2'); // active cell is B2 — must not self-reference
  assert.equal(sandbox.getUndoStack().length, 1);

  // The legacy-named entry point must drain the exact same ENTERPRISE stack.
  sandbox.undoLastAction();
  assert.equal(sandbox.hasUndoAvailable(), false);
});

test("agentFetchData_'s destination range (not just the active cell) is snapshotted for undo", () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ],
    urlFetchStub: (url) => {
      if (String(url).indexOf('generativelanguage') !== -1) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"url":"https://api.example.com/users"}' }] } }]
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
      };
    }
  });
  const { sandbox, spreadsheet } = env;

  const result = sandbox.agentFetchData_('get 2 fake users', sandbox.buildDeepContext());
  assert.ok(result.isData);

  const stack = sandbox.getUndoStack();
  assert.equal(stack.length, 1);
  // The destination range must span the full written grid (2 cols x 3 rows:
  // header + 2 data rows), not a single cell — otherwise undo can only ever
  // restore 1/6th of what was overwritten.
  assert.equal(stack[0].range, 'B2:C4');

  sandbox.undoLastEnterprise();
  const sheet = spreadsheet.getActiveSheet();
  // B2 held the seeded Revenue value (100) before the fetch overwrote it.
  assert.equal(sheet.getRange('B2').getValue(), 100);
  // C2 had no seeded data at all, so it must go back to blank, not stay 'Ada'.
  assert.equal(sheet.getRange('C2').getValue(), '');
});
