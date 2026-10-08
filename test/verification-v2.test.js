'use strict';
/**
 * Workbook-grounded verification layers added on top of the structural checks:
 * symbols, sheet-aware bounds, shape (arity / lookup index / range sizes),
 * grounding (text columns, values that never occur), and range-aware circularity.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

const DATA = [
  ['Region', 'Product', 'Qty', 'Revenue'],
  ['East', 'Widget', 5, 100],
  ['West', 'Gadget', 3, 250],
  ['North', 'Widget', 7, 175],
  ['East', 'Gizmo', 2, 60]
];

function env(extra) {
  const e = createGasEnvironment(Object.assign({ sheetData: DATA.map((r) => r.slice()) }, extra || {}));
  e.spreadsheet._addSheet('Prices', [['Product', 'Price'], ['Widget', 9.5], ['Gadget', 12], ['Gizmo', 3]]);
  e.sandbox.console = { log() {}, warn() {}, error() {} };
  e.spreadsheet.getActiveSheet().setActiveCellPosition(7, 6); // F7: empty, outside the table
  return e;
}
const verify = (e, f, overrides) => e.sandbox.verifyFormula_(f, Object.assign(e.sandbox.buildDeepContext(), overrides || {}));

test('a correct formula passes with no errors or warnings', () => {
  const e = env();
  const r = verify(e, '=SUMIF(A2:A5,"East",D2:D5)');
  assert.equal(r.valid, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
});

test('column headers used as identifiers are rejected with a column-letter hint', () => {
  const e = env();
  const r = verify(e, '=SUM(Revenue)');
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /"Revenue" is not a function, named range or cell reference/);
  assert.ok(r.hints.some((h) => /column D/.test(h)));
});

test('named ranges are accepted as identifiers; LET/LAMBDA variables are not mistaken for references', () => {
  const e = env({ namedRanges: [{ name: 'RevRange', a1: 'D2:D5' }] });
  assert.equal(verify(e, '=SUM(RevRange)').valid, true);
  assert.equal(verify(e, '=LET(x,SUM(D2:D5),x*2)').valid, true);
  assert.equal(verify(e, '=MAP(D2:D5,LAMBDA(v,v*2))').valid, true);
});

test('near-miss function names are hard errors with "did you mean"; far-miss names are warnings', () => {
  const e = env();
  const typo = verify(e, '=SUMIFF(A2:A5,"East",D2:D5)');
  assert.equal(typo.valid, false);
  assert.ok(typo.hints.some((h) => /Did you mean SUMIF\?/.test(h)));
  const far = verify(e, '=MYTAX(D2)');
  assert.equal(far.valid, true);
  assert.ok(far.warnings.some((w) => /Unknown function "MYTAX"/.test(w)));
});

test('the function whitelist covers the official Sheets list (PRODUCT, AVERAGEIFS, GEOMEAN, ...)', () => {
  const e = env();
  ['=PRODUCT(C2:C5)', '=AVERAGEIFS(D2:D5,A2:A5,"East",B2:B5,"Widget")', '=GEOMEAN(D2:D5)', '=MAXIFS(D2:D5,A2:A5,"East")'].forEach((f) => {
    const r = verify(e, f);
    assert.equal(r.errors.length, 0, f);
    assert.equal(r.warnings.filter((w) => /Unknown function/.test(w)).length, 0, f);
  });
});

test('sheet names are case-insensitive, as in Sheets', () => {
  const e = env();
  assert.equal(verify(e, '=VLOOKUP("Widget",prices!A:B,2,FALSE)').valid, true);
  assert.equal(verify(e, '=VLOOKUP("Widget",Price!A:B,2,FALSE)').valid, false);
});

test('arity is checked for known functions', () => {
  const e = env();
  const r = verify(e, '=SUMIF(A2:A5)');
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /SUMIF expects 2-3 arguments but got 1/);
  assert.equal(verify(e, '=IF(C2>1,"a")').valid, true, 'IF with two arguments is valid in Sheets');
});

test('VLOOKUP index beyond the lookup range is an error', () => {
  const e = env();
  const r = verify(e, '=VLOOKUP("Widget",Prices!A:B,3,FALSE)');
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /index 3 is outside the lookup range/);
});

test('mismatched range sizes in SUMIFS / SUMPRODUCT are errors', () => {
  const e = env();
  assert.equal(verify(e, '=SUMIFS(D2:D5,A2:A5,"East")').valid, true);
  const bad = verify(e, '=SUMIFS(D2:D5,A2:A4,"East")');
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /different sizes/);
  assert.equal(verify(e, '=SUMPRODUCT(C2:C5,D2:D4)').valid, false);
});

test('grounding: text columns in numeric aggregates and absent criteria are "suspicious", not errors', () => {
  const e = env();
  const text = verify(e, '=SUM(A2:A5)');
  assert.equal(text.valid, true);
  assert.ok(text.suspicious.some((s) => /column of text/.test(s)));
  const ghost = verify(e, '=COUNTIF(A2:A5,"Northeast")');
  assert.equal(ghost.valid, true);
  assert.ok(ghost.suspicious.some((s) => /Criterion "Northeast" never occurs/.test(s)));
  assert.ok(ghost.hints.some((h) => /East, West, North/.test(h)));
  // wildcards, operators and values that do occur are not suspicious
  assert.equal(verify(e, '=COUNTIF(A2:A5,"Ea*")').suspicious.length, 0);
  assert.equal(verify(e, '=COUNTIF(D2:D5,">100")').suspicious.length, 0);
  assert.equal(verify(e, '=COUNTIF(A2:A5,"east")').suspicious.length, 0);
});

test('REPAIR_ON_SUSPICIOUS makes verificationNeedsRepair_ treat suspicious findings as failures', () => {
  const e = env();
  const r = verify(e, '=COUNTIF(A2:A5,"Northeast")');
  assert.equal(e.sandbox.verificationNeedsRepair_(r), false);
  e.sandbox.CONFIG.VERIFICATION.REPAIR_ON_SUSPICIOUS = true;
  assert.equal(e.sandbox.verificationNeedsRepair_(r), true);
});

test('circularity: a range containing the target cell is caught (totals-row mistake)', () => {
  const e = env();
  e.spreadsheet.getActiveSheet().setActiveCellPosition(6, 4); // D6, the totals row under Revenue
  const inRange = verify(e, '=SUM(D2:D6)');
  assert.equal(inRange.valid, false);
  assert.match(inRange.errors[0], /includes its own cell \(D6\)/);
  assert.equal(verify(e, '=SUM(D:D)').valid, false);
  assert.equal(verify(e, '=SUM(D2:D5)').valid, true, 'the ordinary totals formula is fine');
});

test('circularity: chains through a formula that reads a range containing the target are caught', () => {
  const e = env();
  e.spreadsheet.getActiveSheet().setActiveCellPosition(6, 4); // D6
  e.spreadsheet.getSheetByName('Prices').getRange('D1').setFormula('=SUM(Sheet1!D2:D6)');
  const r = verify(e, '=Prices!D1*2');
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /circular reference chain/);
});

test('circularity: ROW/ROWS/COLUMN/COLUMNS read only a reference geometry, so they never create a cycle', () => {
  const e = env();
  e.spreadsheet.getActiveSheet().setActiveCellPosition(6, 4); // D6
  assert.equal(verify(e, '=ROWS(D$2:D6)').valid, true);
  assert.equal(verify(e, '=COLUMNS($A:D)+ROW(D6)').valid, true);
  assert.equal(verify(e, '=SUM(D2:D6)+ROWS(D2:D6)').valid, false, 'a real dependency in the same formula is still caught');
});

test('circularity is judged against the explicit target cell when one is given', () => {
  const e = env();
  const ctx = e.sandbox.buildDeepContext(); // active cell F7
  const elsewhere = e.sandbox.targetContext_(ctx, 'Sheet1', 'D6');
  assert.equal(e.sandbox.verifyFormula_('=SUM(D2:D6)', elsewhere).valid, false);
  assert.equal(e.sandbox.verifyFormula_('=SUM(D2:D6)', ctx).valid, true);
});

test('unqualified references resolve against the destination sheet when a tool writes to another sheet', () => {
  const e = env();
  const ctx = e.sandbox.buildDeepContext(); // active sheet Sheet1: 4 columns
  // Prices has 2 columns: D2:D3 is beyond its used range, but fine on Sheet1.
  const onPrices = e.sandbox.targetContext_(ctx, 'Prices', 'F1');
  assert.equal(e.sandbox.verifyFormula_('=SUM(D2:D3)', onPrices).valid, false);
  assert.equal(e.sandbox.verifyFormula_('=SUM(D2:D3)', ctx).valid, true);
});

test('bounds: references wholly past the used columns are errors; headroom rows are not findings', () => {
  const e = env();
  assert.equal(verify(e, '=SUM(Z2:Z5)').valid, false);
  const headroom = verify(e, '=SUM(D2:D500)');
  assert.equal(headroom.valid, true);
  assert.equal(headroom.warnings.length, 0);
});

test('bounds: emptiness tests (COUNTA/COUNTBLANK/ISBLANK) may point at empty regions', () => {
  const e = env();
  assert.equal(verify(e, '=IF(COUNTA(K2:M2)=0,"",1)').valid, true);
  assert.equal(verify(e, '=COUNTBLANK(K2:M5)').valid, true);
  assert.equal(verify(e, '=SUM(K2:M2)').valid, false, 'aggregating an empty region is still rejected');
});

test('structural: parentheses inside strings are not counted; real imbalance still fails', () => {
  const e = env();
  assert.equal(verify(e, '=IF(A2="(",1,2)').valid, true);
  assert.equal(verify(e, '=SUM(D2:D5').valid, false);
  assert.equal(verify(e, '=SUM(D2:D5)+').valid, false);
});

test('layers can be switched off individually (used by the ablation study)', () => {
  const e = env();
  assert.equal(verify(e, '=SUMIFS(D2:D5,A2:A4,"East")').valid, false);
  e.sandbox.CONFIG.VERIFICATION.LAYERS.shape = false;
  assert.equal(verify(e, '=SUMIFS(D2:D5,A2:A4,"East")').valid, true);
});

test('a deleted reference left in a formula (#REF!) or an unrecognised name (#NAME?) is an error; other error literals are allowed', () => {
  const e = env();
  const r = verify(e, '=IF(A2="East",#REF!,0)');
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /#REF!/);
  assert.ok(r.hints.some((h) => /deleted reference/i.test(h)));
  assert.equal(verify(e, '=A2&#NAME?').valid, false);
  assert.equal(verify(e, '=IFERROR(D2/D3,#N/A)').valid, true);   // an intentional #N/A is fine
  assert.equal(verify(e, '=SUM(D2:D5)').valid, true);
});

test('INDIRECT with a text literal naming a missing sheet is an error; names built at run time are left alone', () => {
  const e = env();
  assert.equal(verify(e, '=INDIRECT("Prices!B2")').valid, true);
  assert.equal(verify(e, `=INDIRECT("'Prices'!B2")`).valid, true);
  const bad = verify(e, '=INDIRECT("Sheet9!A1")');
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0], /INDIRECT refers to sheet "Sheet9"/);
  assert.ok(bad.hints.some((h) => /Available sheets/.test(h)));
  assert.equal(verify(e, '=INDIRECT("Sheet9!A"&ROW())').valid, false);        // the leading text still names the sheet
  assert.equal(verify(e, '=INDIRECT(A2)').valid, true);                       // built from a cell: not checkable
  assert.equal(verify(e, '=INDIRECT("A"&ROW())').valid, true);                // no sheet part
  assert.equal(verify(e, `=INDIRECT("'Week "&A2&"'!A1")`).valid, true);       // name built from a cell: not checkable
});
