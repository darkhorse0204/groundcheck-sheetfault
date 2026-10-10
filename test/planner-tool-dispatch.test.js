'use strict';
/**
 * Proves a real bug is fixed: a plan step naming write_cells, create_chart,
 * run_sql, or generate_pivot used to fall through Planner.js's
 * dispatchToTool_ switch to a "(no specific handler)" no-op, even though the
 * Planner LLM is told all 11 tool names are valid.
 * These tests build a plan directly (bypassing the planner LLM call) and run
 * it through the real executePlanStep()/dispatchToTool_() path to confirm
 * each tool now actually executes via ToolRegistry.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

function baseStep(overrides) {
  return Object.assign({
    stepId: '1', reason: 'test step', dependencies: [], expectedOutput: 'result',
    isDestructive: true, estimatedCostUsd: 0, args: {},
    status: 'pending', result: null, error: null, startedAt: null, completedAt: null
  }, overrides);
}

function makePlan(steps) {
  return {
    planId: 'plan_test_' + Math.random().toString(36).slice(2),
    prompt: 'test plan', intent: 'generate_formula', status: 'approved',
    reasoning: '', needsApproval: true, steps: steps,
    totalEstimatedCostUsd: 0, createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), completedAt: null, contextSnapshot: ''
  };
}

test('Planner dispatches write_cells through ToolRegistry (was a silent no-op before)', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({ sheetData: [['A', 'B'], [1, 2]] });

  const plan = makePlan([baseStep({ tool: 'write_cells', args: { range: 'D1', values: [[9, 9]] } })]);
  sandbox.savePlan_(plan);

  const stepResult = sandbox.executePlanStep(plan.planId);
  assert.equal(stepResult.error, undefined);
  assert.equal(stepResult.result.success, true);
  assert.deepEqual(spreadsheet.getActiveSheet().getRange('D1:E1').getValues(), [[9, 9]]);
});

test('Planner dispatches run_sql through ToolRegistry and can write results to a sheet', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 300], ['West', 100]]
  });

  const plan = makePlan([baseStep({
    tool: 'run_sql',
    args: { query: 'SELECT Region, Revenue FROM Sheet1 WHERE Revenue > 150', outputSheet: 'SqlOut' }
  })]);
  sandbox.savePlan_(plan);

  const stepResult = sandbox.executePlanStep(plan.planId);
  assert.equal(stepResult.error, undefined);
  assert.equal(stepResult.result.rowCount, 1);

  const outSheet = spreadsheet.getSheetByName('SqlOut');
  assert.deepEqual(outSheet.getRange('A1:B2').getValues(), [['Region', 'Revenue'], ['East', 300]]);
});

test('Planner dispatches generate_pivot through ToolRegistry', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['East', 50], ['West', 200]]
  });

  const plan = makePlan([baseStep({
    tool: 'generate_pivot',
    args: { sourceSheet: 'Sheet1', sourceRange: 'A1:B4', rowField: 'Region', valueField: 'Revenue', aggregation: 'SUM', outputSheet: 'PivotOut' }
  })]);
  sandbox.savePlan_(plan);

  const stepResult = sandbox.executePlanStep(plan.planId);
  assert.equal(stepResult.error, undefined);
  assert.equal(stepResult.result.rowCount, 2);

  const pivotSheet = spreadsheet.getSheetByName('PivotOut');
  assert.deepEqual(pivotSheet.getRange('A2:B2').getValues(), [['East', 150]]);
});

test('Planner dispatches create_chart through ToolRegistry', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  const plan = makePlan([baseStep({
    tool: 'create_chart',
    args: { dataRange: 'A1:B3', chartType: 'PIE', title: 'Revenue split' }
  })]);
  sandbox.savePlan_(plan);

  const stepResult = sandbox.executePlanStep(plan.planId);
  assert.equal(stepResult.error, undefined);
  assert.equal(stepResult.result.chartType, 'PIE');
  assert.equal(spreadsheet.getActiveSheet().getCharts().length, 1);
});

test('Planner still backfills insert_formula\'s "formula" from a prior llm:generate_formula step', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });

  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  const plan = makePlan([
    baseStep({ stepId: '1', tool: 'llm:generate_formula', isDestructive: false }),
    baseStep({ stepId: '2', tool: 'insert_formula', dependencies: ['1'] }) // no args.formula supplied
  ]);
  sandbox.savePlan_(plan);

  const first = sandbox.executePlanStep(plan.planId);
  assert.equal(first.done, false, 'first step should not complete the whole plan');

  const second = sandbox.executePlanStep(plan.planId);
  assert.equal(second.error, undefined);
  assert.equal(second.result.formula, '=SUM(B3:B3)');
  assert.equal(second.done, true);

  assert.equal(spreadsheet.getActiveSheet().getRange('B2').getFormula(), '=SUM(B3:B3)');
});

test('An unknown tool in a plan step now surfaces a real error instead of a silent no-op stub', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  const plan = makePlan([baseStep({ tool: 'delete_everything', args: {} })]);
  sandbox.savePlan_(plan);

  const stepResult = sandbox.executePlanStep(plan.planId);
  assert.match(stepResult.error, /Unknown tool/);
});
