'use strict';
/**
 * Tests for Observability.js: Execution Timeline, Agent Trace, Prompt
 * Viewer, Context Viewer, Tool Calls, Latency, Cost, Retries, and
 * Verification Results, captured automatically during handleRequest() and
 * retrievable via the sidebar-callable getObservabilityTrace()/
 * getObservabilityHistory() entry points in Code.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('trace*_ helpers are safe no-ops when no trace is active', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  // No Observability.start() called — none of these should throw.
  assert.doesNotThrow(() => {
    sandbox.Observability.event('x', {});
    sandbox.Observability.agentCall('Agent', 'model', 10);
    sandbox.Observability.prompt('Agent', 'sys', 'user');
    sandbox.Observability.context('label', 'text');
    sandbox.Observability.toolCall({ tool_name: 'x' });
    sandbox.Observability.verification('x', { valid: true, errors: [], warnings: [] });
    sandbox.Observability.cost(0.01, 100);
    sandbox.Observability.setIntent('generate_formula');
  });
  assert.equal(sandbox.Observability.end(), null, 'ending a non-existent trace must return null, not throw');
});

test('start/end lifecycle produces a trace with timing and status', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  sandbox.Observability.start('sum revenue', null);
  sandbox.Observability.setIntent('generate_formula');
  sandbox.Observability.event('did_a_thing', { detail: 42 });

  const finished = sandbox.Observability.end('completed');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.intent, 'generate_formula');
  assert.ok(finished.durationMs >= 0);
  assert.equal(finished.events.length, 1);
  assert.equal(finished.events[0].type, 'did_a_thing');
  assert.ok(finished.events[0].elapsedMs >= 0);
});

test('getCurrentTrace_ returns the most recently ended trace; getTraceHistory_ accumulates lightweight summaries', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });

  sandbox.Observability.start('first request', null);
  sandbox.Observability.setIntent('debug_formula');
  sandbox.Observability.end('completed');

  sandbox.Observability.start('second request', null);
  sandbox.Observability.setIntent('generate_formula');
  sandbox.Observability.end('failed');

  const current = sandbox.Observability.getCurrentTrace();
  assert.equal(current.prompt, 'second request', 'the current trace must be the most recently ended one');
  assert.equal(current.status, 'failed');

  const history = sandbox.Observability.getTraceHistory(10);
  assert.equal(history.length, 2);
  assert.equal(history[0].intent, 'generate_formula', 'history is newest-first');
  assert.equal(history[1].intent, 'debug_formula');
  // History summaries must NOT carry full prompt/systemPrompt text (bounded storage).
  assert.equal(history[0].prompts, undefined);
  assert.equal(history[0].systemPrompt, undefined);
});

test('a real callGemini_ round trip records an agent call (latency), a prompt, and cost', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]],
    urlFetchStub: () => ({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 }
      })
    })
  });

  sandbox.Observability.start('sum revenue', 'generate_formula');
  const context = sandbox.buildDeepContext();
  sandbox.agentDebugFormula_('=SUM(B3:B3', context);
  const trace = sandbox.Observability.end('completed');

  assert.equal(trace.agentCalls.length, 1);
  assert.equal(trace.agentCalls[0].agent, 'DebugAgent');
  assert.ok(trace.agentCalls[0].durationMs >= 0);

  assert.equal(trace.prompts.length, 1);
  assert.match(trace.prompts[0].systemPrompt, /Google Sheets debugger/);
  assert.equal(trace.prompts[0].userText, '=SUM(B3:B3');

  assert.ok(trace.totalCostUsd > 0);
  assert.equal(trace.totalTokens, 520);
});

test('executeStructuredToolCall_ records a Tool Call and a Verification Result', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });

  sandbox.Observability.start('insert a formula', 'generate_formula');
  sandbox.executeStructuredToolCall_({
    tool_name: 'insert_formula',
    arguments: { cell: 'B2', formula: '=SUM(B3:B3)' },
    expected_output: { verified: true }
  });
  const trace = sandbox.Observability.end('completed');

  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].tool_name, 'insert_formula');
  assert.equal(trace.toolCalls[0].ok, true);

  assert.equal(trace.verifications.length, 1);
  assert.equal(trace.verifications[0].label, 'insert_formula');
  assert.equal(trace.verifications[0].valid, true);
});

test('a failed verification increments retryCount', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });

  sandbox.Observability.start('bad formula', 'generate_formula');
  sandbox.Observability.verification('FormulaAgent', { valid: false, errors: ['bad'], warnings: [] });
  sandbox.Observability.verification('FormulaAgent', { valid: true, errors: [], warnings: [] });
  const trace = sandbox.Observability.end('completed');

  assert.equal(trace.retryCount, 1);
  assert.equal(trace.verifications.length, 2);
});

test('handleRequest() produces a full trace end-to-end, retrievable via getObservabilityTrace/History', () => {
  // Stub UrlFetchApp (not callGemini_ itself) so the REAL Api.js callGemini_
  // runs — that's where the Observability.agentCall/prompt/cost hooks live.
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

  const result = sandbox.handleRequest('sum revenue', 'generate');
  assert.equal(result.formula, '=SUM(B3:B3)');
  assert.ok(result.trace, 'handleRequest must attach the completed trace to its result');

  const fetched = sandbox.getObservabilityTrace();
  assert.equal(fetched.traceId, result.trace.traceId);
  assert.equal(fetched.intent, 'generate_formula');
  assert.equal(fetched.status, 'completed');
  assert.ok(fetched.events.some((e) => e.type === 'plan_generated'));
  assert.ok(fetched.agentCalls.length >= 1);

  const history = sandbox.getObservabilityHistory(5);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'completed');
});
