'use strict';
/**
 * Tests for ContextRetriever.js — relevance-ranked context selection over
 * SpreadsheetEngine.js's embedding-ready chunks, under a token budget.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('tokenize_ lowercases, strips punctuation, and drops stopwords', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const tokens = sandbox.tokenize_('Sum the Revenue for the East region!');
  assert.equal(JSON.stringify(tokens), JSON.stringify(['sum', 'revenue', 'east', 'region']));
});

test('jaccardSimilarity_ is 1 for identical sets, 0 for disjoint sets, and in between for overlap', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(sandbox.jaccardSimilarity_(['a', 'b'], ['a', 'b']), 1);
  assert.equal(sandbox.jaccardSimilarity_(['a', 'b'], ['c', 'd']), 0);
  assert.equal(sandbox.jaccardSimilarity_([], ['a']), 0);
  assert.ok(sandbox.jaccardSimilarity_(['a', 'b', 'c'], ['a', 'b', 'd']) > 0 &&
            sandbox.jaccardSimilarity_(['a', 'b', 'c'], ['a', 'b', 'd']) < 1);
});

test('parseRefBounds_ handles single cells, ranges, whole columns, and whole rows', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(JSON.stringify(sandbox.parseRefBounds_('B2')), JSON.stringify({ startRow: 2, endRow: 2, startCol: 2, endCol: 2 }));
  assert.equal(JSON.stringify(sandbox.parseRefBounds_('A2:B10')), JSON.stringify({ startRow: 2, endRow: 10, startCol: 1, endCol: 2 }));
  const wholeCol = sandbox.parseRefBounds_('A:A');
  assert.equal(wholeCol.startCol, 1);
  assert.equal(wholeCol.endCol, 1);
  assert.ok(wholeCol.endRow > 100000);
});

test('boundsOverlap_ correctly detects overlapping and non-overlapping ranges', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const a = sandbox.parseRefBounds_('A1:B10');
  const overlapping = sandbox.parseRefBounds_('B5:C6');
  const disjoint = sandbox.parseRefBounds_('D1:E5');
  assert.equal(sandbox.boundsOverlap_(a, overlapping), true);
  assert.equal(sandbox.boundsOverlap_(a, disjoint), false);
});

test('tablesAreNeighbors_ recognizes vertically and horizontally adjacent tables but not distant ones', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const t1 = { id: 't1', sheet: 'Sheet1', startRow: 1, numRows: 3, startCol: 1, numCols: 2 };
  const vertical = { id: 't2', sheet: 'Sheet1', startRow: 5, numRows: 3, startCol: 1, numCols: 2 };
  const horizontal = { id: 't3', sheet: 'Sheet1', startRow: 1, numRows: 3, startCol: 4, numCols: 2 };
  const distant = { id: 't4', sheet: 'Sheet1', startRow: 50, numRows: 3, startCol: 50, numCols: 2 };
  const otherSheet = { id: 't5', sheet: 'Sheet2', startRow: 1, numRows: 3, startCol: 1, numCols: 2 };

  assert.equal(sandbox.tablesAreNeighbors_(t1, vertical, 2), true);
  assert.equal(sandbox.tablesAreNeighbors_(t1, horizontal, 2), true);
  assert.equal(sandbox.tablesAreNeighbors_(t1, distant, 2), false);
  assert.equal(sandbox.tablesAreNeighbors_(t1, otherSheet, 2), false);
});

test('bfsGraphDistances_ measures hop distance in both directions and respects maxHops', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  const formulaGraph = {
    nodes: ['Sheet1!B1', 'Sheet1!C1', 'Sheet1!D1'],
    edges: { 'Sheet1!B1': ['Sheet1!A1'], 'Sheet1!C1': ['Sheet1!B1'], 'Sheet1!D1': ['Sheet1!C1'] }
  };
  const distances = sandbox.bfsGraphDistances_(formulaGraph, 'Sheet1!B1', 3);
  assert.equal(distances['Sheet1!B1'], 0);
  assert.equal(distances['Sheet1!A1'], 1, 'A1 is a dependency of B1 (one direction)');
  assert.equal(distances['Sheet1!C1'], 1, 'C1 depends on B1 (the other direction)');
  assert.equal(distances['Sheet1!D1'], 2);

  const limited = sandbox.bfsGraphDistances_(formulaGraph, 'Sheet1!B1', 1);
  assert.equal(limited['Sheet1!D1'], undefined, 'maxHops=1 must not reach two hops away');
});

// ─── Scoring & selection (semi-pure: model comes from a real analyzed workbook) ──

function buildFixtureModel(sandbox) {
  return sandbox.analyzeWorkbook_();
}

test('selectContext_ ranks the active sheet\'s table above an unrelated sheet\'s table', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Notes', [['Unrelated'], ['blah blah blah']]);
  const model = buildFixtureModel(sandbox);

  const selection = sandbox.selectContext_(model, {
    prompt: 'sum revenue', activeSheetName: 'Sheet1', activeCellRef: 'B2', maxTokens: 10000
  });

  const sheet1Entry = selection.allScored.filter((e) => e.chunk.sheet === 'Sheet1')[0];
  const notesEntry = selection.allScored.filter((e) => e.chunk.sheet === 'Notes')[0];
  assert.ok(sheet1Entry.score > notesEntry.score, 'the active sheet\'s chunk must outrank an unrelated sheet\'s chunk');
});

test('selectContext_ respects the token budget and only includes what fits, highest score first', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Sheet2', [['Product', 'Price'], ['Widget', 9.99], ['Gadget', 19.99]]);
  spreadsheet._addSheet('Sheet3', [['Note'], ['irrelevant']]);
  const model = buildFixtureModel(sandbox);

  const unbudgeted = sandbox.selectContext_(model, { prompt: 'revenue', activeSheetName: 'Sheet1', activeCellRef: 'B2', maxTokens: 100000 });
  assert.equal(unbudgeted.selected.length, unbudgeted.consideredCount, 'a huge budget should include every chunk');

  const tightBudget = Math.ceil(unbudgeted.selected[0].chunk.tokenEstimate * 1.5);
  const budgeted = sandbox.selectContext_(model, { prompt: 'revenue', activeSheetName: 'Sheet1', activeCellRef: 'B2', maxTokens: tightBudget });
  assert.ok(budgeted.totalTokens <= tightBudget);
  assert.ok(budgeted.selected.length < budgeted.consideredCount, 'a tight budget must leave some chunks out');
  assert.equal(budgeted.selected[0].chunk.id, unbudgeted.selected[0].chunk.id, 'the single highest-scoring chunk must always make the cut first');
});

test('selectContext_ boosts chunks referenced by / dependent on the active cell\'s formula', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Summary', [['Total'], ['=Sheet1!B2+Sheet1!B3']]);
  const model = buildFixtureModel(sandbox);

  // Active cell is the Summary formula that reads from Sheet1 -> Sheet1's table should be graph-boosted.
  const selection = sandbox.selectContext_(model, {
    prompt: 'what does this total include', activeSheetName: 'Summary', activeCellRef: 'A2', maxTokens: 10000
  });

  const sheet1Entry = selection.allScored.filter((e) => e.chunk.sheet === 'Sheet1')[0];
  assert.ok(sheet1Entry.signals.dependencyGraph > 0, 'Sheet1 is one hop from the active formula cell');
  assert.ok(sheet1Entry.signals.referencedFormulas === 1);
});

test('buildRetrievalContextString_ formats an empty selection as an empty string and a real one with chunk text', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  const model = buildFixtureModel(sandbox);

  const empty = sandbox.selectContext_(model, { prompt: 'x', activeSheetName: 'Sheet1', maxTokens: 0 });
  assert.equal(sandbox.buildRetrievalContextString_(empty), '');

  const real = sandbox.selectContext_(model, { prompt: 'revenue', activeSheetName: 'Sheet1', maxTokens: 10000 });
  const str = sandbox.buildRetrievalContextString_(real);
  assert.match(str, /RETRIEVED CONTEXT/);
  assert.match(str, /Revenue/);
});

// ─── Full impure entry point ─────────────────────────────────────────────────

test('retrieveContext_ reads the live active sheet/cell and conversation memory end-to-end', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Notes', [['Unrelated'], ['nothing to do with this']]);

  sandbox.MEMORY.initSession();
  sandbox.MEMORY.conversation.append({ role: 'user', content: 'tell me about revenue by region' });

  const result = sandbox.retrieveContext_('sum the revenue', { maxTokens: 10000 });
  assert.ok(result.contextString.length > 0);
  assert.ok(result.selection.selected.length > 0);
  assert.ok(result.model.workbook.sheetCount === 2);
});
