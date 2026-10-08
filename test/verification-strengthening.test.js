'use strict';
/**
 * Tests for the Verification.js strengthening: circular references, real
 * QUERY column-letter validation (replacing dead "ColA"-style code that
 * never matched actual Sheets QUERY syntax), and range bounds now covering
 * rows as well as columns. Retry-only-after-structured-feedback was already
 * covered by test/agent-retry-and-memory.test.js (buildRetryFeedback_ picks
 * up whatever lands in verifyFormula_'s errors/warnings/hints arrays
 * automatically, so no changes were needed there).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

function baseContext(sandbox, overrides) {
  return Object.assign(sandbox.buildDeepContext(), overrides || {});
}

test('verifyCircularReference_ catches a direct self-reference cheaply (no SpreadsheetApp graph walk needed)', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });
  const context = baseContext(sandbox, { sheetName: 'Sheet1', activeCell: 'B2' });

  const result = sandbox.verifyCircularReference_('=B2*2', context);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /directly references its own cell/);
});

test('verifyCircularReference_ catches a deeper cycle through existing workbook formulas', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', '=C2'], ['', '']]
  });
  // C2 doesn't exist yet in the grid (only 2 cols) — put a formula there that
  // will point back at B4, the cell we're about to verify a formula for.
  spreadsheet.getActiveSheet().getRange('C2').setFormula('=B4');

  const context = baseContext(sandbox, { sheetName: 'Sheet1', activeCell: 'B4' });
  // Candidate formula for B4 that reads B3, which reads C2, which reads B4 — a cycle.
  const result = sandbox.verifyCircularReference_('=B3', context);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /circular reference chain/);
});

test('verifyCircularReference_ allows a normal, non-circular formula', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  const context = baseContext(sandbox, { sheetName: 'Sheet1', activeCell: 'C1' });
  const result = sandbox.verifyCircularReference_('=SUM(B2:B3)', context);
  assert.equal(result.errors.length, 0);
});

test('verifyQueryColumns_ validates real QUERY column-letter syntax (not the old dead "ColA" pattern)', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  const context = baseContext(sandbox);

  // Out-of-bounds column reference inside the query string.
  const outOfBounds = sandbox.verifyQueryColumns_('=QUERY(A1:B3,"SELECT D WHERE B > 50")', context);
  assert.equal(outOfBounds.errors.length, 1);
  assert.match(outOfBounds.errors[0], /column D/);

  // In-bounds, valid query — no errors, and QUERY keywords (SELECT/WHERE/BY)
  // must not be mistaken for column letters.
  const valid = sandbox.verifyQueryColumns_('=QUERY(A1:B3,"SELECT A, B WHERE B > 50 ORDER BY B")', context);
  assert.equal(valid.errors.length, 0);
});

test('a formula with a self-referencing QUERY column bug is rejected end-to-end via verifyFormula_', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  const context = baseContext(sandbox);
  const result = sandbox.verifyFormula_('=QUERY(A1:B3,"SELECT Z")', context);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /column Z/.test(e)));
});

test('verifyRangeBounds_ is sheet-aware: wholly-outside ranges are flagged, partial overshoot is just headroom', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });
  const context = baseContext(sandbox); // 2 rows, 2 cols

  // Range that starts below the last data row covers no data -> warning.
  const below = sandbox.verifyRangeBounds_('=SUM(B5:B500)', context);
  assert.ok(below.warnings.some((w) => /below the last row/.test(w)));

  // Range that merely extends past the data is normal headroom -> a note, not a finding.
  const headroom = sandbox.verifyRangeBounds_('=SUM(B2:B500)', context);
  assert.equal(headroom.warnings.length, 0);
  assert.ok(headroom.notes.some((n) => /headroom/.test(n)));

  // Whole range in columns beyond the used range -> hard error.
  const col = sandbox.verifyRangeBounds_('=SUM(D1:D10)', context);
  assert.ok(col.errors.some((e) => /Column D/.test(e)));

  const noWarning = sandbox.verifyRangeBounds_('=SUM(B1:B2)', context);
  assert.equal(noWarning.warnings.length, 0);
});

test('bounds are checked against the sheet a reference points at, not the active sheet', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]] // 2 columns
  });
  spreadsheet._addSheet('Wide', [['A', 'B', 'C', 'D', 'E', 'F'], [1, 2, 3, 4, 5, 6]]);
  const context = baseContext(sandbox);

  // Column F exists on "Wide" even though the active sheet only has 2 columns.
  assert.equal(sandbox.verifyFormula_('=SUM(Wide!F2:F2)', context).valid, true);
  // ...but column G does not.
  const bad = sandbox.verifyFormula_('=SUM(Wide!G2:G2)', context);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /Column G/.test(e)));
});

test('verifyHallucinations_ still validates cross-sheet references even when the active sheet has no headers', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [[]] });
  const context = baseContext(sandbox, { sheetName: 'Sheet1', headers: [] });

  const result = sandbox.verifyHallucinations_('=NoSuchSheet!A1', context);
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /does not exist/);
});
