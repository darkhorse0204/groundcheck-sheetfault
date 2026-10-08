'use strict';
/**
 * Tests closing two wiring gaps found while redesigning the sidebar's
 * "Current Context" and "Live Agent Activity" panels:
 *
 * 1. ContextRetriever.js was fully implemented and tested in isolation, but
 *    was never actually called from handleRequest() — the live request
 *    pipeline still only ever saw the flat, active-sheet-only context from
 *    Context.js. This wires it in (Code.js) and exposes it to the sidebar
 *    via getCurrentContext().
 *
 * 2. executePlanStep() never wrapped itself in Observability.start()/end(),
 *    so multi-step Plan Mode execution (the sidebar calls executePlanStep()
 *    once per step, each its own isolated GAS execution) produced no trace
 *    at all — "Live Agent Activity" had nothing to show during Plan Mode.
 *    Fixed by having executePlanStep() start its own trace UNLESS one is
 *    already running (i.e. it's being driven from inside handleRequest()'s
 *    executeFullPlan_() loop for an auto_approved plan) — in which case it
 *    folds into that outer trace instead of stomping it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

// ─── ContextRetriever wiring ──────────────────────────────────────────────────

test('getCurrentContext() returns active-sheet facts plus a ranked chunk selection', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Notes', [['Unrelated'], ['nothing to do with revenue']]);
  sandbox.MEMORY.initSession();

  const ctx = sandbox.getCurrentContext();
  assert.equal(ctx.sheetName, 'Sheet1');
  assert.deepEqual(ctx.headers, ['Region', 'Revenue']);
  assert.ok(ctx.ranked, 'ranked selection must be present');
  assert.ok(ctx.ranked.consideredCount >= 1);
  assert.ok(Array.isArray(ctx.ranked.chunks));
});

test('getCurrentContext() ranks a chunk mentioning the last user prompt higher via semantic similarity', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  spreadsheet._addSheet('Notes', [['Unrelated'], ['nothing to do with revenue']]);
  sandbox.MEMORY.initSession();
  sandbox.MEMORY.conversation.append({ role: 'user', content: 'sum revenue by region' });

  const ctx = sandbox.getCurrentContext();
  const revenueChunk = ctx.ranked.chunks.find((c) => /Revenue/i.test(c.preview));
  const notesChunk = ctx.ranked.chunks.find((c) => /Unrelated/i.test(c.preview));
  assert.ok(revenueChunk, 'the Sheet1 table chunk must be in the selection');
  if (notesChunk) {
    assert.ok(revenueChunk.score > notesChunk.score, 'the chunk matching the prompt must score higher');
  }
});

test('handleRequest() folds a ranked context selection into the prompt context and records it in the trace', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]],
    urlFetchStub: (url, fetchOptions) => {
      const payload = JSON.parse(fetchOptions.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    name: 'create_execution_plan',
                    args: {
                      reasoning: 'test', needsApproval: false,
                      steps: [{ stepId: '1', tool: 'llm:generate_formula', reason: 'r', dependencies: [], expectedOutput: 'o', isDestructive: true, estimatedCostUsd: 0.01 }],
                      totalEstimatedCostUsd: 0.01
                    }
                  }
                }]
              }
            }],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, totalTokenCount: 230 }
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 15, totalTokenCount: 315 }
        })
      };
    }
  });
  spreadsheet._addSheet('Notes', [['Unrelated'], ['nothing to do with revenue']]);

  const result = sandbox.handleRequest('sum revenue', 'generate');
  assert.equal(result.formula, '=SUM(B3:B3)');

  const trace = result.trace;
  assert.ok(trace.contexts.some((c) => c.label === 'ranked-selection'), 'a ranked-selection context entry must be recorded');
});

test('a ContextRetriever failure does not break handleRequest (non-fatal)', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: (url, fetchOptions) => {
      const payload = JSON.parse(fetchOptions.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    name: 'create_execution_plan',
                    args: {
                      reasoning: 'test', needsApproval: false,
                      steps: [{ stepId: '1', tool: 'llm:generate_formula', reason: 'r', dependencies: [], expectedOutput: 'o', isDestructive: true, estimatedCostUsd: 0.01 }],
                      totalEstimatedCostUsd: 0.01
                    }
                  }
                }]
              }
            }],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, totalTokenCount: 230 }
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 15, totalTokenCount: 315 }
        })
      };
    }
  });

  // Break ContextRetriever without touching handleRequest's own logic.
  sandbox.ContextRetriever.retrieve = () => { throw new Error('boom'); };

  const result = sandbox.handleRequest('sum revenue', 'generate');
  assert.equal(result.formula, '=SUM(B3:B3)', 'the request must still succeed even though context retrieval threw');
});

// ─── Live Agent Activity: per-step tracing for Plan Mode ─────────────────────

function twoStepPlan(overrides) {
  return Object.assign({
    planId: 'plan_activity_test', prompt: 'sum revenue', intent: 'generate_formula', status: 'approved',
    reasoning: '', needsApproval: true,
    steps: [
      { stepId: '1', tool: 'search_headers', reason: 'find revenue column', dependencies: [], expectedOutput: 'y', isDestructive: false, estimatedCostUsd: 0, args: { query: 'revenue' }, status: 'pending', result: null, error: null, startedAt: null, completedAt: null },
      { stepId: '2', tool: 'llm:generate_formula', reason: 'generate the formula', dependencies: ['1'], expectedOutput: 'y', isDestructive: false, estimatedCostUsd: 0.01, args: {}, status: 'pending', result: null, error: null, startedAt: null, completedAt: null }
    ],
    totalEstimatedCostUsd: 0.01, createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(), completedAt: null, contextSnapshot: ''
  }, overrides || {});
}

test('a standalone executePlanStep() call (Plan Mode) produces its own trace with a tool call recorded', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.savePlan_(twoStepPlan());

  const outcome = sandbox.executePlanStep('plan_activity_test');
  assert.ok(outcome.trace, 'a step run outside of handleRequest() must own and return its own trace');
  assert.equal(outcome.trace.status, 'completed');
  assert.ok(outcome.trace.toolCalls.some((t) => t.tool_name === 'search_headers'));
  assert.ok(outcome.trace.events.some((e) => e.type === 'step_started'));
  assert.ok(outcome.trace.events.some((e) => e.type === 'step_completed'));

  // Also retrievable the normal Observability way (saved to cache in end()).
  const fetched = sandbox.getObservabilityTrace();
  assert.equal(fetched.traceId, outcome.trace.traceId);
});

test('a standalone executePlanStep() call captures the LLM agent call for an llm: step', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });
  sandbox.savePlan_(twoStepPlan());

  sandbox.executePlanStep('plan_activity_test'); // step 1: search_headers
  const outcome = sandbox.executePlanStep('plan_activity_test'); // step 2: llm:generate_formula

  assert.ok(outcome.trace);
  assert.ok(outcome.trace.events.some((e) => e.type === 'step_started' && e.data.tool === 'llm:generate_formula'));
});

test('executePlanStep() run from inside handleRequest() (auto_approved) folds into the outer trace instead of overwriting it', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]],
    urlFetchStub: (url, fetchOptions) => {
      const payload = JSON.parse(fetchOptions.payload);
      if (payload.tools) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    name: 'create_execution_plan',
                    args: {
                      reasoning: 'test', needsApproval: false,
                      steps: [
                        { stepId: '1', tool: 'search_headers', reason: 'r', dependencies: [], expectedOutput: 'o', isDestructive: false, estimatedCostUsd: 0, args: { query: 'revenue' } },
                        { stepId: '2', tool: 'llm:generate_formula', reason: 'r', dependencies: ['1'], expectedOutput: 'o', isDestructive: true, estimatedCostUsd: 0.01 }
                      ],
                      totalEstimatedCostUsd: 0.01
                    }
                  }
                }]
              }
            }],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30, totalTokenCount: 230 }
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 15, totalTokenCount: 315 }
        })
      };
    }
  });

  const result = sandbox.handleRequest('sum revenue', 'generate');
  assert.ok(result.trace, 'the outer handleRequest trace must still be attached');
  // Both steps' tool/agent activity must show up in the ONE outer trace,
  // not be lost to a nested trace that stomped and then vanished.
  assert.ok(result.trace.toolCalls.some((t) => t.tool_name === 'search_headers'));
  assert.ok(result.trace.events.some((e) => e.type === 'step_started' && e.data.tool === 'search_headers'));
  assert.ok(result.trace.events.some((e) => e.type === 'step_started' && e.data.tool === 'llm:generate_formula'));
});
