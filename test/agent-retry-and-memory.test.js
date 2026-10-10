'use strict';
/**
 * Regression tests for two gaps that used to exist in Agents.js:
 *
 * 1. Retry temperature never decayed (always hardcoded 0.2) and the
 *    fully-built buildRetryFeedback_() diagnostic (errors/warnings/hints,
 *    escalating to hard column/function constraints on attempt 3) was never
 *    used — agentGenerateFormula_ built its own terse one-line retry message
 *    instead.
 * 2. No agent ever injected MEMORY.buildContextString() (workbook
 *    constraints, learned style preferences, session summary) into its
 *    system prompt, even though handleRequest() computed it and MemoryManager
 *    documents memory as "ambient" (agents should read it automatically).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('agentGenerateFormula_ decays temperature 0.2 -> 0.1 -> 0.0 and uses buildRetryFeedback_ diagnostics', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;

  const temperaturesSeen = [];
  const contentsSeen = [];
  const scriptedFormulas = [
    'SUM(B3:B3)',       // attempt 1: missing "=" -> structural hard error
    '=SUM(B3:B3',       // attempt 2: unbalanced parens -> structural hard error
    '=SUM(B3:B3)'       // attempt 3: valid
  ];
  let callCount = 0;

  sandbox.callGemini_ = function (options) {
    temperaturesSeen.push(options.temperature);
    contentsSeen.push(options.contents);
    const formula = scriptedFormulas[callCount];
    callCount++;
    return { candidates: [{ content: { parts: [{ text: formula }] } }] };
  };

  const context = sandbox.buildDeepContext();
  const result = sandbox.agentGenerateFormula_('sum revenue', context, []);

  assert.equal(callCount, 3, 'should have retried twice before succeeding on attempt 3');
  assert.deepEqual(temperaturesSeen, [0.2, 0.1, 0],
    'temperature must decay by CONFIG.VERIFICATION.TEMPERATURE_DECAY each retry, not stay fixed at 0.2');

  assert.equal(result.formula, '=SUM(B3:B3)');
  assert.equal(result.verified, true);

  // The 2nd call's conversation must carry buildRetryFeedback_'s rich diagnostic
  // (not the old terse "That formula has errors: ..." one-liner).
  const secondCallLastMessage = contentsSeen[1][contentsSeen[1].length - 1].parts[0].text;
  assert.match(secondCallLastMessage, /failed verification on attempt 2/);
  assert.match(secondCallLastMessage, /HARD ERRORS/);

  // The 3rd call (attemptNumber 3) must include the hard column-constraint
  // escalation tier that buildRetryFeedback_ only adds at attempt >= 3.
  const thirdCallLastMessage = contentsSeen[2][contentsSeen[2].length - 1].parts[0].text;
  assert.match(thirdCallLastMessage, /HARD CONSTRAINTS FOR THIS ATTEMPT/);
});

test('agentGenerateFormula_ injects MEMORY workbook constraints and style preferences into the system prompt', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;

  // Seed workbook memory (annotation) and a learned user style preference.
  sandbox.MEMORY.initSession();
  sandbox.MEMORY.workbook.annotate('Revenue', 'Never divide this column — it is pre-aggregated.');
  sandbox.MEMORY.prefs.update({ formulaStyle: { preferXLOOKUP: true } });

  let capturedSystemInstruction = null;
  sandbox.callGemini_ = function (options) {
    capturedSystemInstruction = options.systemInstruction;
    return { candidates: [{ content: { parts: [{ text: '=SUM(B3:B3)' }] } }] };
  };

  const context = sandbox.buildDeepContext();
  sandbox.agentGenerateFormula_('sum revenue', context, []);

  assert.ok(capturedSystemInstruction, 'callGemini_ must have been invoked');
  assert.match(capturedSystemInstruction, /WORKBOOK CONSTRAINTS/);
  assert.match(capturedSystemInstruction, /Never divide this column/);
  assert.match(capturedSystemInstruction, /USER PREFERENCES/);
  assert.match(capturedSystemInstruction, /prefers XLOOKUP/);
});

test('agentDebugFormula_ and agentExplainFormula_ also inject memory hints', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100]
    ]
  });
  const { sandbox } = env;

  sandbox.MEMORY.initSession();
  sandbox.MEMORY.prefs.update({ formulaStyle: { preferXLOOKUP: true } });

  const captured = [];
  sandbox.callGemini_ = function (options) {
    captured.push(options.systemInstruction);
    return { candidates: [{ content: { parts: [{ text: 'Looks fine.\n=SUM(B3:B3)' }] } }] };
  };

  const context = sandbox.buildDeepContext();
  sandbox.agentDebugFormula_('=SUM(B3:B3', context);
  sandbox.agentExplainFormula_('=SUM(B3:B3)', context);

  assert.equal(captured.length, 2);
  captured.forEach((prompt) => {
    assert.match(prompt, /USER PREFERENCES/);
    assert.match(prompt, /prefers XLOOKUP/);
  });
});
