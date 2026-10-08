'use strict';
/**
 * Regression test for a gap that used to exist: ENTERPRISE.cost.record() was
 * fully implemented (per-model pricing math, session vs. lifetime totals) but
 * was never called from anywhere in the codebase — callGemini_() didn't even
 * extract usageMetadata (input/output token counts) from the Gemini response.
 * getCostSummary() always returned $0.0000 regardless of actual usage.
 *
 * This test does NOT stub callGemini_ itself (unlike most other tests in this
 * suite) — it stubs UrlFetchApp.fetch instead, so the real Api.js callGemini_
 * function runs end-to-end, including the new cost-recording step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

function geminiTextResponse(text, promptTokens, candidateTokens) {
  return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: text }] } }],
      usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: candidateTokens, totalTokenCount: promptTokens + candidateTokens }
    })
  };
}

test('callGemini_ records token usage + cost via ENTERPRISE.cost.record after a successful call', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: () => geminiTextResponse('=SUM(B3:B3)', 500, 20)
  });

  const before = sandbox.getCostSummary();
  assert.equal(before.totalCostUsd, 0);

  const context = sandbox.buildDeepContext();
  sandbox.agentDebugFormula_('=SUM(B3:B3', context);

  const after = sandbox.getCostSummary();
  assert.equal(after.requestCount, 1);
  assert.equal(after.totalTokens, 520);

  // gemini-2.5-pro pricing: input $1.25/1M, output $10.00/1M
  const expectedCost = (500 / 1e6) * 1.25 + (20 / 1e6) * 10.0;
  assert.ok(Math.abs(after.totalCostUsd - expectedCost) < 1e-9, 'cost must match CONFIG.MODEL_PRICING math exactly');
  assert.ok(after.totalCostUsd > 0, 'cost must no longer be stuck at $0');
});

test('cost is attributed per-agent and accumulates across multiple calls', () => {
  const { sandbox } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: (url) => {
      if (String(url).indexOf('gemini-2.5-flash') !== -1) {
        return geminiTextResponse(JSON.stringify({ url: 'https://api.example.com/data' }), 100, 10);
      }
      return geminiTextResponse('=SUM(B3:B3)', 200, 15);
    }
  });

  var context = sandbox.buildDeepContext();
  sandbox.agentDebugFormula_('=SUM(B3:B3', context);   // Pro call -> FormulaAgent-family (DebugAgent)
  sandbox.agentExplainFormula_('=SUM(B3:B3)', context); // Another Pro call -> ExplanationAgent

  const summary = sandbox.getCostSummary();
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.totalTokens, (200 + 15) * 2);
  assert.ok(summary.lastRequest.agent === 'ExplanationAgent' || summary.lastRequest.agent === 'DebugAgent');
});
