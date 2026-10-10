'use strict';
/**
 * FormulaParser.js: tokenizer + AST for Google Sheets formulas. Pure functions,
 * so these tests need no spreadsheet at all — just the sandboxed globals.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
const parse = (f) => sandbox.parseFormulaAst_(f);

test('parses calls, ranges, strings and operators into a typed AST', () => {
  const r = parse('=SUMIF(B2:B80,"East",F2:F80)*2');
  assert.equal(r.ok, true);
  const ast = r.ast;
  assert.equal(ast.t, 'bin');
  assert.equal(ast.l.t, 'call');
  assert.equal(ast.l.name, 'SUMIF');
  assert.equal(ast.l.args.length, 3);
  assert.equal(ast.l.args[0].kind, 'range');
  assert.equal(ast.l.args[0].c1, 2);
  assert.equal(ast.l.args[0].r2, 80);
  assert.equal(ast.l.args[1].v, 'East');
});

test('parentheses and quotes inside string literals do not confuse the parser', () => {
  assert.equal(parse('=IF(A1="(",1,2)').ok, true);
  assert.equal(parse('=HYPERLINK("https://x.com/a?b=(1)","link (x)")').ok, true);
  assert.equal(parse('=A1&"say ""hi"""').ok, true);
});

test('handles sheet-qualified refs, quoted sheet names, whole-column, open-ended and absolute refs', () => {
  const r = parse("=VLOOKUP(A2,'My Sheet'!$A:$C,2,FALSE)");
  assert.equal(r.ok, true);
  const ref = r.ast.args[1];
  assert.equal(ref.sheet, 'My Sheet');
  assert.equal(ref.kind, 'col');
  assert.equal(ref.c2, 3);
  const open = parse('=ARRAYFORMULA(F2:F*2)').ast.args[0].l;
  assert.equal(open.kind, 'range');
  assert.equal(open.r2, null);
});

test('distinguishes function names that look like cells (LOG10) and bare names', () => {
  const log = parse('=LOG10(5)');
  assert.equal(log.ast.t, 'call');
  const name = parse('=SUM(Revenue)');
  assert.equal(name.ast.args[0].t, 'name');
  assert.equal(name.ast.args[0].v, 'Revenue');
});

test('supports lowercase functions, percent, unary minus, array literals, error literals and empty args', () => {
  assert.equal(parse('=sum(a1:a3)').ast.name, 'SUM');
  assert.equal(parse('=5%').ast.t, 'pct');
  assert.equal(parse('=-A1^2').ok, true);
  assert.equal(parse('=SUM({1,2;3,4})').ast.args[0].rows.length, 2);
  assert.equal(parse('=IFERROR(A1,#N/A)').ast.args[1].t, 'err');
  const empty = parse('=IF(A1,,2)');
  assert.equal(empty.ast.args[1].t, 'empty');
  assert.equal(parse('=1E-3*2').ok, true);
});

test('reports a clear error instead of throwing on malformed input', () => {
  assert.equal(parse('=SUM(F2:F80').ok, false);
  assert.match(parse('=SUM(F2:F80').error, /Expected/);
  assert.equal(parse('=SUM(1,,').ok, false);
  assert.equal(parse('=1+').ok, false);
  assert.equal(parse('=A1 B2').ok, false);
  assert.equal(parse('=').ok, false);
  assert.equal(parse('=SUM(§)').ok, false);
});

test('collectAstRefs_ returns every reference in source order; editDistance_ is bounded', () => {
  const refs = sandbox.collectAstRefs_(parse('=SUM(A1:A3)+Sheet2!B2').ast);
  assert.equal(refs.length, 2);
  assert.equal(refs[1].sheet, 'Sheet2');
  assert.equal(sandbox.editDistance_('SUMIFF', 'SUMIF', 2), 1);
  assert.ok(sandbox.editDistance_('AVG', 'AVERAGE', 2) > 2);
});
