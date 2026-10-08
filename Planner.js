/**
 * Planner.js — Task Planning Engine
 *
 * Every user request is decomposed into an explicit execution plan BEFORE any
 * tool runs. The plan is shown to the user for approval. Nothing executes
 * until the user clicks "Approve Plan".
 *
 * Why plan first?
 *   - Prevents unexpected writes (user knows exactly what will happen)
 *   - Enables cost estimation upfront ("This will cost ~$0.01")
 *   - Catches bad intent routing ("Did you mean generate or debug?")
 *   - Creates an execution record for audit/replay even before execution
 *   - Allows the user to edit the plan (cancel a step, change a tool)
 *
 * Plan lifecycle:
 *   generatePlan()      → plan created, status: 'pending_approval'
 *   approvePlan()       → status: 'approved'
 *   executePlanStep()   → status: 'executing' (called per-step from sidebar)
 *   plan complete       → status: 'completed', saved to EXECUTION_HISTORY
 *   cancelPlan()        → status: 'cancelled'
 */

// ─────────────────────────────────────────────────────────────────────────────
// PLANNER TOOL DECLARATION
// We use Gemini function calling to force structured plan output.
// This eliminates parsing and guarantees the plan has the exact schema we need.
// ─────────────────────────────────────────────────────────────────────────────

var PLANNER_FUNCTION_DECLARATION_ = [{
  functionDeclarations: [{
    name: 'create_execution_plan',
    description: 'Create a structured step-by-step execution plan for the user request. ' +
      'Only include steps that are strictly necessary. Prefer fewer, clearer steps over many vague ones.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reasoning: {
          type: 'STRING',
          description: 'One-paragraph explanation of why this plan was chosen over alternatives. ' +
            'Reference the specific spreadsheet context (column names, active cell) in your reasoning.'
        },
        needsApproval: {
          type: 'BOOLEAN',
          description: 'True if any step writes to the spreadsheet, makes an external API call, ' +
            'or deletes data. False for read-only operations like explain or search.'
        },
        steps: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              stepId:         { type: 'STRING',  description: 'Sequential ID: "1", "2", "3"...' },
              tool:           { type: 'STRING',  description: 'Tool or agent to invoke. Must be one of: ' +
                'inspect_workbook, search_headers, read_cells, read_formula, ' +
                'write_cells, insert_formula, create_chart, fetch_api, run_sql, ' +
                'generate_pivot, generate_dashboard, ' +
                'llm:generate_formula, llm:debug_formula, llm:explain_formula' },
              reason:         { type: 'STRING',  description: 'One sentence explaining WHY this step is needed. Be specific.' },
              dependencies:   { type: 'ARRAY',   items: { type: 'STRING' }, description: 'Step IDs that must complete before this step' },
              expectedOutput: { type: 'STRING',  description: 'Specific description of what this step will produce' },
              isDestructive:  { type: 'BOOLEAN', description: 'True if this step writes, deletes, or modifies data' },
              estimatedCostUsd: { type: 'NUMBER', description: 'Estimated cost in USD. 0 for tool-only steps, ~0.001 for Flash, ~0.01 for Pro' },
              args: { type: 'OBJECT', description: 'Concrete arguments for this tool, matching its ToolRegistry.js input schema exactly ' +
                '(e.g. for read_cells: {"range":"A1:B10"}; for run_sql: {"query":"SELECT ... FROM Sheet1 WHERE ..."}; ' +
                'for generate_pivot: {"sourceSheet":"...","sourceRange":"...","rowField":"...","valueField":"...","aggregation":"SUM"}). ' +
                'Omit fields only known after a prior step runs (e.g. insert_formula\'s "formula" after an llm:generate_formula step) — ' +
                'those are filled in automatically from that step\'s result at execution time.' }
            },
            required: ['stepId', 'tool', 'reason', 'dependencies', 'expectedOutput', 'isDestructive', 'estimatedCostUsd']
          }
        },
        totalEstimatedCostUsd: {
          type: 'NUMBER',
          description: 'Sum of all step costs'
        }
      },
      required: ['reasoning', 'needsApproval', 'steps', 'totalEstimatedCostUsd']
    }
  }]
}];

// ─────────────────────────────────────────────────────────────────────────────
// PLAN GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate an execution plan for a user prompt.
 * Called from handleRequest() BEFORE any agent runs.
 *
 * Returns the plan object (also stored in UserProperties for durability).
 * The sidebar displays this plan and waits for user approval.
 *
 * @param {string} prompt      - Raw user message
 * @param {string} contextStr  - Formatted spreadsheet context from Context.js
 * @param {string} intent      - Pre-classified intent from Router.js
 * @returns {object}           - Plan object with steps, reasoning, cost
 */
function generatePlan(prompt, contextStr, intent) {
  logInfo_('Planner', 'Generating plan', { intent: intent, promptLength: prompt.length });

  // Memory automatically influences planning: workbook constraints, learned
  // style preferences, session summary, and — specific to planning — past
  // success rate + common step pattern for this exact intent. No extra call
  // is required from handleRequest()/generatePlanForPrompt(); this is ambient,
  // the same principle Agents.js's agents already follow.
  var memoryHint = MEMORY.buildContextString(intent);

  var systemPrompt =
    'You are a task planning agent for a Google Sheets AI assistant.\n\n' +
    'Your job is to decompose the user\'s request into the minimum number of steps ' +
    'needed to safely and accurately complete it.\n\n' +
    'RULES:\n' +
    '1. Always include a read/search step BEFORE any write step to verify column names exist.\n' +
    '2. For formula generation: search_headers → llm:generate_formula → insert_formula\n' +
    '3. For data fetch: fetch_api → llm:generate_formula (for headers) → write_cells\n' +
    '4. For chart creation: read_cells (to verify data) → create_chart\n' +
    '5. Never generate a write step without a preceding verification step.\n' +
    '6. Explain/debug requests are read-only — no write steps.\n' +
    '7. Mark isDestructive=true for ANY step that writes, modifies, or creates content.\n\n' +
    'SPREADSHEET CONTEXT:\n' + contextStr + '\n\n' +
    (memoryHint ? memoryHint + '\n\n' : '') +
    'USER INTENT (pre-classified): ' + intent;

  try {
    var response = callGemini_({
      model: CONFIG.MODELS.FAST,  // Planning is reasoning, not generation — Flash is fine
      systemInstruction: systemPrompt,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: PLANNER_FUNCTION_DECLARATION_,
      forceFunctionCall: true,
      temperature: 0.1,   // Near-zero: plans should be deterministic, not creative
      agent: 'Planner'
    });

    var fnCall = extractFunctionCall_(response);
    if (!fnCall || !fnCall.args) {
      throw new Error('Planner did not return a function call');
    }

    var planData = fnCall.args;

    // Validate step count
    if (planData.steps.length > CONFIG.PLANNER.MAX_STEPS) {
      logWarn_('Planner', 'Plan exceeds max steps, truncating', { count: planData.steps.length });
      planData.steps = planData.steps.slice(0, CONFIG.PLANNER.MAX_STEPS);
    }

    // Build the full plan object
    var plan = {
      planId:              'plan_' + new Date().getTime(),
      prompt:              prompt,
      intent:              intent,
      status:              planData.needsApproval ? 'pending_approval' : 'auto_approved',
      reasoning:           planData.reasoning,
      needsApproval:       planData.needsApproval,
      steps:               planData.steps.map(function(s) {
        return {
          stepId:           s.stepId,
          tool:             s.tool,
          reason:           s.reason,
          dependencies:     s.dependencies || [],
          expectedOutput:   s.expectedOutput,
          isDestructive:    s.isDestructive || false,
          estimatedCostUsd: s.estimatedCostUsd || 0,
          args:             s.args || {},
          status:           'pending',   // pending → running → completed | failed | skipped
          result:           null,
          error:            null,
          startedAt:        null,
          completedAt:      null
        };
      }),
      totalEstimatedCostUsd: planData.totalEstimatedCostUsd || 0,
      createdAt:           new Date().toISOString(),
      approvedAt:          null,
      completedAt:         null,
      contextSnapshot:     contextStr   // Keep a snapshot of context at plan time
    };

    // Auto-approve read-only plans (explain, search, inspect) — no user action needed
    if (!planData.needsApproval) {
      plan.approvedAt = plan.createdAt;
      logInfo_('Planner', 'Plan auto-approved (read-only)', { planId: plan.planId });
    }

    // Persist plan to UserProperties so it survives a page refresh while user reviews it
    savePlan_(plan);

    // Record in ENTERPRISE audit log
    ENTERPRISE.audit.record({
      type: 'PLAN_CREATED',
      planId: plan.planId,
      intent: intent,
      stepCount: plan.steps.length,
      requiresApproval: plan.needsApproval,
      estimatedCost: plan.totalEstimatedCostUsd
    });

    logInfo_('Planner', 'Plan generated', {
      planId: plan.planId,
      steps: plan.steps.length,
      cost: plan.totalEstimatedCostUsd,
      autoApproved: !plan.needsApproval
    });

    return plan;

  } catch (e) {
    logError_('Planner', 'Plan generation failed: ' + e.message);

    // Fallback: create a single-step plan that runs the original intent directly.
    // This ensures the system degrades gracefully if the planner LLM fails.
    return generateFallbackPlan_(prompt, intent, contextStr);
  }
}

/**
 * Approve a pending plan. Called from the sidebar "Approve Plan" button.
 * @param {string} planId
 * @returns {object} The updated plan
 */
function approvePlan(planId) {
  var plan = loadPlan_(planId);
  if (!plan) throw createError_(ErrorType.VALIDATION_ERROR, 'Plan not found: ' + planId);
  if (plan.status !== 'pending_approval') {
    throw createError_(ErrorType.VALIDATION_ERROR, 'Plan is not awaiting approval (status: ' + plan.status + ')');
  }

  // Check plan hasn't expired (30 minutes from creation)
  var age = Date.now() - new Date(plan.createdAt).getTime();
  if (age > CONFIG.PLANNER.PLAN_TTL_MS) {
    plan.status = 'expired';
    savePlan_(plan);
    throw createError_(ErrorType.VALIDATION_ERROR, 'Plan expired. Please submit your request again.');
  }

  plan.status = 'approved';
  plan.approvedAt = new Date().toISOString();
  savePlan_(plan);

  ENTERPRISE.audit.record({
    type: 'PLAN_APPROVED',
    planId: planId
  });

  logInfo_('Planner', 'Plan approved', { planId: planId });
  return plan;
}

/**
 * Cancel a pending or approved plan.
 * @param {string} planId
 */
function cancelPlan(planId) {
  var plan = loadPlan_(planId);
  if (!plan) return;

  plan.status = 'cancelled';
  savePlan_(plan);

  ENTERPRISE.audit.record({ type: 'PLAN_CANCELLED', planId: planId });
  logInfo_('Planner', 'Plan cancelled', { planId: planId });
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAN EXECUTION
// Steps execute one at a time. The sidebar calls executePlanStep() after each
// step completes so it can update the UI progressively.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute the next pending step in an approved plan.
 * Called from the sidebar one step at a time for progressive UI feedback.
 *
 * Returns: { done, step, result, plan }
 *   done:   true when all steps complete, one fails fatally, or the plan was cancelled
 *   step:   the step that just ran (null if cancelled before any step ran)
 *   result: the step's result
 *   plan:   the updated plan (for UI rendering)
 *
 * Cancellation note: GAS gives no way to interrupt a function that's already
 * executing (no preemption, no SSE/WebSocket channel to signal across) — a
 * single step's LLM call or tool call runs to completion once started. What
 * IS achievable: requestPlanCancellation_() sets a flag checked at the START
 * of this function, BETWEEN steps. A multi-step plan can be stopped before
 * its next step starts; the currently-running step (if any) always finishes.
 */
function executePlanStep(planId) {
  var plan = loadPlan_(planId);
  if (!plan) throw createError_(ErrorType.VALIDATION_ERROR, 'Plan not found: ' + planId);

  if (isPlanCancellationRequested_(planId)) {
    clearPlanCancellation_(planId);
    plan.status = 'cancelled';
    plan.completedAt = new Date().toISOString();
    savePlan_(plan);
    ENTERPRISE.audit.record({ type: 'PLAN_CANCELLED', planId: planId });
    recordTaskHistory_(plan, 'cancelled');
    logInfo_('Planner', 'Plan cancelled by user request', { planId: planId });
    return { done: true, step: null, result: null, cancelled: true, plan: plan };
  }

  if (plan.status !== 'approved' && plan.status !== 'auto_approved' && plan.status !== 'executing') {
    throw createError_(ErrorType.VALIDATION_ERROR, 'Plan cannot be executed (status: ' + plan.status + ')');
  }

  // Find the next pending step whose dependencies are all completed
  var nextStep = getNextExecutableStep_(plan);

  if (!nextStep) {
    // No more steps to run — plan is complete
    plan.status = 'completed';
    plan.completedAt = new Date().toISOString();
    savePlan_(plan);
    ENTERPRISE.history.record(plan);
    ENTERPRISE.audit.record({ type: 'PLAN_COMPLETED', planId: planId });
    recordTaskHistory_(plan, 'completed');
    logInfo_('Planner', 'Plan completed', { planId: planId });
    return { done: true, step: null, result: null, plan: plan };
  }

  // Mark step as running
  plan.status = 'executing';
  nextStep.status = 'running';
  nextStep.startedAt = new Date().toISOString();
  savePlan_(plan);

  ENTERPRISE.audit.record({
    type: 'STEP_STARTED',
    planId: planId,
    stepId: nextStep.stepId,
    tool: nextStep.tool
  });

  // Each executePlanStep() call is its own isolated GAS execution when the
  // sidebar drives multi-step Plan Mode (one google.script.run per step), so
  // Observability's CURRENT_TRACE_ — which only lives for one execution — has
  // to be started fresh here rather than relying on handleRequest()'s wrapper
  // (which never runs for that path). But executePlanStep() is ALSO called
  // synchronously in a loop from executeFullPlan_() for auto_approved plans,
  // already inside a trace handleRequest() started — starting a second,
  // nested trace there would stomp CURRENT_TRACE_ and orphan the outer one
  // (handleRequest()'s own Observability.end() would then find nothing to
  // finalize). ownsTrace tracks which case this is: only start/end here if
  // no trace is already running; otherwise step events fold into the
  // caller's existing trace, which is exactly what we want for auto_approved
  // plans (one trace for the whole request, not one per step).
  var ownsTrace = !CURRENT_TRACE_;
  if (ownsTrace) Observability.start(plan.prompt, plan.intent);
  Observability.event('step_started', { stepId: nextStep.stepId, tool: nextStep.tool });

  // Execute the step
  var stepResult;
  var stepTrace;
  try {
    // Build accumulated context from previous step results
    var accumulatedContext = buildAccumulatedContext_(plan);

    stepResult = executeStep_(nextStep, accumulatedContext, plan);

    nextStep.status = 'completed';
    nextStep.result = stepResult;
    nextStep.completedAt = new Date().toISOString();

    ENTERPRISE.audit.record({
      type: 'STEP_COMPLETED',
      planId: planId,
      stepId: nextStep.stepId,
      tool: nextStep.tool
    });
    Observability.event('step_completed', { stepId: nextStep.stepId, tool: nextStep.tool });
    stepTrace = ownsTrace ? Observability.end('completed') : null;

  } catch (e) {
    nextStep.status = 'failed';
    nextStep.error = e.message;
    nextStep.completedAt = new Date().toISOString();
    plan.status = 'failed';

    ENTERPRISE.audit.record({
      type: 'STEP_FAILED',
      planId: planId,
      stepId: nextStep.stepId,
      tool: nextStep.tool,
      error: e.message
    });

    // Attempt transaction rollback on plan failure
    try {
      ENTERPRISE.transaction.rollback();
      logInfo_('Planner', 'Transaction rolled back after step failure');
    } catch (rollbackErr) {
      logWarn_('Planner', 'Rollback failed: ' + rollbackErr.message);
    }

    savePlan_(plan);
    recordTaskHistory_(plan, 'failed');
    logError_('Planner', 'Step failed', { planId: planId, stepId: nextStep.stepId, error: e.message });
    Observability.event('step_failed', { stepId: nextStep.stepId, tool: nextStep.tool, error: e.message });
    stepTrace = ownsTrace ? Observability.end('failed') : null;
    return { done: true, step: nextStep, result: null, error: e.message, plan: plan, trace: stepTrace };
  }

  savePlan_(plan);

  // Check if all steps are now done
  var allDone = plan.steps.every(function(s) {
    return s.status === 'completed' || s.status === 'skipped';
  });

  if (allDone) {
    plan.status = 'completed';
    plan.completedAt = new Date().toISOString();
    ENTERPRISE.transaction.commit();
    savePlan_(plan);
    ENTERPRISE.history.record(plan);
    ENTERPRISE.audit.record({ type: 'PLAN_COMPLETED', planId: planId });
    recordTaskHistory_(plan, 'completed');
  }

  return {
    done: allDone,
    step: nextStep,
    result: stepResult,
    plan: plan,
    moreSteps: !allDone,
    trace: stepTrace
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP EXECUTION DISPATCH
// Routes each step to the correct tool or LLM agent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a single plan step.
 * Routes to tool registry or LLM agent based on step.tool value.
 */
function executeStep_(step, accumulatedContext, plan) {
  var tool = step.tool;
  var isDryRun = ENTERPRISE.dryRun.isEnabled();

  logInfo_('Planner', 'Executing step', { stepId: step.stepId, tool: tool, dryRun: isDryRun });

  // LLM agent steps (prefixed with "llm:")
  if (tool.indexOf('llm:') === 0) {
    return executeLlmStep_(tool.replace('llm:', ''), step, accumulatedContext, plan);
  }

  // Tool registry steps
  // In dry run mode, write tools are intercepted
  if (isDryRun && step.isDestructive) {
    logInfo_('Planner', 'Dry run — skipping destructive step', { stepId: step.stepId });
    return {
      dryRun: true,
      message: 'DRY RUN: Step "' + tool + '" would have executed here.',
      wouldHaveRun: true
    };
  }

  // Create undo checkpoint before any destructive step
  if (step.isDestructive) {
    ENTERPRISE.transaction.snapshot(step);
  }

  // Dispatch to tool — Tools.js still handles the actual SpreadsheetApp calls
  // In a full ToolRegistry implementation these would route through executeTool_()
  return dispatchToTool_(tool, step, accumulatedContext);
}

/**
 * Dispatch an LLM-based step to the appropriate agent function.
 */
function executeLlmStep_(agentName, step, accumulatedContext, plan) {
  // Re-build context from the accumulated step results + original context snapshot
  var contextStr = plan.contextSnapshot || '';
  var context = buildDeepContext(); // Re-read current state (may have changed during plan)

  switch (agentName) {
    case 'generate_formula':
      var history = loadChatHistory_();
      // Give the formula agent the same ranked cross-sheet context the planner saw
      // (non-fatal: on any failure it falls back to the active-sheet context alone).
      var retrievalStr = '';
      try { retrievalStr = ContextRetriever.retrieve(plan.prompt, {}).contextString || ''; } catch (e) {
        logWarn_('Planner', 'Context retrieval for formula agent failed (non-fatal): ' + e.message);
      }
      var result = agentGenerateFormula_(plan.prompt, context, history, retrievalStr);
      // Store formula in accumulated context so insert_formula step can use it
      accumulatedContext.generatedFormula = result.formula;
      return result;

    case 'debug_formula':
      return agentDebugFormula_(plan.prompt, context);

    case 'explain_formula':
      var formula = accumulatedContext.formula || plan.prompt;
      return agentExplainFormula_(formula, context);

    default:
      throw createError_(ErrorType.VALIDATION_ERROR, 'Unknown LLM agent: ' + agentName);
  }
}

/**
 * Dispatch a tool step through ToolRegistry.js's executeTool_() — the real
 * four-gate pipeline (registry lookup -> schema validation -> security check
 * -> execution). This used to be a hand-rolled switch that only handled
 * inspect_workbook/search_headers/read_cells/read_formula/insert_formula
 * (with fetch_api stubbed as a no-op note); write_cells, create_chart,
 * run_sql, generate_pivot, and generate_dashboard had no case at all and
 * silently fell through to a "(no specific handler)" no-op, even though the
 * Planner LLM is explicitly told all 11 tool names are valid plan steps.
 *
 * The Planner's function-calling schema now lets the LLM attach concrete
 * `args` to each step (see PLANNER_FUNCTION_DECLARATION_ below). A few
 * fields genuinely can't be known until a prior step has run (most notably
 * insert_formula's `formula`, produced by a preceding llm:generate_formula
 * step) — those are backfilled here from accumulatedContext before handing
 * off to the registry.
 */
function dispatchToTool_(toolName, step, accumulatedContext) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var activeSheet = ss.getActiveSheet();

  var args = {};
  var stepArgs = step.args || {};
  Object.keys(stepArgs).forEach(function(k) { args[k] = stepArgs[k]; });

  if (toolName === 'insert_formula' && !args.formula) {
    args.formula = accumulatedContext.generatedFormula;
    if (!args.formula) throw createError_(ErrorType.VALIDATION_ERROR, 'No formula to insert (previous step may have failed)');
  }
  if ((toolName === 'insert_formula' || toolName === 'read_formula') && !args.cell) {
    args.cell = activeSheet.getActiveCell().getA1Notation();
  }
  if (toolName === 'search_headers' && !args.query) {
    args.query = step.reason || '';
  }
  if (toolName === 'read_cells' && !args.range) {
    var hasLastRowCol = activeSheet.getLastRow() > 0 && activeSheet.getLastColumn() > 0;
    args.range = hasLastRowCol
      ? 'A1:' + colIndexToLetter_(activeSheet.getLastColumn()) + activeSheet.getLastRow()
      : 'A1';
  }

  var result = executeTool_(toolName, args);
  Observability.toolCall({ tool_name: toolName, arguments: args, ok: result.ok, error: result.error, verification: null });
  if (!result.ok) {
    throw createError_(ErrorType.VALIDATION_ERROR, result.error);
  }

  var toolDef = TOOL_REGISTRY[toolName];
  if (toolDef && toolDef.isDestructive) {
    ENTERPRISE.ops.record({
      type: toolName,
      description: 'Executed ' + toolName + ' (' + (step.reason || '') + ')',
      sheetName: activeSheet.getName(),
      undoable: true
    });
  }

  return result.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION
// A per-plan flag in UserProperties, checked at the top of executePlanStep().
// See that function's docblock for exactly what "cancellation" can and can't
// mean on GAS (no preemption — only "stop before the next step starts").
// ─────────────────────────────────────────────────────────────────────────────

function requestPlanCancellation_(planId) {
  PropertiesService.getUserProperties().setProperty('CANCEL_' + planId, 'true');
  logInfo_('Planner', 'Cancellation requested', { planId: planId });
}

function isPlanCancellationRequested_(planId) {
  return PropertiesService.getUserProperties().getProperty('CANCEL_' + planId) === 'true';
}

function clearPlanCancellation_(planId) {
  PropertiesService.getUserProperties().deleteProperty('CANCEL_' + planId);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROGRESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Progress snapshot for a plan: how many steps are done, what's next. Plans
 * are persisted (savePlan_/loadPlan_ in UserProperties), so this reflects
 * true state even if the sidebar was closed and reopened mid-execution.
 */
function getPlanProgress_(planId) {
  var plan = loadPlan_(planId);
  if (!plan) return null;

  var completedSteps = plan.steps.filter(function (s) {
    return s.status === 'completed' || s.status === 'skipped';
  }).length;
  var failedStep = plan.steps.filter(function (s) { return s.status === 'failed'; })[0] || null;
  var nextStep = getNextExecutableStep_(plan);

  return {
    planId: planId,
    status: plan.status,
    totalSteps: plan.steps.length,
    completedSteps: completedSteps,
    percentComplete: plan.steps.length > 0 ? Math.round((completedSteps / plan.steps.length) * 100) : 100,
    nextStep: nextStep ? { stepId: nextStep.stepId, tool: nextStep.tool, reason: nextStep.reason } : null,
    failedStep: failedStep ? { stepId: failedStep.stepId, tool: failedStep.tool, error: failedStep.error } : null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESUME / CHECKPOINT RECOVERY
// Every step's completion is persisted (savePlan_ after each step in
// executePlanStep()), so a plan is inherently checkpointed — resuming just
// means calling executePlanStep() again and letting getNextExecutableStep_()
// pick up wherever it left off. These two functions make that explicit and
// safe rather than relying on the caller to know it works that way.
// ─────────────────────────────────────────────────────────────────────────────

/** Can this plan be resumed, and if not, why? */
function getResumableState_(planId) {
  var plan = loadPlan_(planId);
  if (!plan) return { resumable: false, reason: 'Plan not found.' };

  if (plan.status === 'completed') return { resumable: false, reason: 'Plan already completed.' };
  if (plan.status === 'failed') return { resumable: false, reason: 'Plan failed — fix the underlying issue and generate a new plan.' };
  if (plan.status === 'cancelled') return { resumable: false, reason: 'Plan was cancelled.' };
  if (plan.status === 'pending_approval') return { resumable: false, reason: 'Plan is awaiting approval, not paused mid-execution.' };

  var age = Date.now() - new Date(plan.createdAt).getTime();
  if (age > CONFIG.PLANNER.PLAN_TTL_MS && plan.steps.every(function (s) { return s.status === 'pending'; })) {
    return { resumable: false, reason: 'Plan expired before any step ran.' };
  }

  var progress = getPlanProgress_(planId);
  return { resumable: true, reason: null, progress: progress };
}

/**
 * Resumes a plan from its last checkpoint — validates resumability, then
 * runs exactly one more step (the same unit of progress the sidebar's
 * step-by-step loop already uses), so callers get the same progressive
 * feedback whether they're continuing fresh execution or recovering after
 * a reload.
 */
function resumePlan_(planId) {
  var state = getResumableState_(planId);
  if (!state.resumable) {
    throw createError_(ErrorType.VALIDATION_ERROR, 'Cannot resume plan: ' + state.reason);
  }
  logInfo_('Planner', 'Resuming plan', { planId: planId, progress: state.progress });
  return executePlanStep(planId);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a completed or failed plan into MEMORY.taskHistory — this is the
 * write side of "memory automatically influences future planning": the next
 * time generatePlan() runs for this same intent, it'll see the success rate
 * and step pattern this call just contributed to.
 */
function recordTaskHistory_(plan, status) {
  try {
    MEMORY.taskHistory.record({
      taskId: plan.planId,
      intent: plan.intent,
      prompt: plan.prompt,
      status: status,
      stepCount: plan.steps.length,
      stepTools: plan.steps
        .filter(function (s) { return s.status === 'completed'; })
        .map(function (s) { return s.tool; })
    });
  } catch (e) {
    logWarn_('Planner', 'Task history record failed: ' + e.message);
  }
}

/** Get the next step that is pending AND has all dependencies completed */
function getNextExecutableStep_(plan) {
  var completedIds = plan.steps
    .filter(function(s) { return s.status === 'completed' || s.status === 'skipped'; })
    .map(function(s) { return s.stepId; });

  return plan.steps.filter(function(s) {
    if (s.status !== 'pending') return false;
    return s.dependencies.every(function(depId) {
      return completedIds.indexOf(depId) !== -1;
    });
  })[0] || null;
}

/** Build a flat context object from all completed step results */
function buildAccumulatedContext_(plan) {
  var ctx = {};
  plan.steps.forEach(function(s) {
    if (s.status === 'completed' && s.result) {
      // Merge step results into context, prefixed by stepId
      if (typeof s.result === 'object') {
        Object.keys(s.result).forEach(function(k) {
          ctx['step' + s.stepId + '_' + k] = s.result[k];
          // Also set unprefixed versions for common fields
          if (k === 'formula' || k === 'generatedFormula') ctx.generatedFormula = s.result[k];
          if (k === 'matches') ctx.headerMatches = s.result[k];
        });
      }
    }
  });
  return ctx;
}

/** Fallback plan for when the planner LLM call fails */
function generateFallbackPlan_(prompt, intent, contextStr) {
  var toolMap = {
    'generate_formula': 'llm:generate_formula',
    'debug_formula':    'llm:debug_formula',
    'explain_formula':  'llm:explain_formula',
    'fetch_data':       'fetch_api',
    'push_data':        'fetch_api'
  };

  var plan = {
    planId: 'plan_fallback_' + new Date().getTime(),
    prompt: prompt,
    intent: intent,
    status: 'auto_approved',
    reasoning: 'Fallback single-step plan (planner unavailable).',
    needsApproval: false,
    steps: [{
      stepId: '1',
      tool: toolMap[intent] || 'llm:generate_formula',
      reason: 'Direct execution of user request',
      dependencies: [],
      expectedOutput: 'Result of ' + intent,
      isDestructive: intent === 'generate_formula' || intent === 'fetch_data',
      estimatedCostUsd: 0.01,
      args: {},
      status: 'pending',
      result: null, error: null, startedAt: null, completedAt: null
    }],
    totalEstimatedCostUsd: 0.01,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    contextSnapshot: contextStr
  };

  savePlan_(plan);
  return plan;
}

/** Persist plan to UserProperties */
function savePlan_(plan) {
  try {
    var key = CONFIG.PLANNER.PLAN_KEY_PREFIX + plan.planId;
    var serialized = JSON.stringify(plan);
    // Plans can be large (5-8KB). UserProperties allows 9KB per key.
    if (serialized.length > 8500) {
      // Trim contextSnapshot (largest field) to fit
      plan.contextSnapshot = plan.contextSnapshot
        ? plan.contextSnapshot.substring(0, 1000) + '...[truncated]'
        : '';
      serialized = JSON.stringify(plan);
    }
    PropertiesService.getUserProperties().setProperty(key, serialized);
  } catch (e) {
    logError_('Planner', 'Failed to save plan: ' + e.message);
  }
}

/** Load plan from UserProperties */
function loadPlan_(planId) {
  try {
    var key = CONFIG.PLANNER.PLAN_KEY_PREFIX + planId;
    var raw = PropertiesService.getUserProperties().getProperty(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    logError_('Planner', 'Failed to load plan: ' + e.message);
    return null;
  }
}

/** Column index (1-based) to letter (A, B, ..., Z, AA, AB, ...) */
function colIndexToLetter_(n) {
  var result = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
