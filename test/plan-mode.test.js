'use strict';
/**
 * Regression test for a Plan Mode wiring bug that used to exist:
 * Sidebar.html called `google.script.run...generatePlan(prompt)` with a single
 * argument, but Planner.js's `generatePlan(prompt, contextStr, intent)` needs
 * three. `contextStr` and `intent` arrived as `undefined` in the live system,
 * so the planner LLM's system prompt contained the literal text "undefined"
 * instead of real spreadsheet context, and plans were generated blind.
 *
 * The fix adds `generatePlanForPrompt(prompt)` in Code.js — a sidebar-callable
 * wrapper that builds real context and classifies a real intent server-side
 * (the sidebar has no access to SpreadsheetApp/Gemini to do this itself)
 * before calling the real generatePlan(). This test proves the planner
 * actually receives real context and a real intent end-to-end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('generatePlanForPrompt() passes real context + a real classified intent into generatePlan()', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;

  let capturedPlannerSystemInstruction = null;

  sandbox.callGemini_ = function (options) {
    const firstToolName = options.tools && options.tools[0].functionDeclarations[0].name;

    if (firstToolName === 'generate_formula') {
      // This is Router.js's classifyIntent_() call.
      return {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'generate_formula', args: { task_description: 'sum revenue' } } }] }
        }]
      };
    }

    if (firstToolName === 'create_execution_plan') {
      // This is Planner.js's generatePlan() call — capture what it actually saw.
      capturedPlannerSystemInstruction = options.systemInstruction;
      return {
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: 'create_execution_plan',
                args: {
                  reasoning: 'Search headers, then generate the SUMIF formula.',
                  needsApproval: true,
                  steps: [
                    { stepId: '1', tool: 'search_headers', reason: 'Find the Revenue column', dependencies: [], expectedOutput: 'Column letter for Revenue', isDestructive: false, estimatedCostUsd: 0 },
                    { stepId: '2', tool: 'llm:generate_formula', reason: 'Generate the SUMIF', dependencies: ['1'], expectedOutput: 'A formula string', isDestructive: false, estimatedCostUsd: 0.01 },
                    { stepId: '3', tool: 'insert_formula', reason: 'Write it to the active cell', dependencies: ['2'], expectedOutput: 'Formula inserted', isDestructive: true, estimatedCostUsd: 0 }
                  ],
                  totalEstimatedCostUsd: 0.01
                }
              }
            }]
          }
        }]
      };
    }

    throw new Error('Unexpected callGemini_ invocation in this test: ' + JSON.stringify(options.tools));
  };

  const plan = sandbox.generatePlanForPrompt('sum revenue for east region');

  assert.equal(plan.intent, 'generate_formula', 'the plan must carry a real classified intent, not undefined');
  assert.equal(plan.status, 'pending_approval');
  assert.equal(plan.steps.length, 3);

  assert.ok(capturedPlannerSystemInstruction, 'the planner LLM call must have happened');
  assert.doesNotMatch(
    capturedPlannerSystemInstruction,
    /undefined/,
    'the planner system prompt must never contain the literal string "undefined"'
  );
  assert.match(
    capturedPlannerSystemInstruction,
    /Region/,
    'the planner system prompt must contain real spreadsheet context (actual header names)'
  );
  assert.match(
    capturedPlannerSystemInstruction,
    /USER INTENT \(pre-classified\): generate_formula/,
    'the planner system prompt must contain the real classified intent, not "undefined"'
  );
});
