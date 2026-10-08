'use strict';
/**
 * Regression test for a gap the structured-tool-calling migration closed:
 * Tools.js used to hold toolFetchExternalApi_/toolPostWebhook_ — direct
 * UrlFetchApp helpers that agentFetchData_/agentPushData_ called straight
 * through, bypassing ToolRegistry.js entirely and (for a while) having no
 * header allowlist at all.
 *
 * Both functions have since been deleted. agentFetchData_ and
 * agentPushData_ now exclusively call ToolRegistry's fetch_api tool via
 * executeStructuredToolCall_() — the header allowlist (filterRequestHeaders_)
 * lives in exactly one place and is exercised in test/tool-registry.test.js's
 * "fetch_api strips blocked headers" test. This file verifies the agents
 * still work end-to-end after the migration and that the deleted functions
 * are actually gone (not just unused).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

test('toolFetchExternalApi_ and toolPostWebhook_ no longer exist — structured tool calling replaced them', () => {
  const { sandbox } = createGasEnvironment({ sheetData: [['A']] });
  assert.equal(sandbox.toolFetchExternalApi_, undefined);
  assert.equal(sandbox.toolPostWebhook_, undefined);
});

test('agentFetchData_ fetches and writes entirely through structured tool calls (fetch_api + write_cells)', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100], ['West', 200]],
    urlFetchStub: (url) => {
      if (String(url).indexOf('generativelanguage') !== -1) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"url":"https://api.example.com/users"}' }] } }] })
        };
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify([{ id: 1, name: 'Ada' }]) };
    }
  });

  const calls = [];
  const original = sandbox.executeStructuredToolCall_;
  sandbox.executeStructuredToolCall_ = function (call) {
    calls.push(call.tool_name);
    return original(call);
  };

  const result = sandbox.agentFetchData_('get 1 fake user', sandbox.buildDeepContext());

  assert.ok(result.isData);
  assert.equal(JSON.stringify(calls), JSON.stringify(['fetch_api', 'write_cells']));
  // Grid = [['id','name'], [1,'Ada']] written starting at the active cell (B2):
  // B2='id', C2='name' (header row), B3=1, C3='Ada' (data row).
  assert.equal(spreadsheet.getActiveSheet().getRange('B2').getValue(), 'id');
  assert.equal(spreadsheet.getActiveSheet().getRange('B3').getValue(), 1);
});

test('agentPushData_ posts entirely through a structured fetch_api call and surfaces non-2xx as a failure', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: (url) => {
      if (String(url).indexOf('generativelanguage') !== -1) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'https://hooks.example.com/in' }] } }] }) };
      }
      return { getResponseCode: () => 500, getContentText: () => '' };
    }
  });

  const sheet = spreadsheet.getActiveSheet();
  sheet.setActiveCellPosition(2, 1); // row 2 = data row, not the header row

  assert.throws(
    () => sandbox.agentPushData_('send this row to https://hooks.example.com/in', sandbox.buildDeepContext()),
    /Webhook rejected the payload. Status: 500/
  );
});

test('agentPushData_ succeeds end-to-end on a 2xx response, including an empty response body', () => {
  const { sandbox, spreadsheet } = createGasEnvironment({
    sheetData: [['Region', 'Revenue'], ['East', 100]],
    urlFetchStub: (url) => {
      if (String(url).indexOf('generativelanguage') !== -1) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'https://hooks.example.com/in' }] } }] }) };
      }
      return { getResponseCode: () => 204, getContentText: () => '' }; // no body — must not be treated as invalid JSON
    }
  });

  const sheet = spreadsheet.getActiveSheet();
  sheet.setActiveCellPosition(2, 1);

  const result = sandbox.agentPushData_('send this row to https://hooks.example.com/in', sandbox.buildDeepContext());
  assert.ok(result.isPush);
  assert.match(result.text, /Sync Successful/);
});
