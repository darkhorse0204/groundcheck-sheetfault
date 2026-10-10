'use strict';
/**
 * Tests for the MemoryManager.js upgrade: Task History (a persistent record
 * of completed/failed tasks, distinct from the ephemeral current-task
 * taskMemory_) and "memory automatically influences future planning" —
 * Planner.js's generatePlan() now injects MEMORY.buildContextString(intent)
 * (workbook hints, style prefs, session summary, AND task-history success
 * rate/step-pattern for this intent) into its system prompt on every call,
 * with no extra step required from the caller.
 *
 * Pattern learning, workbook summaries, conversation compression, user
 * preferences, and successful formula learning were already fully
 * implemented in MemoryManager.js before this change (verified by reading
 * the file in full) — this file only covers the genuinely new pieces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('MEMORY.taskHistory.record persists entries distinct from the ephemeral MEMORY.task', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.MEMORY.initSession();

  sandbox.MEMORY.taskHistory.record({
    taskId: 'plan_1', intent: 'generate_formula', prompt: 'sum revenue',
    status: 'completed', stepCount: 3, stepTools: ['search_headers', 'llm:generate_formula', 'insert_formula']
  });

  const recent = sandbox.MEMORY.taskHistory.getRecent(10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].intent, 'generate_formula');
  assert.equal(recent[0].status, 'completed');

  // Distinct storage from the ephemeral current-task memory.
  assert.equal(sandbox.MEMORY.task.isActive(), false);
});

test('MEMORY.taskHistory.getContextHint summarizes success rate and the most common successful step pattern', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.MEMORY.initSession();

  const pattern = ['search_headers', 'llm:generate_formula', 'insert_formula'];
  sandbox.MEMORY.taskHistory.record({ intent: 'generate_formula', status: 'completed', stepTools: pattern });
  sandbox.MEMORY.taskHistory.record({ intent: 'generate_formula', status: 'completed', stepTools: pattern });
  sandbox.MEMORY.taskHistory.record({ intent: 'generate_formula', status: 'failed', stepTools: [] });
  sandbox.MEMORY.taskHistory.record({ intent: 'fetch_data', status: 'completed', stepTools: ['fetch_api', 'write_cells'] });

  const hint = sandbox.MEMORY.taskHistory.getContextHint('generate_formula');
  assert.match(hint, /2\/3 past attempts succeeded/);
  assert.match(hint, /search_headers -> llm:generate_formula -> insert_formula/);

  // A different intent's history must not leak into this hint.
  assert.doesNotMatch(hint, /fetch_api/);

  // No history yet for an intent -> no hint (not an empty-but-present string).
  assert.equal(sandbox.MEMORY.taskHistory.getContextHint('push_data'), '');
});

test('MEMORY.buildContextString(intent) includes the task-history hint only when an intent is passed', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.MEMORY.initSession();
  sandbox.MEMORY.taskHistory.record({ intent: 'generate_formula', status: 'completed', stepTools: ['llm:generate_formula'] });

  const withIntent = sandbox.MEMORY.buildContextString('generate_formula');
  assert.match(withIntent, /TASK HISTORY/);

  const withoutIntent = sandbox.MEMORY.buildContextString();
  assert.doesNotMatch(withoutIntent, /TASK HISTORY/);
});

test('generatePlan() automatically includes memory hints (task history + workbook/prefs) in its system prompt', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  sandbox.MEMORY.initSession();
  sandbox.MEMORY.workbook.annotate('Revenue', 'Never divide this column.');
  sandbox.MEMORY.taskHistory.record({
    intent: 'generate_formula', status: 'completed',
    stepTools: ['search_headers', 'llm:generate_formula', 'insert_formula']
  });

  let capturedSystemInstruction = null;
  sandbox.callGemini_ = function (options) {
    capturedSystemInstruction = options.systemInstruction;
    return {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'create_execution_plan',
              args: { reasoning: 'test', needsApproval: false, steps: [], totalEstimatedCostUsd: 0 }
            }
          }]
        }
      }]
    };
  };

  sandbox.generatePlan('sum revenue', 'Headers: Region, Revenue', 'generate_formula');

  assert.ok(capturedSystemInstruction);
  assert.match(capturedSystemInstruction, /WORKBOOK CONSTRAINTS/);
  assert.match(capturedSystemInstruction, /Never divide this column/);
  assert.match(capturedSystemInstruction, /TASK HISTORY for "generate_formula"/);
});

test('a completed plan automatically records itself into task history (no explicit call needed)', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  sandbox.MEMORY.initSession();
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  const plan = {
    planId: 'plan_test_history', prompt: 'sum revenue', intent: 'generate_formula', status: 'approved',
    reasoning: '', needsApproval: true,
    steps: [{
      stepId: '1', tool: 'llm:generate_formula', reason: 'generate', dependencies: [],
      expectedOutput: 'formula', isDestructive: false, estimatedCostUsd: 0.01, args: {},
      status: 'pending', result: null, error: null, startedAt: null, completedAt: null
    }],
    totalEstimatedCostUsd: 0.01, createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), completedAt: null, contextSnapshot: ''
  };
  sandbox.savePlan_(plan);

  // With exactly one step, executePlanStep runs it AND detects allDone in
  // the same call, so the plan is already 'completed' after just this one call.
  sandbox.executePlanStep(plan.planId);

  const history = sandbox.MEMORY.taskHistory.getRecent(5);
  assert.equal(history.length, 1);
  assert.equal(history[0].intent, 'generate_formula');
  assert.equal(history[0].status, 'completed');
  assert.equal(JSON.stringify(history[0].stepTools), JSON.stringify(['llm:generate_formula']));
});

test('a failed plan step also records itself into task history as failed', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.MEMORY.initSession();

  const plan = {
    planId: 'plan_test_fail_history', prompt: 'do something', intent: 'fetch_data', status: 'approved',
    reasoning: '', needsApproval: true,
    steps: [{
      stepId: '1', tool: 'unknown_tool', reason: 'x', dependencies: [],
      expectedOutput: 'y', isDestructive: true, estimatedCostUsd: 0, args: {},
      status: 'pending', result: null, error: null, startedAt: null, completedAt: null
    }],
    totalEstimatedCostUsd: 0, createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), completedAt: null, contextSnapshot: ''
  };
  sandbox.savePlan_(plan);
  sandbox.executePlanStep(plan.planId);

  const history = sandbox.MEMORY.taskHistory.getRecent(5);
  assert.equal(history.length, 1);
  assert.equal(history[0].intent, 'fetch_data');
  assert.equal(history[0].status, 'failed');
});

test('clearAllMemory wipes task history too', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.MEMORY.initSession();
  sandbox.MEMORY.taskHistory.record({ intent: 'generate_formula', status: 'completed', stepTools: [] });
  assert.equal(sandbox.MEMORY.taskHistory.getRecent(5).length, 1);

  sandbox.MEMORY.clearAll();
  assert.equal(sandbox.MEMORY.taskHistory.getRecent(5).length, 0);
});
