'use strict';
/**
 * Verifies that handleRequest() actually wires Memory + Enterprise the way
 * the README's "Request lifecycle" section describes, AND (per the
 * mandatory-planning rewrite) that no request executes without first going
 * through generatePlan(): auto_approved plans (read-only/cheap intents)
 * execute immediately in the same call; pending_approval plans (destructive/
 * costly intents) stop and return the plan without running a single step.
 *
 * Before the fix, Code.js contained a second, later `handleRequest`
 * definition that silently shadowed this one — none of the Memory/Enterprise
 * calls below ever ran in production even though the code for them existed.
 * This test still fails if that regresses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

/**
 * Stubs callGemini_ to distinguish the Planner's function-calling request
 * (identified by its first tool declaration's name) from a plain llm: step
 * call, since handleRequest now always plans before executing anything.
 */
function withPlanningStub(sandbox, opts) {
  opts = opts || {};
  var needsApproval = !!opts.needsApproval;
  var formulaText = opts.formulaText || '=SUM(B3:B3)';
  var stepTool = opts.stepTool || 'llm:generate_formula';

  sandbox.callGemini_ = function (options) {
    var firstToolName = options.tools && options.tools[0].functionDeclarations[0].name;

    if (firstToolName === 'create_execution_plan') {
      return {
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                name: 'create_execution_plan',
                args: {
                  reasoning: 'test plan',
                  needsApproval: needsApproval,
                  steps: [{
                    stepId: '1', tool: stepTool, reason: 'do it', dependencies: [],
                    expectedOutput: 'result', isDestructive: true, estimatedCostUsd: 0.01
                  }],
                  totalEstimatedCostUsd: 0.01
                }
              }
            }]
          }
        }]
      };
    }

    return { candidates: [{ content: { parts: [{ text: formulaText }] } }] };
  };
}

test('handleRequest() initializes memory, checks rate limit, plans, and auto-executes an auto_approved plan', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;
  withPlanningStub(sandbox, { needsApproval: false, formulaText: '=SUM(B3:B3)' });

  const calls = { initSession: 0, rateLimitCheck: 0, auditRecord: [], conversationAppend: 0 };

  const originalInitSession = sandbox.MEMORY.initSession.bind(sandbox.MEMORY);
  sandbox.MEMORY.initSession = function () { calls.initSession++; return originalInitSession(); };

  const originalRateCheck = sandbox.ENTERPRISE.rateLimit.check.bind(sandbox.ENTERPRISE.rateLimit);
  sandbox.ENTERPRISE.rateLimit.check = function () { calls.rateLimitCheck++; return originalRateCheck(); };

  const originalAuditRecord = sandbox.ENTERPRISE.audit.record.bind(sandbox.ENTERPRISE.audit);
  sandbox.ENTERPRISE.audit.record = function (evt) { calls.auditRecord.push(evt.type); return originalAuditRecord(evt); };

  const originalAppend = sandbox.MEMORY.conversation.append.bind(sandbox.MEMORY.conversation);
  sandbox.MEMORY.conversation.append = function (turn) { calls.conversationAppend++; return originalAppend(turn); };

  const result = sandbox.handleRequest('sum revenue', 'generate');

  assert.equal(result.formula, '=SUM(B3:B3)');
  assert.equal(result.intent, 'generate_formula');
  assert.equal(result.pendingApproval, undefined, 'an auto_approved plan must not come back pending approval');
  assert.equal(result.plan.status, 'completed');

  assert.equal(calls.initSession, 1, 'handleRequest must call MEMORY.initSession() exactly once');
  assert.equal(calls.rateLimitCheck, 1, 'handleRequest must call ENTERPRISE.rateLimit.check() exactly once');
  assert.equal(calls.conversationAppend, 2, 'handleRequest must append both the user turn and the model turn');
  assert.ok(calls.auditRecord.includes('REQUEST_COMPLETED'), 'handleRequest must record a REQUEST_COMPLETED audit event');
});

test('handleRequest() does not execute a single step of a pending_approval plan — no direct execution without planning', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;
  withPlanningStub(sandbox, { needsApproval: true, stepTool: 'insert_formula' });

  let insertCalled = false;
  const originalExecuteTool = sandbox.executeTool_;
  sandbox.executeTool_ = function (name, args) {
    if (name === 'insert_formula') insertCalled = true;
    return originalExecuteTool(name, args);
  };

  const result = sandbox.handleRequest('sum revenue', 'generate');

  assert.equal(result.pendingApproval, true);
  assert.equal(result.plan.status, 'pending_approval');
  assert.equal(insertCalled, false, 'no tool must execute before the plan is approved');
});

test('an approved plan executes its steps and completes exactly like the auto_approved fast path', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100],
      ['West', 200]
    ]
  });
  const { sandbox } = env;
  withPlanningStub(sandbox, { needsApproval: true, formulaText: '=SUM(B3:B3)' });

  const pending = sandbox.handleRequest('sum revenue', 'generate');
  assert.equal(pending.pendingApproval, true);

  const approved = sandbox.approvePlan(pending.plan.planId);
  assert.equal(approved.status, 'approved');

  const outcome = sandbox.executeFullPlan_(pending.plan.planId);
  assert.equal(outcome.formula, '=SUM(B3:B3)');
  assert.equal(outcome.plan.status, 'completed');
});

test('handleRequest() denies write intents when permissions.checkEditAccess() disallows them, before any plan is generated', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100]
    ]
  });
  const { sandbox } = env;
  withPlanningStub(sandbox);

  sandbox.ENTERPRISE.permissions.checkEditAccess = () => ({ allowed: false, reason: 'view-only test override' });

  assert.throws(
    () => sandbox.handleRequest('sum revenue', 'generate'),
    /Permission denied/,
    'handleRequest must surface the permission check before generating a plan'
  );
});

test('handleRequest() records a REQUEST_ERROR audit event and rethrows when the model is unreachable throughout', () => {
  const env = createGasEnvironment({
    sheetData: [
      ['Region', 'Revenue'],
      ['East', 100]
    ]
  });
  const { sandbox } = env;
  // Every callGemini_ call fails — including inside the Planner, which falls
  // back to a deterministic single-step plan (generateFallbackPlan_) rather
  // than propagating the error itself. The fallback plan's own llm: step
  // then hits the same failing stub, and THAT failure must still surface.
  sandbox.callGemini_ = function () {
    throw sandbox.createError_(sandbox.ErrorType.API_ERROR, 'simulated Gemini outage');
  };

  const auditTypes = [];
  const originalAuditRecord = sandbox.ENTERPRISE.audit.record.bind(sandbox.ENTERPRISE.audit);
  sandbox.ENTERPRISE.audit.record = (evt) => { auditTypes.push(evt.type); return originalAuditRecord(evt); };

  assert.throws(() => sandbox.handleRequest('sum revenue', 'generate'), /simulated Gemini outage/);
  assert.ok(auditTypes.includes('REQUEST_ERROR'), 'a failed plan/execution must still be recorded in the audit log');
});
