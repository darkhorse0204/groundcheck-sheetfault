/**
 * Observability.js — Execution Tracing for the Sidebar
 *
 * Captures everything that happens during one handleRequest() call into a
 * single structured "trace" object: an Execution Timeline, per-call Agent
 * Trace, the actual Prompts sent, the Context used, every Tool Call made,
 * Latency per step, Cost, Retry count, and every Verification Result — then
 * renders all of it in the sidebar's Observability tab.
 *
 * How tracing works across one GAS execution:
 *   A single `google.script.run` call runs as one isolated GAS execution.
 *   CURRENT_TRACE_ (a plain module-level variable) accumulates state for
 *   the DURATION of that one execution only — there is no cross-request
 *   in-memory state in GAS. startTrace_() (called once, at the top of
 *   handleRequest()) creates it; endTrace_() (called once, at the end)
 *   persists it and clears the variable. Every trace*_() helper is a no-op
 *   if no trace is active, so instrumentation call sites (Api.js,
 *   ToolRegistry.js, Agents.js) never need to check "is tracing on" first.
 *
 * Storage (bounded, same discipline as Enterprise.js's audit/history):
 *   The full current/latest trace (including prompt text, truncated) lives
 *   in CacheService — allows up to 100KB, comfortably fits one trace, 1h TTL.
 *   A LIGHTWEIGHT summary (timing/cost/retries/status, no prompt text) of
 *   past traces is appended to a rolling UserProperties history — this is
 *   what the Execution Timeline's "past requests" view reads, without
 *   blowing UserProperties' 9KB-per-key budget on stored prompt text.
 */

var OBSERVABILITY_CONFIG_ = {
  MAX_EVENTS_PER_TRACE: 200,
  MAX_PROMPT_CHARS: 4000,       // per stored prompt, in the full current trace
  MAX_HISTORY_ENTRIES: 20,      // lightweight summaries
  CURRENT_TRACE_KEY: 'OBS_CURRENT_TRACE',
  CURRENT_TRACE_TTL_SECONDS: 3600,
  HISTORY_KEY: 'OBS_TRACE_HISTORY'
};

var CURRENT_TRACE_ = null;

// ============================================
// TRACE LIFECYCLE
// ============================================

function startTrace_(prompt, intent) {
  CURRENT_TRACE_ = {
    traceId: 'trace_' + new Date().getTime(),
    prompt: (prompt || '').substring(0, 300),
    intent: intent || null,
    startedAt: new Date().toISOString(),
    startTime: Date.now(),
    status: 'running',
    events: [],        // Execution Timeline
    agentCalls: [],     // Agent Trace (per LLM call: agent, model, durationMs)
    prompts: [],        // Prompt Viewer (truncated system prompt + user text per call)
    contexts: [],       // Context Viewer (spreadsheet context snapshots used)
    toolCalls: [],      // Tool Calls (structured tool call records)
    verifications: [],  // Verification Results
    retryCount: 0,
    endedAt: null,
    durationMs: null,
    totalCostUsd: 0,
    totalTokens: 0
  };
  return CURRENT_TRACE_;
}

/** Ends the current trace, persists it, and clears CURRENT_TRACE_. Safe to call with no active trace. */
function endTrace_(status) {
  if (!CURRENT_TRACE_) return null;

  CURRENT_TRACE_.status = status || 'completed';
  CURRENT_TRACE_.endedAt = new Date().toISOString();
  CURRENT_TRACE_.durationMs = Date.now() - CURRENT_TRACE_.startTime;

  var finished = CURRENT_TRACE_;
  saveCurrentTrace_(finished);
  appendTraceHistorySummary_(finished);

  CURRENT_TRACE_ = null;
  return finished;
}

// ============================================
// INSTRUMENTATION HOOKS (no-op if no trace is active)
// ============================================

/** Execution Timeline: a labeled instant, with elapsed-ms-since-start. */
function traceEvent_(type, data) {
  if (!CURRENT_TRACE_) return;
  CURRENT_TRACE_.events.push({
    type: type,
    elapsedMs: Date.now() - CURRENT_TRACE_.startTime,
    data: data || null
  });
  if (CURRENT_TRACE_.events.length > OBSERVABILITY_CONFIG_.MAX_EVENTS_PER_TRACE) {
    CURRENT_TRACE_.events.shift();
  }
}

/** Agent Trace + Latency: one entry per LLM call. */
function traceAgentCall_(agentName, model, durationMs) {
  if (!CURRENT_TRACE_) return;
  CURRENT_TRACE_.agentCalls.push({
    agent: agentName || 'unknown',
    model: model,
    durationMs: durationMs,
    at: new Date().toISOString()
  });
}

/** Prompt Viewer: the actual system prompt + user text sent for one LLM call (truncated). */
function tracePrompt_(agentName, systemPrompt, userText) {
  if (!CURRENT_TRACE_) return;
  var maxChars = OBSERVABILITY_CONFIG_.MAX_PROMPT_CHARS;
  CURRENT_TRACE_.prompts.push({
    agent: agentName || 'unknown',
    systemPrompt: (systemPrompt || '').substring(0, maxChars),
    userText: (userText || '').substring(0, maxChars),
    truncated: (systemPrompt || '').length > maxChars,
    at: new Date().toISOString()
  });
}

/** Context Viewer: the spreadsheet context string used for one call (truncated). */
function traceContext_(label, contextStr) {
  if (!CURRENT_TRACE_) return;
  var maxChars = OBSERVABILITY_CONFIG_.MAX_PROMPT_CHARS;
  CURRENT_TRACE_.contexts.push({
    label: label || 'context',
    text: (contextStr || '').substring(0, maxChars),
    truncated: (contextStr || '').length > maxChars,
    at: new Date().toISOString()
  });
}

/** Tool Calls: records a structured tool call (see ToolRegistry.js's executeStructuredToolCall_). */
function traceToolCall_(record) {
  if (!CURRENT_TRACE_ || !record) return;
  CURRENT_TRACE_.toolCalls.push({
    tool_name: record.tool_name,
    arguments: record.arguments,
    ok: record.ok,
    error: record.error,
    verified: record.verification ? record.verification.passed : null,
    at: new Date().toISOString()
  });
}

/** Verification Results: records one verification outcome (formula, data shape, tool expected_output, ...). */
function traceVerification_(label, verification) {
  if (!CURRENT_TRACE_ || !verification) return;
  CURRENT_TRACE_.verifications.push({
    label: label || 'verification',
    valid: !!verification.valid,
    errors: verification.errors || [],
    warnings: verification.warnings || [],
    at: new Date().toISOString()
  });
  if (!verification.valid) CURRENT_TRACE_.retryCount++;
}

/** Cost: accumulates into the trace total (Api.js already records into ENTERPRISE.cost separately). */
function traceCost_(costUsd, tokens) {
  if (!CURRENT_TRACE_) return;
  CURRENT_TRACE_.totalCostUsd = parseFloat((CURRENT_TRACE_.totalCostUsd + (costUsd || 0)).toFixed(6));
  CURRENT_TRACE_.totalTokens += (tokens || 0);
}

/** Sets/updates the intent once it's classified (unknown at startTrace_() time). */
function traceSetIntent_(intent) {
  if (!CURRENT_TRACE_) return;
  CURRENT_TRACE_.intent = intent;
}

// ============================================
// STORAGE
// ============================================

function saveCurrentTrace_(trace) {
  try {
    CacheService.getUserCache().put(
      OBSERVABILITY_CONFIG_.CURRENT_TRACE_KEY,
      JSON.stringify(trace),
      OBSERVABILITY_CONFIG_.CURRENT_TRACE_TTL_SECONDS
    );
  } catch (e) {
    logWarn_('Observability', 'Failed to save current trace: ' + e.message);
  }
}

function appendTraceHistorySummary_(trace) {
  try {
    var history = loadTraceHistory_();
    history.unshift({
      traceId: trace.traceId,
      intent: trace.intent,
      prompt: trace.prompt,
      status: trace.status,
      durationMs: trace.durationMs,
      totalCostUsd: trace.totalCostUsd,
      totalTokens: trace.totalTokens,
      retryCount: trace.retryCount,
      toolCallCount: trace.toolCalls.length,
      agentCallCount: trace.agentCalls.length,
      startedAt: trace.startedAt
    });
    if (history.length > OBSERVABILITY_CONFIG_.MAX_HISTORY_ENTRIES) {
      history = history.slice(0, OBSERVABILITY_CONFIG_.MAX_HISTORY_ENTRIES);
    }
    PropertiesService.getUserProperties().setProperty(
      OBSERVABILITY_CONFIG_.HISTORY_KEY,
      JSON.stringify(history)
    );
  } catch (e) {
    logWarn_('Observability', 'Failed to append trace history: ' + e.message);
  }
}

function loadTraceHistory_() {
  try {
    var raw = PropertiesService.getUserProperties().getProperty(OBSERVABILITY_CONFIG_.HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

/** Full detail for the most recently completed trace (or null if none/expired). */
function getCurrentTrace_() {
  try {
    var raw = CacheService.getUserCache().get(OBSERVABILITY_CONFIG_.CURRENT_TRACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** Lightweight summaries of the last N requests, for the Execution Timeline / latency+cost trend. */
function getTraceHistory_(n) {
  return loadTraceHistory_().slice(0, n || OBSERVABILITY_CONFIG_.MAX_HISTORY_ENTRIES);
}

// ============================================
// PUBLIC API
// ============================================

var Observability = {
  start: startTrace_,
  end: endTrace_,
  event: traceEvent_,
  agentCall: traceAgentCall_,
  prompt: tracePrompt_,
  context: traceContext_,
  toolCall: traceToolCall_,
  verification: traceVerification_,
  cost: traceCost_,
  setIntent: traceSetIntent_,
  getCurrentTrace: getCurrentTrace_,
  getTraceHistory: getTraceHistory_
};
