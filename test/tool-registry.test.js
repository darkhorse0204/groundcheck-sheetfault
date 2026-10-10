'use strict';
/**
 * Tests for ToolRegistry.js — the four-gate tool calling engine that closed a
 * real gap in this codebase. Before this file existed, Tools.js implemented 5
 * ad-hoc functions under different names than the 11 documented tools, and
 * Planner.js's dispatchToTool_ switch had no case at all for write_cells,
 * create_chart, run_sql, generate_pivot, or generate_dashboard — plan steps
 * naming them silently fell through to a no-op "(no specific handler)" stub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

// Arrays/objects *constructed by code running inside the vm sandbox* (e.g.
// ToolRegistry.js's own .map()/.push() calls) are instances of that vm
// context's own Array/Object intrinsics, not Node's outer-realm ones —
// assert.deepEqual's identity checks fail on them even when structurally
// identical. Values that merely pass through an outer-realm mock (like our
// getValues()) don't have this problem. JSON round-tripping sidesteps it.
function deepEqualCrossRealm(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

test('executeTool_ Gate 1: rejects an unknown tool name without throwing', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const result = sandbox.executeTool_('delete_everything', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('executeTool_ Gate 2: rejects missing required fields and wrong types before execute() ever runs', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const missingRequired = sandbox.executeTool_('read_cells', {});
  assert.equal(missingRequired.ok, false);
  assert.match(missingRequired.error, /missing required field/);

  const wrongType = sandbox.executeTool_('read_cells', { range: 42 });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /expected string, got number/);

  const badEnum = sandbox.executeTool_('generate_pivot', {
    sourceSheet: 'Sheet1', sourceRange: 'A1:B2', rowField: 'A', valueField: 'B', aggregation: 'MEDIAN'
  });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.error, /not in allowed set/);
});

test('read_cells / write_cells round trip through the registry', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  const write = sandbox.executeTool_('write_cells', { range: 'D1', values: [['x', 'y'], [1, 2]] });
  assert.equal(write.ok, true);
  assert.equal(write.result.range, 'D1:E2');
  assert.equal(write.result.rowsWritten, 2);

  const read = sandbox.executeTool_('read_cells', { range: 'D1:E2' });
  assert.equal(read.ok, true);
  assert.deepEqual(read.result.values, [['x', 'y'], [1, 2]]);
});

test('write_cells rejects inconsistent row lengths (Gate 4 validation)', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const result = sandbox.executeTool_('write_cells', { range: 'A1', values: [[1, 2], [1]] });
  assert.equal(result.ok, false);
  assert.match(result.error, /inconsistent column count/);
});

test('insert_formula is blocked by formula validation and otherwise pushes an undo checkpoint', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });

  const blocked = sandbox.executeTool_('insert_formula', { cell: 'B2', formula: 'SUM(B2)' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /failed validation/);

  const ok = sandbox.executeTool_('insert_formula', { cell: 'B2', formula: '=SUM(B3:B3)' });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.verified, true);

  const sheet = spreadsheet.getActiveSheet();
  assert.equal(sheet.getRange('B2').getFormula(), '=SUM(B3:B3)');
  assert.equal(sandbox.hasUndoAvailable(), true);
  sandbox.undoLastEnterprise();
  assert.equal(sheet.getRange('B2').getValue(), 100);
});

test('run_sql supports SELECT + WHERE + ORDER BY + LIMIT, and rejects non-SELECT statements', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 300],
      ['West', 100],
      ['East', 50],
      ['North', 200]
    ]
  });

  const result = sandbox.executeTool_('run_sql', {
    query: "SELECT Region, Revenue FROM Sheet1 WHERE Revenue > 60 ORDER BY Revenue DESC LIMIT 2"
  });
  assert.equal(result.ok, true);
  deepEqualCrossRealm(result.result.headers, ['Region', 'Revenue']);
  deepEqualCrossRealm(result.result.rows, [['East', 300], ['North', 200]]);
  assert.equal(result.result.totalMatched, 3); // East 300, West 100, North 200 all > 60
  assert.equal(result.result.truncated, true);

  const injection = sandbox.executeTool_('run_sql', { query: 'DROP TABLE Sheet1' });
  assert.equal(injection.ok, false);
  assert.match(injection.error, /Only SELECT/);

  const unknownSheet = sandbox.executeTool_('run_sql', { query: 'SELECT * FROM Nonexistent' });
  assert.equal(unknownSheet.ok, false);
  assert.match(unknownSheet.error, /does not exist/);
});

test('generate_pivot cross-tabulates with SUM and writes a Grand Total row', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [
      ['Region', 'Quarter', 'Revenue'],
      ['East', 'Q1', 100],
      ['East', 'Q2', 150],
      ['West', 'Q1', 50],
      ['West', 'Q2', 75]
    ]
  });

  const result = sandbox.executeTool_('generate_pivot', {
    sourceSheet: 'Sheet1',
    sourceRange: 'A1:C5',
    rowField: 'Region',
    colField: 'Quarter',
    valueField: 'Revenue',
    aggregation: 'SUM',
    outputSheet: 'PivotOut'
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.rowCount, 2);
  assert.equal(result.result.colCount, 2);

  const pivotSheet = sandbox.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PivotOut');
  const grid = pivotSheet.getRange('A1:C4').getValues();
  assert.deepEqual(grid[0], ['', 'Q1', 'Q2']);
  assert.deepEqual(grid[1], ['East', 100, 150]);
  assert.deepEqual(grid[2], ['West', 50, 75]);
  assert.deepEqual(grid[3], ['Grand Total', 150, 225]);
});

test('create_chart builds a chart via the sheet chart builder and returns a chartId', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  const result = sandbox.executeTool_('create_chart', {
    dataRange: 'A1:B3', chartType: 'COLUMN', title: 'Revenue by Region'
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.result.chartId, 'number');
  assert.equal(result.result.chartType, 'COLUMN');

  const sheet = sandbox.SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  assert.equal(sheet.getCharts().length, 1);
});

test('generate_dashboard validates each metric formula and creates charts via create_chart internally', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  const badMetric = sandbox.executeTool_('generate_dashboard', {
    title: 'Sales', sourceSheet: 'Sheet1',
    metrics: [{ label: 'Total', formula: 'SUM(B2:B3)' }] // missing "="
  });
  assert.equal(badMetric.ok, false);
  assert.match(badMetric.error, /failed validation/);

  const result = sandbox.executeTool_('generate_dashboard', {
    title: 'Sales Dashboard',
    sourceSheet: 'Sheet1',
    metrics: [{ label: 'Total Revenue', formula: '=SUM(B2:B3)' }],
    charts: [{ dataRange: 'A1:B3', chartType: 'BAR', title: 'Revenue' }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.metricsAdded, 1);
  assert.equal(result.result.chartsCreated, 1);

  const dashSheet = sandbox.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Dashboard');
  assert.equal(dashSheet.getRange('A1').getValue(), 'Sales Dashboard');
  assert.equal(dashSheet.getRange('B4').getFormula(), '=SUM(B2:B3)');
  assert.equal(dashSheet.getCharts().length, 1);

  const noOverwrite = sandbox.executeTool_('generate_dashboard', {
    title: 'Sales Dashboard', sourceSheet: 'Sheet1', metrics: [{ label: 'X', formula: '=1' }]
  });
  assert.equal(noOverwrite.ok, false);
  assert.match(noOverwrite.error, /already exists/);
});

test('fetch_api strips blocked headers (Cookie/Host) and blocks private-network URLs', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['A']],
    urlFetchStub: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify([{ id: 1 }])
    })
  });

  const ssrf = sandbox.executeTool_('fetch_api', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(ssrf.ok, false);
  assert.match(ssrf.error, /Blocked/);

  const result = sandbox.executeTool_('fetch_api', {
    url: 'https://api.example.com/users',
    headers: { Cookie: 'session=abc', Host: 'evil.com', 'X-Api-Key': 'fine' }
  });
  assert.equal(result.ok, true);
  deepEqualCrossRealm(result.result.blockedHeaders.sort(), ['Cookie', 'Host']);
  deepEqualCrossRealm(result.result.data, [{ id: 1 }]);
});

test('search_headers and inspect_workbook return read-only structural data', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  const search = sandbox.executeTool_('search_headers', { query: 'rev' });
  assert.equal(search.ok, true);
  assert.equal(search.result.matches.length, 1);
  assert.equal(search.result.matches[0].header, 'Revenue');
  assert.equal(search.result.matches[0].column, 'B');

  const inspect = sandbox.executeTool_('inspect_workbook', {});
  assert.equal(inspect.ok, true);
  assert.equal(inspect.result.sheetCount, 1);
  assert.deepEqual(inspect.result.sheets[0].headers, ['Region', 'Revenue']);
});

test('buildGeminiDeclarations_ produces one function declaration per registered tool', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const decls = sandbox.buildGeminiDeclarations_();
  const names = decls[0].functionDeclarations.map((d) => d.name).sort();
  deepEqualCrossRealm(names, [
    'create_chart', 'fetch_api', 'generate_dashboard', 'generate_pivot',
    'insert_formula', 'inspect_workbook', 'read_cells', 'read_formula',
    'run_sql', 'search_headers', 'write_cells'
  ]);
});

test('Code.js executeToolCall() parses JSON args and unwraps { ok, result } into a plain return value', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A'], [1]] });
  const value = sandbox.executeToolCall('read_cells', JSON.stringify({ range: 'A1:A2' }));
  assert.deepEqual(value.values, [['A'], [1]]);
});

test('Code.js executeToolCall() throws (not returns) on tool failure, matching google.script.run error-handler conventions', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.throws(() => sandbox.executeToolCall('unknown_tool', '{}'), /Unknown tool/);
  assert.throws(() => sandbox.executeToolCall('read_cells', 'not json'), /valid JSON/);
});
