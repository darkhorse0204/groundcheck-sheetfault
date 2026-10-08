/**
 * Code.js — Orchestrator & Entry Points
 *
 * Architecture (V2):
 *   Sidebar → handleRequest() → Memory.initSession() → Context → Router
 *          → generatePlan() → Cost Estimate → Approval (auto for read-only,
 *            explicit for destructive) → executeFullPlan_() → Rollback if a
 *            step fails
 *
 * No direct execution without planning: every request builds a plan first.
 * Read-only/cheap intents come back auto_approved (the Planner LLM marks
 * needsApproval:false) and execute immediately in the same call — this is
 * what keeps the common case feeling as fast as the old Direct Mode did.
 * Destructive/costly intents come back pending_approval and stop there;
 * the sidebar must call approvePlan()/executePlanStep() explicitly. Plan
 * Mode's generatePlanForPrompt() (below) still exists for users who want to
 * preview a plan before it runs even when it would have auto-approved.
 *
 * Modules:
 *   Config.js       — Constants, pricing, error types, logging
 *   MemoryManager.js — Five-layer memory (conversation, workbook, prefs, task, ops)
 *   Planner.js      — Task planning engine with approval workflow
 *   Enterprise.js   — Undo stack, audit log, cost tracking, dry run, transactions
 *   Context.js      — Deep spreadsheet context builder
 *   Api.js          — Gemini API client
 *   Router.js       — Intent classification via function calling
 *   Agents.js       — Specialist agents with ReAct + retry loops
 *   Verification.js — Four-layer formula verification + retry feedback builder
 *   Tools.js        — Spreadsheet & external API tools
 */

// ============================================
// MENU & SIDEBAR
// ============================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('✦ AI Copilot')
    .addItem('Open AI Copilot', 'showSidebar')
    .addSeparator()
    .addItem('Clear Memory', 'clearConversationMemory')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('AI Copilot')
    .setWidth(380);
  SpreadsheetApp.getUi().showSidebar(html);
}

// ============================================
// MAIN ORCHESTRATOR
// ============================================

function handleRequest(prompt, mode) {
  logInfo_('Orchestrator', 'Request received', { mode: mode, promptLength: prompt.length });
  Observability.start(prompt, null);
  Observability.event('request_received', { mode: mode });

  // Initialize memory for this session (loads workbook context, session summary, etc.)
  var memCtx = MEMORY.initSession();

  // Rate limiting — before any expensive work
  ENTERPRISE.rateLimit.check();

  // Permission check for write modes
  var writeIntents = ['generate_formula', 'fetch_data', 'push_data', 'generate', 'fetch', 'push'];
  if (writeIntents.indexOf(mode || '') !== -1) {
    var perm = ENTERPRISE.permissions.checkEditAccess();
    if (!perm.allowed) {
      Observability.end('failed');
      throw createError_(ErrorType.VALIDATION_ERROR, 'Permission denied: ' + perm.reason);
    }
  }

  var context = buildDeepContext();
  var contextStr = formatContextForPrompt_(context);
  Observability.context('spreadsheet', contextStr);

  // Ranked, token-budgeted context (ContextRetriever.js): the flat context
  // above only ever looks at the active sheet. This adds relevance-ranked
  // chunks spanning the whole workbook (other sheets' tables, formula-graph
  // neighbors, named ranges, dependency graph) without blowing the prompt
  // budget — see ContextRetriever.js's scoring signals. Non-fatal: retrieval
  // running SpreadsheetEngine.analyze() over an unusual workbook shape must
  // never break the request itself.
  try {
    var retrieval = ContextRetriever.retrieve(prompt, {});
    if (retrieval.contextString) {
      contextStr = contextStr + '\n\n' + retrieval.contextString;
      Observability.context('ranked-selection', retrieval.contextString);
    }
  } catch (e) {
    logWarn_('Orchestrator', 'Context retrieval failed (non-fatal): ' + e.message);
  }

  // Append memory context hints to the context string
  var memoryHints = MEMORY.buildContextString();
  if (memoryHints) contextStr = memoryHints + '\n\n' + contextStr;

  var intent;

  if (mode === 'auto' || !mode) {
    var classification = classifyIntent_(prompt, contextStr);
    intent = classification ? classification.intent : 'generate_formula';
  } else {
    var modeToIntent = {
      'generate': 'generate_formula',
      'generate_formula': 'generate_formula',
      'debug': 'debug_formula',
      'debug_formula': 'debug_formula',
      'explain': 'explain_formula',
      'explain_formula': 'explain_formula',
      'fetch': 'fetch_data',
      'fetch_data': 'fetch_data',
      'push': 'push_data',
      'push_data': 'push_data'
    };
    intent = modeToIntent[mode] || 'generate_formula';
  }

  logInfo_('Orchestrator', 'Dispatching to planner', { intent: intent });
  Observability.setIntent(intent);
  Observability.event('intent_classified', { intent: intent });

  // Append user turn to conversation memory
  MEMORY.conversation.append({ role: 'user', content: prompt });

  // No direct execution without planning: every request becomes a plan.
  // Read-only/cheap intents come back auto_approved and run in this same
  // call (see executeFullPlan_ below); destructive/costly intents come back
  // pending_approval and stop here until the sidebar calls approvePlan().
  var plan;
  try {
    plan = generatePlan(prompt, contextStr, intent);
    Observability.event('plan_generated', { planId: plan.planId, status: plan.status, steps: plan.steps.length });
  } catch (e) {
    ENTERPRISE.audit.record({ type: 'REQUEST_ERROR', intent: intent, error: e.message });
    MEMORY.prefs.observeRejected('', 'plan_error');
    logError_('Orchestrator', 'Plan generation error', { intent: intent, error: e.message });
    Observability.event('plan_generation_failed', { error: e.message });
    Observability.end('failed');
    throw e;
  }

  var result;
  if (plan.status === 'auto_approved') {
    try {
      result = executeFullPlan_(plan.planId);
      Observability.event('plan_executed', { planId: plan.planId });
    } catch (e) {
      ENTERPRISE.audit.record({ type: 'REQUEST_ERROR', intent: intent, error: e.message });
      MEMORY.prefs.observeRejected('', 'execution_error');
      logError_('Orchestrator', 'Plan execution error', { intent: intent, error: e.message });
      Observability.event('plan_execution_failed', { error: e.message });
      Observability.end('failed');
      throw e;
    }
    if (result.formula) {
      MEMORY.workbook.learn(prompt.substring(0, 80), result.formula);
      MEMORY.prefs.observeAccepted(result.formula);
    }
  } else {
    // pending_approval — do not execute. Return the plan for the sidebar to render.
    result = {
      text: 'This action needs your approval before it runs. Review the plan and click Approve.',
      pendingApproval: true,
      plan: plan
    };
    Observability.event('plan_pending_approval', { planId: plan.planId });
  }

  // Append model response to conversation memory
  MEMORY.conversation.append({
    role: 'model',
    content: result.formula || result.text || result.explanation || '',
    tokenCount: result.tokenCount
  });

  // Audit + operation log
  ENTERPRISE.audit.record({
    type: 'REQUEST_COMPLETED', intent: intent,
    hasFormula: !!result.formula, pendingApproval: !!result.pendingApproval
  });
  if (result.formula) {
    MEMORY.ops.record({
      type: 'insert_formula',
      description: 'Generated ' + result.formula.substring(0, 50),
      sheetName: SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName(),
      range: SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getActiveCell().getA1Notation(),
      undoable: true,
      metadata: { formula: result.formula }
    });
  }

  result.intent = intent;
  result.plan = result.plan || plan;
  logInfo_('Orchestrator', 'Request completed', { intent: intent, planId: plan.planId, planStatus: plan.status });
  result.trace = Observability.end(result.pendingApproval ? 'pending_approval' : 'completed');
  return result;
}

/**
 * Runs every step of an approved/auto-approved plan to completion (looping
 * executePlanStep — which itself snapshots + rolls back via
 * ENTERPRISE.transaction on step failure), then synthesizes one agent-shaped
 * result object from the step outputs. Prefers the last llm: step's result
 * (it already has the { text, formula, warnings, ... } shape callers expect)
 * and attaches the full step trail + plan for anything that wants the detail.
 */
function executeFullPlan_(planId) {
  var lastLlmResult = null;
  var stepResults = [];
  var stepOutcome;

  do {
    stepOutcome = executePlanStep(planId);
    if (stepOutcome.error) {
      throw createError_(ErrorType.API_ERROR, stepOutcome.error);
    }
    if (stepOutcome.step) {
      stepResults.push({ stepId: stepOutcome.step.stepId, tool: stepOutcome.step.tool, result: stepOutcome.result });
      if (stepOutcome.step.tool.indexOf('llm:') === 0 && stepOutcome.result) {
        lastLlmResult = stepOutcome.result;
      }
    }
  } while (!stepOutcome.done);

  var result = {};
  if (lastLlmResult) {
    Object.keys(lastLlmResult).forEach(function (k) { result[k] = lastLlmResult[k]; });
  } else {
    result.text = 'Plan completed successfully.';
  }
  result.steps = stepResults;
  result.plan = stepOutcome.plan;
  return result;
}

// ============================================
// PLAN MODE ENTRY POINT (sidebar-callable)
// ============================================

/**
 * Sidebar-callable wrapper around Planner.js's generatePlan().
 *
 * generatePlan(prompt, contextStr, intent) needs a formatted spreadsheet
 * context string and a pre-classified intent — neither of which the sidebar
 * can produce itself (it has no access to SpreadsheetApp or Gemini). This
 * mirrors exactly what handleRequest() does for Direct Mode: build context,
 * classify intent, then hand off. Without this wrapper, the sidebar's Plan
 * Mode toggle called generatePlan(prompt) directly with contextStr and intent
 * both undefined, so the planner LLM received a system prompt containing the
 * literal text "undefined" instead of real spreadsheet context.
 */
function generatePlanForPrompt(prompt) {
  logInfo_('Orchestrator', 'Plan requested', { promptLength: prompt.length });

  MEMORY.initSession();
  ENTERPRISE.rateLimit.check();

  var context = buildDeepContext();
  var contextStr = formatContextForPrompt_(context);

  var memoryHints = MEMORY.buildContextString();
  if (memoryHints) contextStr = memoryHints + '\n\n' + contextStr;

  var classification = classifyIntent_(prompt, contextStr);
  var intent = classification ? classification.intent : 'generate_formula';

  return generatePlan(prompt, contextStr, intent);
}

/** Progress snapshot for a plan (percent complete, next step, any failure) — sidebar polls this during multi-step execution. */
function getPlanProgress(planId) {
  return getPlanProgress_(planId);
}

/**
 * Requests cancellation of a plan. Checked between steps (see
 * Planner.js's executePlanStep() docblock for why GAS can't interrupt a
 * step that's already running) — the next executePlanStep()/resumePlanExecution()
 * call will stop instead of running another step.
 */
function cancelPlanExecution(planId) {
  requestPlanCancellation_(planId);
}

/** Can this plan be resumed (e.g. after the sidebar was closed mid-execution), and from where? */
function getResumableState(planId) {
  return getResumableState_(planId);
}

/** Resumes a plan from its last checkpoint — runs exactly one more step. */
function resumePlanExecution(planId) {
  return resumePlan_(planId);
}

// ============================================
// CELL OPERATIONS
// ============================================

// Structured tool calling: no direct SpreadsheetApp write here — insertion,
// validation, and the undo checkpoint all happen inside ToolRegistry's
// insert_formula tool. This is the sidebar's "Insert" button, so the formula
// was already generated + verified by an agent; expected_output re-asserts
// that (cheap, and catches the rare case where the sheet changed between
// generation and the user clicking Insert).
function insertFormulaIntoCell(formula) {
  var cell = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getActiveCell();
  var record = executeStructuredToolCall_({
    tool_name: 'insert_formula',
    arguments: { cell: cell.getA1Notation(), formula: formula },
    expected_output: { verified: true }
  });

  if (!record.ok) {
    throw createError_(ErrorType.VALIDATION_ERROR, record.error);
  }

  MEMORY.prefs.observeAccepted(formula);
  logInfo_('Code', 'Formula inserted', { formula: formula.substring(0, 50) });
  return record;
}

function getActiveCellFormula() {
  return SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getActiveCell().getFormula() || '';
}

function getActiveCellRef() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  return sheet.getName() + '!' + sheet.getActiveCell().getA1Notation();
}

// ============================================
// ENTERPRISE ENTRY POINTS (sidebar-callable)
// ============================================

/** Enhanced undo — uses the multi-level undo stack */
function undoLastEnterprise() {
  return ENTERPRISE.undo.pop();
}

/** Redo the most recently undone operation. Cleared by any new write. */
function redoLastEnterprise() {
  return ENTERPRISE.redo.pop();
}

/** Get the current undo stack for sidebar display */
function getUndoStack() {
  return ENTERPRISE.undo.getStack();
}

/** Get the current redo stack for sidebar display */
function getRedoStack() {
  return ENTERPRISE.redo.getStack();
}

/** Get recent operations from memory */
function getRecentOps(n) {
  return MEMORY.ops.getRecent(n || 10);
}

/** Get full enterprise status snapshot */
function getEnterpriseStatus() {
  return ENTERPRISE.getStatus();
}

/** Get cost summary */
function getCostSummary() {
  return ENTERPRISE.cost.getSummary();
}

/** Get recent audit log entries */
function getAuditLog(n) {
  return ENTERPRISE.audit.getRecent(n || 20);
}

/** Get execution history for sidebar display */
function getExecutionHistory(n) {
  return ENTERPRISE.history.formatForDisplay(n || 10);
}

/** Replay a past execution */
function replayExecution(planId) {
  return ENTERPRISE.history.replay(planId);
}

// ============================================
// OBSERVABILITY ENTRY POINTS (sidebar-callable)
// ============================================

/** Full trace (timeline, agent calls, prompts, context, tool calls, verifications) for the most recent request. */
function getObservabilityTrace() {
  return Observability.getCurrentTrace();
}

/** Lightweight summaries (latency, cost, retries, status) of the last N requests. */
function getObservabilityHistory(n) {
  return Observability.getTraceHistory(n || 20);
}

/** Enable or disable dry run mode */
function setDryRun(enabled) {
  if (enabled) {
    ENTERPRISE.dryRun.enable();
  } else {
    ENTERPRISE.dryRun.disable();
  }
}

/** Update a user preference from the sidebar settings panel */
function setPreference(key, value) {
  var patch = {};
  // Handle nested keys (formulaStyle.preferXLOOKUP)
  if (key === 'preferXLOOKUP' || key === 'preferArrayFormulas' || key === 'preferNamedRanges') {
    patch.formulaStyle = {};
    patch.formulaStyle[key] = value;
  } else {
    patch[key] = value;
  }
  MEMORY.prefs.update(patch);
}

/** Execute a batch of operations */
function executeBatch(operations) {
  operations.forEach(function(op) {
    ENTERPRISE.batch.queue(op);
  });
  return ENTERPRISE.batch.execute();
}

// ============================================
// TOOL REGISTRY ENTRY POINTS (sidebar-callable)
// ============================================

/**
 * Directly invoke a tool from the sidebar (e.g. a "Run SQL" panel) without
 * going through the full agent pipeline. args arrives as a JSON string from
 * google.script.run — parsed here, then dispatched through ToolRegistry.js's
 * four-gate executeTool_().
 */
function executeToolCall(toolName, args) {
  var parsedArgs;
  try {
    parsedArgs = args ? JSON.parse(args) : {};
  } catch (e) {
    throw createError_(ErrorType.PARSE_ERROR, 'Tool args must be valid JSON.');
  }

  var result = executeTool_(toolName, parsedArgs);
  if (!result.ok) {
    throw createError_(ErrorType.VALIDATION_ERROR, result.error);
  }
  return result.result;
}

/** Gemini function-calling declarations for all 11 registered tools, for agents that need them. */
function getGeminiToolDeclarations() {
  return buildGeminiDeclarations_();
}

// ============================================
// MEMORY ENTRY POINTS (sidebar-callable)
// ============================================

/** Clear conversation memory (keeps workbook + prefs) */
function clearConversationMemory() {
  MEMORY.conversation.clear();
  logInfo_('Code', 'Conversation memory cleared');
}

/** Clear all user memory */
function clearAllMemory() {
  MEMORY.clearAll();
  logInfo_('Code', 'All memory cleared');
}

/**
 * Snapshot for the sidebar's Context tab: the cheap active-sheet facts
 * (sheet, cell, dimensions, headers, named ranges) plus ContextRetriever's
 * ranked chunk selection, so the user can see what the copilot would
 * actually use right now — not just the active sheet, but which chunks
 * from across the whole workbook scored highest and why. Uses the last
 * user prompt (if any) so the ranking reflects the live conversation
 * instead of an untargeted, prompt-less pass.
 */
function getCurrentContext() {
  var context = buildDeepContext();
  var ranked = null;

  try {
    var lastPrompt = '';
    try {
      var session = MEMORY.conversation.get();
      var lastUserTurn = ((session && session.turns) || []).filter(function (m) { return m.role === 'user'; }).pop();
      lastPrompt = lastUserTurn ? lastUserTurn.content : '';
    } catch (e) { /* memory may not be initialized yet */ }

    var retrieval = ContextRetriever.retrieve(lastPrompt, {});
    ranked = {
      totalTokens: retrieval.selection.totalTokens,
      maxTokens: retrieval.selection.maxTokens,
      consideredCount: retrieval.selection.consideredCount,
      selectedCount: retrieval.selection.selected.length,
      chunks: retrieval.selection.selected.slice(0, 12).map(function (entry) {
        return {
          id: entry.chunk.id,
          type: entry.chunk.type,
          sheet: entry.chunk.sheet,
          score: Math.round(entry.score * 100) / 100,
          tokenEstimate: entry.chunk.tokenEstimate,
          preview: (entry.chunk.text || '').substring(0, 160)
        };
      })
    };
  } catch (e) {
    logWarn_('Code', 'getCurrentContext ranked selection failed: ' + e.message);
  }

  return {
    spreadsheetName: context.spreadsheetName,
    sheetName: context.sheetName,
    activeCell: context.activeCell,
    dimensions: context.dimensions,
    headers: (context.headers || []).filter(Boolean),
    namedRanges: context.namedRanges || [],
    nearbyFormulaCount: (context.nearbyFormulas || []).length,
    ranked: ranked
  };
}

/** Get the current memory context (for Context Viewer in sidebar) */
function getMemoryContext() {
  return {
    workbook: MEMORY.workbook.get(),
    prefs: MEMORY.prefs.get(),
    recentOps: MEMORY.ops.getRecent(5),
    sessionSummary: MEMORY.conversation.getSummary(),
    activeTask: MEMORY.task.isActive() ? MEMORY.task.get() : null
  };
}

// ============================================
// LEGACY STUBS — Backward compatibility
// ============================================

function clearChatMemory() { clearConversationMemory(); }
function undoLastAction()   { return ENTERPRISE.undo.pop(); }
function hasUndoAvailable() { return ENTERPRISE.undo.depth() > 0; }

function generateFormulaGAS(prompt) { return handleRequest(prompt, 'generate').text; }
function debugFormulaGAS(f)         { return handleRequest(f, 'debug').text; }
function explainFormulaGAS(f)       { return handleRequest(f, 'explain').text; }
function fetchDataGAS(prompt)       { return handleRequest(prompt, 'fetch').text; }
function pushDataGAS(prompt)        { return handleRequest(prompt, 'push').text; }
function getSheetContext()          { return formatContextForPrompt_(buildDeepContext()); }