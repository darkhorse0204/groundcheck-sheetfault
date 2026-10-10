'use strict';
/**
 * Tests for the execution-control features added to close IMPLEMENTATION
 * item #8: Redo, Cancellation (between plan steps), Resume/Checkpoint
 * recovery, and Progress updates. Operation history (MEMORY.ops/
 * ENTERPRISE.history/MEMORY.taskHistory) and large-workbook chunking
 * (SpreadsheetEngine.js's MAX_ROWS/MAX_COLS caps + embedding chunk
 * splitting) were already implemented in earlier components — not
 * duplicated here.
 *
 * Streaming responses and true mid-step cancellation are NOT implemented,
 * because they are not achievable on Google Apps Script: there is no SSE/
 * WebSocket channel (a google.script.run call is one synchronous
 * request/response), and a running server function cannot be preempted —
 * see Planner.js's executePlanStep() docblock for the documented
 * platform-limit reasoning. The closest GAS-feasible approximations
 * (progressive per-step delivery via the existing executePlanStep loop,
 * and cancellation checked between steps) are what's tested here instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

// ─── Redo ─────────────────────────────────────────────────────────────────────

test('redo brings back an undone change, and a fresh write clears the redo stack', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });
  const sheet = spreadsheet.getActiveSheet();

  sandbox.insertFormulaIntoCell('=SUM(B3:B3)');
  assert.equal(sheet.getRange('B2').getFormula(), '=SUM(B3:B3)');

  sandbox.undoLastEnterprise();
  assert.equal(sheet.getRange('B2').getValue(), 100, 'undo restores the original value');
  assert.equal(sandbox.getRedoStack().length, 1, 'undo must push onto the redo stack');

  sandbox.redoLastEnterprise();
  assert.equal(sheet.getRange('B2').getFormula(), '=SUM(B3:B3)', 'redo re-applies the undone formula');
  assert.equal(sandbox.getRedoStack().length, 0);
  assert.equal(sandbox.getUndoStack().length, 1, 'redo pushes the replaced state back onto undo');

  assert.throws(() => sandbox.redoLastEnterprise(), /Nothing to redo/);

  // A fresh write invalidates redo history.
  sandbox.undoLastEnterprise();
  assert.equal(sandbox.getRedoStack().length, 1);
  sandbox.insertFormulaIntoCell('=SUM(B3:B3)*2');
  assert.equal(sandbox.getRedoStack().length, 0, 'a new write must clear any pending redo');
});

test('undo/redo can ping-pong back and forth repeatedly', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });
  const sheet = spreadsheet.getActiveSheet();

  sandbox.insertFormulaIntoCell('=SUM(B3:B3)');
  sandbox.undoLastEnterprise();
  sandbox.redoLastEnterprise();
  sandbox.undoLastEnterprise();
  assert.equal(sheet.getRange('B2').getValue(), 100);
  sandbox.redoLastEnterprise();
  assert.equal(sheet.getRange('B2').getFormula(), '=SUM(B3:B3)');
});

// ─── Progress ─────────────────────────────────────────────────────────────────

function threeStepPlan(overrides) {
  return Object.assign({
    planId: 'plan_progress_test', prompt: 'test', intent: 'generate_formula', status: 'approved',
    reasoning: '', needsApproval: true,
    steps: [
      { stepId: '1', tool: 'search_headers', reason: 'x', dependencies: [], expectedOutput: 'y', isDestructive: false, estimatedCostUsd: 0, args: { query: 'revenue' }, status: 'pending', result: null, error: null, startedAt: null, completedAt: null },
      { stepId: '2', tool: 'llm:generate_formula', reason: 'x', dependencies: ['1'], expectedOutput: 'y', isDestructive: false, estimatedCostUsd: 0.01, args: {}, status: 'pending', result: null, error: null, startedAt: null, completedAt: null },
      { stepId: '3', tool: 'insert_formula', reason: 'x', dependencies: ['2'], expectedOutput: 'y', isDestructive: true, estimatedCostUsd: 0, args: {}, status: 'pending', result: null, error: null, startedAt: null, completedAt: null }
    ],
    totalEstimatedCostUsd: 0.01, createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), completedAt: null, contextSnapshot: ''
  }, overrides || {});
}

test('getPlanProgress_ reports percent complete and the next step as execution proceeds', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  sandbox.savePlan_(threeStepPlan());

  const before = sandbox.getPlanProgress('plan_progress_test');
  assert.equal(before.totalSteps, 3);
  assert.equal(before.completedSteps, 0);
  assert.equal(before.percentComplete, 0);
  assert.equal(before.nextStep.stepId, '1');

  sandbox.executePlanStep('plan_progress_test');
  const after = sandbox.getPlanProgress('plan_progress_test');
  assert.equal(after.completedSteps, 1);
  assert.equal(after.percentComplete, 33);
  assert.equal(after.nextStep.stepId, '2');
});

test('getPlanProgress_ returns null for an unknown plan', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(sandbox.getPlanProgress('nope'), null);
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

test('cancelPlanExecution stops the NEXT executePlanStep call before it runs another step', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  sandbox.savePlan_(threeStepPlan());
  sandbox.executePlanStep('plan_progress_test'); // runs step 1

  sandbox.cancelPlanExecution('plan_progress_test');

  const calls = [];
  const originalExecuteTool = sandbox.executeTool_;
  sandbox.executeTool_ = function (name, args) { calls.push(name); return originalExecuteTool(name, args); };

  const outcome = sandbox.executePlanStep('plan_progress_test');
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.done, true);
  assert.equal(outcome.plan.status, 'cancelled');
  assert.equal(calls.length, 0, 'no further tool must execute once cancellation is requested');
});

test('a cancelled plan cannot be resumed', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.savePlan_(threeStepPlan({ planId: 'plan_cancel_resume' }));
  sandbox.cancelPlanExecution('plan_cancel_resume');
  sandbox.executePlanStep('plan_cancel_resume'); // consumes the cancellation flag, marks plan cancelled

  const state = sandbox.getResumableState('plan_cancel_resume');
  assert.equal(state.resumable, false);
  assert.match(state.reason, /cancelled/);
});

// ─── Resume / Checkpoint Recovery ─────────────────────────────────────────────

test('getResumableState_ correctly classifies completed, failed, pending_approval, and in-progress plans', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  sandbox.savePlan_(threeStepPlan({ planId: 'p_completed', status: 'completed' }));
  assert.equal(sandbox.getResumableState('p_completed').resumable, false);

  sandbox.savePlan_(threeStepPlan({ planId: 'p_pending', status: 'pending_approval' }));
  assert.equal(sandbox.getResumableState('p_pending').resumable, false);

  sandbox.savePlan_(threeStepPlan({ planId: 'p_approved', status: 'approved' }));
  const approvedState = sandbox.getResumableState('p_approved');
  assert.equal(approvedState.resumable, true);
  assert.equal(approvedState.progress.totalSteps, 3);

  assert.equal(sandbox.getResumableState('does_not_exist').resumable, false);
});

test('resumePlanExecution runs exactly one more step from wherever the plan left off', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  sandbox.savePlan_(threeStepPlan({ planId: 'p_resume' }));

  // Simulate the sidebar being closed after step 1 and reopened later —
  // resumePlanExecution() picks up from the persisted checkpoint.
  sandbox.executePlanStep('p_resume');
  const midProgress = sandbox.getPlanProgress('p_resume');
  assert.equal(midProgress.completedSteps, 1);

  const outcome = sandbox.resumePlanExecution('p_resume');
  assert.equal(outcome.step.stepId, '2');
  assert.equal(sandbox.getPlanProgress('p_resume').completedSteps, 2);
});

test('resumePlanExecution refuses to resume a non-resumable plan', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.savePlan_(threeStepPlan({ planId: 'p_done', status: 'completed' }));
  assert.throws(() => sandbox.resumePlanExecution('p_done'), /Cannot resume plan/);
});
