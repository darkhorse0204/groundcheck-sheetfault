'use strict';
/**
 * Tests for the Agents.js refactor: every agent (FormulaAgent, DebugAgent,
 * ExplanationAgent, DataAgent, PushAgent) exposes the same five methods —
 * plan/execute/verify/retry/explain — driven by one generic runAgentLoop_(),
 * communicating through a structured JSON "session" object rather than by
 * parsing each other's natural-language output.
 *
 * test/agent-retry-and-memory.test.js and test/fetch-header-security.test.js
 * already cover the legacy-shaped entry points (agentGenerateFormula_ etc.)
 * end-to-end in detail; this file targets the new interface itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

const AGENTS = ['FormulaAgent', 'DebugAgent', 'ExplanationAgent', 'DataAgent', 'PushAgent'];

test('every agent exposes exactly the five-method interface: plan, execute, verify, retry, explain', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  AGENTS.forEach((name) => {
    const agent = sandbox[name];
    assert.ok(agent, name + ' must exist');
    ['plan', 'execute', 'verify', 'retry', 'explain'].forEach((method) => {
      assert.equal(typeof agent[method], 'function', name + '.' + method + ' must be a function');
    });
  });
});

test('runAgentLoop_ drives FormulaAgent through plan -> execute -> verify -> explain via one structured session object', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  const context = sandbox.buildDeepContext();
  const session = sandbox.runAgentLoop_(sandbox.FormulaAgent, { prompt: 'sum revenue', context: context, chatHistory: [] });

  // Structured fields, not text parsing, carry state between phases.
  assert.equal(typeof session.systemPrompt, 'string');
  assert.deepEqual(Object.keys(session.candidate), ['formula']);
  assert.equal(session.candidate.formula, '=SUM(B3:B3)');
  assert.equal(session.verification.valid, true);
  assert.match(session.explanation, /SUM\(B3:B3\)/);
});

test('runAgentLoop_ retries FormulaAgent using session.verification, not by re-parsing the previous explanation text', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  let calls = 0;
  const seenTemperatures = [];
  sandbox.callGemini_ = (options) => {
    seenTemperatures.push(options.temperature);
    calls++;
    return { candidates: [{ content: { parts: [{ text: calls === 1 ? 'SUM(B3:B3)' /* missing "=" */ : '=SUM(B3:B3)' }] } }] };
  };

  const context = sandbox.buildDeepContext();
  const session = sandbox.runAgentLoop_(sandbox.FormulaAgent, { prompt: 'sum revenue', context: context, chatHistory: [] });

  assert.equal(calls, 2);
  assert.equal(session.verification.valid, true);
  assert.equal(session.candidate.formula, '=SUM(B3:B3)');
  assert.deepEqual(seenTemperatures, [0.2, 0.1]);
});

test('DebugAgent.verify structurally re-validates the extracted fix, not just the raw LLM text', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]]
  });
  sandbox.callGemini_ = () => ({
    candidates: [{ content: { parts: [{ text: 'Column C does not exist.\n=SUM(C2:C10)' }] } }]
  });

  const context = sandbox.buildDeepContext();
  const session = sandbox.runAgentLoop_(sandbox.DebugAgent, { brokenFormula: '=SUM(C2:C10', context: context });

  assert.equal(session.candidate.fixedFormula, '=SUM(C2:C10)');
  // C is beyond the used range of a 2-column sheet — verify() must catch this, not just accept the fix blindly.
  // (Bounds are sheet-aware now, so a range wholly outside the data is a hard error with a hint, not a warning.)
  assert.equal(session.verification.valid, false);
  assert.ok(session.verification.errors.some((e) => /Column C/.test(e)));
  assert.ok(session.verification.hints.some((h) => /columns A-B/.test(h)));
});

function deepEqualCrossRealm(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

test('DataAgent and PushAgent never retry (maxRetries: 0) even when their execute() would otherwise be retryable', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify([{ id: 1 }]) })
  });
  // The two LLM calls in this scenario need different response shapes (JSON
  // route-discovery vs. a raw URL string) — distinguish by jsonMode rather
  // than by URL, since both go through the same Gemini endpoint.
  sandbox.callGemini_ = function (options) {
    if (options.jsonMode) {
      return { candidates: [{ content: { parts: [{ text: '{"url":"https://api.example.com/data"}' }] } }] };
    }
    return { candidates: [{ content: { parts: [{ text: 'https://api.example.com/data' }] } }] };
  };

  const context = sandbox.buildDeepContext();
  const dataSession = sandbox.runAgentLoop_(sandbox.DataAgent, { prompt: 'get 1 record', context: context });
  assert.equal(dataSession.attempt, 0, 'DataAgent must stop after attempt 0 regardless of verification result');
  assert.equal(dataSession.maxRetries, 0);

  spreadsheet.getActiveSheet().setActiveCellPosition(2, 1);
  const pushSession = sandbox.runAgentLoop_(sandbox.PushAgent, { prompt: 'send to https://api.example.com/data', context: context });
  assert.equal(pushSession.attempt, 0);
  assert.equal(pushSession.maxRetries, 0);
});

test('ExplanationAgent.verify is a trivial structural pass-through (nothing to check for free-text explanations)', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: 'This sums column B.' }] } }] });

  const context = sandbox.buildDeepContext();
  const session = sandbox.runAgentLoop_(sandbox.ExplanationAgent, { formula: '=SUM(B:B)', context: context });
  deepEqualCrossRealm(session.verification, { valid: true, errors: [], warnings: [], hints: [] });
  assert.equal(session.explanation, 'This sums column B.');
});

test('legacy wrapper functions are unchanged for existing callers (Code.js/Planner.js never had to change)', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]]
  });
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] });

  const context = sandbox.buildDeepContext();
  const result = sandbox.agentGenerateFormula_('sum revenue', context, []);
  assert.equal(JSON.stringify(Object.keys(result).sort()), JSON.stringify(['formula', 'text', 'verified']));
});

test('FormulaAgent.plan appends retrieved workbook context to the prompt when provided, and is unchanged otherwise', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100]] });
  const context = sandbox.buildDeepContext();
  const plain = sandbox.FormulaAgent.plan({ prompt: 'sum revenue', context, chatHistory: [] });
  assert.ok(!/RETRIEVED CONTEXT/.test(plain.systemPrompt));
  const rich = sandbox.FormulaAgent.plan({ prompt: 'sum revenue', context, chatHistory: [], retrievalContext: '=== RETRIEVED CONTEXT (1/3 chunks) ===\nSheet "Prices"' });
  assert.match(rich.systemPrompt, /RETRIEVED CONTEXT/);
  assert.match(rich.systemPrompt, /Sheet "Prices"/);
});

test('with REPAIR_ON_SUSPICIOUS on, a suspicious (but valid) formula triggers the repair loop', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200], ['North', 50]] });
  sandbox.console = { log() {}, warn() {}, error() {} };
  sandbox.CONFIG.VERIFICATION.REPAIR_ON_SUSPICIOUS = true;
  const outputs = ['=COUNTIF(A2:A4,"Northeast")', '=COUNTIF(A2:A4,"North")'];
  let calls = 0;
  sandbox.callGemini_ = () => ({ candidates: [{ content: { parts: [{ text: outputs[calls++] }] } }] });
  const context = sandbox.buildDeepContext();
  const result = sandbox.agentGenerateFormula_('count north', context, []);
  assert.equal(calls, 2);
  assert.equal(result.formula, '=COUNTIF(A2:A4,"North")');
});
