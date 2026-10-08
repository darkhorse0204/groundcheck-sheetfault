'use strict';
/**
 * Tests for SpreadsheetEngine.js — the deterministic workbook analysis
 * pipeline: Workbook -> Sheets -> Tables -> Headers -> Data Types ->
 * Formula Graph -> Named Ranges -> Charts -> Pivot Tables -> Relationships
 * -> Dependency Graph -> Statistics -> Embeddings-ready Chunks.
 *
 * Most of the interesting logic is written as pure functions over plain
 * arrays, so most tests below exercise it directly without needing a mock
 * Sheet/Range at all — only the handful of genuinely impure orchestrators
 * (buildWorkbookModel_, buildFormulaGraph_, collectNamedRanges_, etc.) need
 * the full gasEnvironment sandbox.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

// Objects/arrays constructed by code running inside the vm sandbox are
// instances of that vm context's own Array/Object intrinsics, not Node's
// outer-realm ones — assert.deepEqual's identity checks fail on them even
// when structurally identical. JSON round-tripping sidesteps it.
function deepEqualCrossRealm(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

test('SpreadsheetEngine.js never references any Gemini/network call ("pure deterministic analysis only")', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'SpreadsheetEngine.js'), 'utf8');
  assert.doesNotMatch(source, /callGemini_/, 'must never call the Gemini API client');
  assert.doesNotMatch(source, /UrlFetchApp/, 'must never make an HTTP call of any kind');
});

// ─── Layer 3: Table detection (pure) ─────────────────────────────────────────

test('detectTableBands_ finds a single table spanning the whole grid', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const grid = [['Region', 'Revenue'], ['East', 100], ['West', 200]];
  const bands = sandbox.detectTableBands_(grid);
  assert.equal(bands.length, 1);
  deepEqualCrossRealm(bands[0], { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 });
});

test('detectTableBands_ splits tables separated by a blank row', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const grid = [
    ['Region', 'Revenue'], ['East', 100],
    ['', ''],
    ['Product', 'Price'], ['Widget', 9.99]
  ];
  const bands = sandbox.detectTableBands_(grid);
  assert.equal(bands.length, 2);
  assert.equal(bands[0].rowEnd, 1);
  assert.equal(bands[1].rowStart, 3);
});

test('detectTableBands_ splits tables separated by a blank column', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const grid = [
    ['Region', 'Revenue', '', 'Product', 'Price'],
    ['East', 100, '', 'Widget', 9.99]
  ];
  const bands = sandbox.detectTableBands_(grid);
  assert.equal(bands.length, 2);
  assert.equal(bands[0].colEnd, 1);
  assert.equal(bands[1].colStart, 3);
});

test('detectTableBands_ returns nothing for an empty grid', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(sandbox.detectTableBands_([]).length, 0);
  assert.equal(sandbox.detectTableBands_([['', ''], ['', '']]).length, 0);
});

test('buildTableFromBand_ detects a header row and maps columns to letters', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const grid = [['Region', 'Revenue'], ['East', 100], ['West', 200]];
  const band = { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 };
  const table = sandbox.buildTableFromBand_(grid, band, 'Sheet1', null);

  assert.equal(table.hasHeaderRow, true);
  assert.deepEqual(Array.from(table.headers), ['Region', 'Revenue']);
  assert.equal(table.dataRowCount, 2);
  assert.equal(table.range, 'A1:B3');
  assert.equal(table.columns[0].columnLetter, 'A');
  assert.equal(table.columns[1].columnLetter, 'B');
});

test('buildTableFromBand_ falls back to synthetic headers for a single-row or non-text-header band', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const singleRow = sandbox.buildTableFromBand_([[1, 2, 3]], { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 2 }, 'Sheet1', null);
  assert.equal(singleRow.hasHeaderRow, false);
  assert.deepEqual(Array.from(singleRow.headers), ['Column1', 'Column2', 'Column3']);

  const numericHeaderRow = sandbox.buildTableFromBand_(
    [[1, 2], [3, 4]], { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }, 'Sheet1', null
  );
  assert.equal(numericHeaderRow.hasHeaderRow, false, 'a numeric first row is data, not a header');
});

// ─── Layer 5: Data type inference (pure) ─────────────────────────────────────

test('analyzeColumnType_ infers number/text/date/boolean/empty/mixed correctly', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  assert.equal(sandbox.analyzeColumnType_([100, 200, 300], null).type, 'number');
  assert.equal(sandbox.analyzeColumnType_(['a', 'b', 'c'], null).type, 'text');
  assert.equal(sandbox.analyzeColumnType_([true, false, true], null).type, 'boolean');
  assert.equal(sandbox.analyzeColumnType_(['', '', ''], null).type, 'empty');
  assert.equal(sandbox.analyzeColumnType_([1, 'a', true], null).type, 'mixed');

  const dateResult = sandbox.analyzeColumnType_([new Date('2024-01-01'), new Date('2024-06-01')], null);
  assert.equal(dateResult.type, 'date');
});

test('analyzeColumnType_ distinguishes currency and percentage from plain numbers via number formats', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const currency = sandbox.analyzeColumnType_([100, 200], ['$#,##0.00', '$#,##0.00']);
  assert.equal(currency.type, 'currency');

  const percentage = sandbox.analyzeColumnType_([0.1, 0.25], ['0.00%', '0.00%']);
  assert.equal(percentage.type, 'percentage');

  const plain = sandbox.analyzeColumnType_([100, 200], ['0', '0']);
  assert.equal(plain.type, 'number');
});

test('analyzeColumnType_ computes correct numeric stats (min/max/mean/median/stdev)', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const result = sandbox.analyzeColumnType_([2, 4, 4, 4, 5, 5, 7, 9], null);
  assert.equal(result.stats.min, 2);
  assert.equal(result.stats.max, 9);
  assert.equal(result.stats.mean, 5);
  assert.equal(result.stats.median, 4.5);
  assert.ok(Math.abs(result.stats.stdev - 2.13809) < 0.001);
});

test('analyzeColumnType_ ignores blanks when computing stats and counts them as nullCount', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const result = sandbox.analyzeColumnType_([10, '', 20, null, 30, undefined], null);
  assert.equal(result.type, 'number');
  assert.equal(result.count, 3);
  assert.equal(result.nullCount, 3);
  assert.equal(result.stats.mean, 20);
});

// ─── Layer 6: Formula reference parsing (pure) ───────────────────────────────

test('parseFormulaRefs_ extracts simple cell refs, ranges, and cross-sheet refs', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const simple = sandbox.parseFormulaRefs_('=A1+B2', 'Sheet1');
  assert.equal(JSON.stringify(simple.map((r) => r.node).sort()), JSON.stringify(['Sheet1!A1', 'Sheet1!B2']));

  const range = sandbox.parseFormulaRefs_('=SUM(A2:A50)', 'Sheet1');
  assert.equal(range.length, 1);
  assert.equal(range[0].node, 'Sheet1!A2:A50');
  assert.equal(range[0].isRange, true);

  const crossSheet = sandbox.parseFormulaRefs_('=Sheet2!B2*2', 'Sheet1');
  assert.equal(crossSheet[0].node, 'Sheet2!B2');
  assert.equal(crossSheet[0].sheet, 'Sheet2');

  const quotedSheet = sandbox.parseFormulaRefs_("='Q1 Data'!C3", 'Sheet1');
  assert.equal(quotedSheet[0].node, 'Q1 Data!C3');
});

test('parseFormulaRefs_ ignores refs-that-are-actually-inside-string-literals', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const refs = sandbox.parseFormulaRefs_('=IF(A1="B2","yes","no")', 'Sheet1');
  assert.equal(JSON.stringify(refs.map((r) => r.node)), JSON.stringify(['Sheet1!A1']));
});

test('parseFormulaRefs_ does not mistake a function name for a cell reference', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  // LOG10(...) looks like it could parse as ref "LOG10" if not for the
  // not-followed-by-"(" heuristic — only A1 should come out.
  const refs = sandbox.parseFormulaRefs_('=LOG10(A1)', 'Sheet1');
  assert.equal(JSON.stringify(refs.map((r) => r.node)), JSON.stringify(['Sheet1!A1']));
});

test('parseFormulaRefs_ returns nothing for a non-formula value', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(sandbox.parseFormulaRefs_('plain text', 'Sheet1').length, 0);
  assert.equal(sandbox.parseFormulaRefs_('', 'Sheet1').length, 0);
});

// ─── Layer 11: Dependency graph algorithms (pure) ────────────────────────────

test('detectCycles_ finds a circular reference and leaves an acyclic graph alone', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const cyclic = sandbox.detectCycles_(['Sheet1!A1', 'Sheet1!B1'], {
    'Sheet1!A1': ['Sheet1!B1'],
    'Sheet1!B1': ['Sheet1!A1']
  });
  assert.equal(cyclic.length > 0, true);

  const acyclic = sandbox.detectCycles_(['Sheet1!A1', 'Sheet1!B1', 'Sheet1!C1'], {
    'Sheet1!C1': ['Sheet1!B1'],
    'Sheet1!B1': ['Sheet1!A1'],
    'Sheet1!A1': []
  });
  assert.equal(acyclic.length, 0);
});

test('computeDepths_ measures the longest dependency chain per node', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const nodes = ['Sheet1!A1', 'Sheet1!B1', 'Sheet1!C1'];
  const edges = { 'Sheet1!A1': [], 'Sheet1!B1': ['Sheet1!A1'], 'Sheet1!C1': ['Sheet1!B1'] };
  const depths = sandbox.computeDepths_(nodes, edges);
  assert.equal(depths['Sheet1!A1'], 0);
  assert.equal(depths['Sheet1!B1'], 1);
  assert.equal(depths['Sheet1!C1'], 2);
});

test('buildDependencyGraph_ identifies roots, leaves, max depth, and cycles from a Formula Graph', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const formulaGraph = {
    nodes: ['Sheet1!B1', 'Sheet1!C1'],
    edges: { 'Sheet1!B1': ['Sheet1!A1'], 'Sheet1!C1': ['Sheet1!B1'] }, // A1 is a raw input, not itself a formula node
    formulas: {}
  };
  const depGraph = sandbox.buildDependencyGraph_(formulaGraph);
  assert.equal(depGraph.hasCycles, false);
  assert.equal(depGraph.maxDepth, 1);
  assert.equal(JSON.stringify(depGraph.roots), JSON.stringify(['Sheet1!B1']), 'B1 only depends on a non-formula input cell');
  assert.equal(JSON.stringify(depGraph.leaves), JSON.stringify(['Sheet1!C1']), 'nothing depends on C1');
});

// ─── Layer 13: Embedding chunks (pure) ───────────────────────────────────────

test('splitIntoChunks_ leaves short text alone and splits long text on line boundaries', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.deepEqual(Array.from(sandbox.splitIntoChunks_('short', 100)), ['short']);

  const longText = Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n');
  const pieces = sandbox.splitIntoChunks_(longText, 60);
  assert.ok(pieces.length > 1);
  pieces.forEach((p) => assert.ok(p.length <= 60 || p.split('\n').length === 1));
});

// ─── Impure orchestrators (need the sandbox's mock Sheet/Spreadsheet) ────────

test('buildWorkbookModel_ reads real sheet data end-to-end into workbook -> sheets -> tables -> headers -> types', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  const workbook = sandbox.buildWorkbookModel_();
  assert.equal(workbook.sheetCount, 1);
  assert.equal(workbook.sheets[0].tables.length, 1);
  assert.equal(workbook.sheets[0].tables[0].columns[1].dataType, 'number');
});

test('buildFormulaGraph_ builds real nodes/edges from actual sheet formulas', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', '=B2*2']]
  });
  const workbook = sandbox.buildWorkbookModel_();
  const graph = sandbox.buildFormulaGraph_(workbook);

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0], 'Sheet1!B3');
  assert.equal(JSON.stringify(graph.edges['Sheet1!B3']), JSON.stringify(['Sheet1!B2']));
});

test('collectNamedRanges_ / collectCharts_ / collectPivotTables_ read real (or gracefully absent) workbook features', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]],
    namedRanges: [{ name: 'RevenueRange', a1: 'B2:B3' }]
  });

  const namedRanges = sandbox.collectNamedRanges_();
  assert.equal(namedRanges.length, 1);
  assert.equal(namedRanges[0].name, 'RevenueRange');
  assert.equal(namedRanges[0].range, 'B2:B3');

  sandbox.executeTool_('create_chart', { dataRange: 'A1:B3', chartType: 'PIE', title: 'Revenue' });
  const workbook = sandbox.buildWorkbookModel_();
  const charts = sandbox.collectCharts_(workbook);
  assert.equal(charts.length, 1);
  assert.equal(charts[0].chartType, 'PIE');

  // No pivot table support in the mock -> must degrade to an empty list, not throw.
  const pivots = sandbox.collectPivotTables_(workbook);
  assert.equal(pivots.length, 0);
});

test('buildRelationships_ aggregates cross-sheet formula references and ignores same-sheet refs', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const formulaGraph = {
    nodes: ['Sheet1!A1', 'Sheet1!A2'],
    edges: {},
    formulas: {
      'Sheet1!A1': { formula: '=Sheet2!B1', dependencies: [{ sheet: 'Sheet2', ref: 'B1', isRange: false, node: 'Sheet2!B1' }] },
      'Sheet1!A2': { formula: '=A1', dependencies: [{ sheet: 'Sheet1', ref: 'A1', isRange: false, node: 'Sheet1!A1' }] }
    }
  };
  const rels = sandbox.buildRelationships_(formulaGraph);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].from, 'Sheet1');
  assert.equal(rels[0].to, 'Sheet2');
  assert.equal(rels[0].count, 1);
});

// ─── Full pipeline integration ───────────────────────────────────────────────

test('analyzeWorkbook_ runs the full documented layer pipeline end-to-end without throwing', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue', 'Date'],
      ['East', 100, new Date('2024-01-01')],
      ['West', '=B2*2', new Date('2024-02-01')]
    ],
    namedRanges: [{ name: 'Revenue', a1: 'B2:B3' }]
  });
  spreadsheet._addSheet('Summary', [['Total'], ['=Sheet1!B2+Sheet1!B3']]);

  const model = sandbox.analyzeWorkbook_();

  // Workbook -> Sheets -> Tables -> Headers -> Data Types
  assert.equal(model.workbook.sheetCount, 2);
  const sheet1 = model.workbook.sheets.filter((s) => s.name === 'Sheet1')[0];
  assert.equal(sheet1.tables[0].columns[2].dataType, 'date');

  // Formula Graph
  assert.ok(model.formulaGraph.nodes.indexOf('Sheet1!B3') !== -1);
  assert.ok(model.formulaGraph.nodes.indexOf('Summary!A2') !== -1);

  // Named Ranges
  assert.equal(model.namedRanges[0].name, 'Revenue');

  // Charts / Pivot Tables — none in this fixture, must be empty arrays not errors
  assert.equal(model.charts.length, 0);
  assert.equal(model.pivotTables.length, 0);

  // Relationships — Summary sheet references Sheet1
  assert.ok(model.relationships.some((r) => r.from === 'Summary' && r.to === 'Sheet1'));

  // Dependency Graph
  assert.equal(model.dependencyGraph.hasCycles, false);
  assert.ok(model.dependencyGraph.nodeCount >= 2);

  // Statistics
  assert.ok(model.statistics.totalFormulaCells >= 2);
  assert.ok(model.statistics.perSheet.length === 2);

  // Embeddings-ready chunks
  assert.ok(model.embeddingChunks.length > 0);
  model.embeddingChunks.forEach((chunk) => {
    assert.ok(chunk.text.length > 0);
    assert.ok(chunk.tokenEstimate > 0);
  });
  assert.ok(model.embeddingChunks.some((c) => c.type === 'namedRanges'));
  assert.ok(model.embeddingChunks.some((c) => c.type === 'relationships'));
});

test('table chunks carry column letters and the data-row span, so a model can address the table without guessing', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200], ['North', 50]] });
  sandbox.console = { log() {}, warn() {}, error() {} };
  const model = sandbox.SpreadsheetEngine.analyze();
  const chunk = model.embeddingChunks.find((c) => c.type === 'table');
  assert.match(chunk.text, /header in row 1, data in rows 2-4/);
  assert.match(chunk.text, /A "Region" \(text\)/);
  assert.match(chunk.text, /B "Revenue" \(number\)/);
  assert.match(chunk.text, /\n  B Revenue: min=50 max=200/);
});
