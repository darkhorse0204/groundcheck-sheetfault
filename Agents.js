/**
 * Agents.js — Specialist Agents with a Uniform plan/execute/verify/retry/explain Interface
 *
 * Every agent (FormulaAgent, DebugAgent, ExplanationAgent, DataAgent,
 * PushAgent) exposes the same five methods:
 *
 *   plan(session)    — build the system prompt / setup for this request
 *   execute(session) — take one action (an LLM call, a fetch, a write)
 *   verify(session)  — check the result (verifyFormula_, verifyDataShape_, ...)
 *   retry(session)   — re-execute with structured error feedback after a
 *                      failed verify() (agents that don't self-correct just
 *                      alias this to execute() — see runAgentLoop_ below)
 *   explain(session) — produce the human-readable text (display only; never
 *                      the thing other code branches on)
 *
 * All five communicate through one structured JSON "session" object that
 * accumulates state as it's threaded through each call — plan()/execute()/
 * verify()/retry() never parse each other's natural-language output to
 * decide what to do next; every field they exchange is a typed value on
 * `session` (session.candidate, session.verification, ...).
 *
 * runAgentLoop_() drives any conforming agent through Reason -> Act ->
 * Observe -> (retry) -> Explain. FormulaAgent is the only agent with a real
 * self-correction loop (maxRetries: 2, matching the original ReAct design);
 * Debug/Explain/Data/Push set maxRetries: 0, so the loop runs their execute()
 * once and stops — same behavior they always had, just through the same
 * driver and interface as FormulaAgent instead of five different shapes.
 */

// ============================================
// GENERIC AGENT LOOP DRIVER
// ============================================

// An attempt needs repair when verification failed — or, if
// CONFIG.VERIFICATION.REPAIR_ON_SUSPICIOUS is on, when it merely looks suspicious.
function agentNeedsRepair_(session) {
  return typeof verificationNeedsRepair_ === 'function' && session.verification && session.verification.errors
    ? verificationNeedsRepair_(session.verification)
    : !session.verification.valid;
}

function runAgentLoop_(agent, initialSession) {
  var session = agent.plan(initialSession);
  session.attempt = 0;

  while (true) {
    session = session.attempt === 0 ? agent.execute(session) : agent.retry(session);
    session = agent.verify(session);

    if (!agentNeedsRepair_(session) || session.attempt >= session.maxRetries) {
      session = agent.explain(session);
      return session;
    }
    session.attempt++;
  }
}

// ============================================
// SYSTEM PROMPTS WITH FEW-SHOT EXAMPLES
// ============================================
//
// Each prompt is crafted based on hours of trial and error. Key learnings:
//   1. "Output ONLY the formula" still gets violated ~10% of the time. The regex
//      cleanup and verification layer catch the rest.
//   2. Few-shot examples massively reduce hallucinated functions (SUMIFF, LOOKUPV, etc.)
//   3. Injecting the context string at the END of the prompt works better than the beginning.
//      The LLM seems to weight the last section more heavily for grounding.

// Formats the ambient memory hints (workbook constraints, learned style
// preferences, session summary — from MEMORY.buildContextString()) into the
// system prompt, right after the role declaration and before the rules. This
// is what the README's "System prompt structure" section calls for:
// role -> workbook constraints -> prefs -> session context -> spreadsheet
// context -> output constraints. MEMORY.buildContextString() already joins
// workbookHint + styleHint + sessionSummary in that exact order.
function withMemoryBlock_(memoryHints) {
  return memoryHints ? memoryHints + '\n\n' : '';
}

var PROMPTS_ = {
  GENERATE: function(contextStr, memoryHints) {
    return 'You are an expert Google Sheets formula engineer.\n\n' +
      withMemoryBlock_(memoryHints) +
      'RULES:\n' +
      '1. Output ONLY the raw formula starting with "=". No markdown, no backticks, no explanation.\n' +
      '2. Use the spreadsheet context below to scope ranges correctly.\n' +
      '3. If data goes to row N, use that exact row number (not open-ended ranges unless appropriate).\n' +
      '4. Use the column letters and header names from the context.\n' +
      '5. If the user references a previous formula, check the conversation history.\n\n' +
      'EXAMPLES:\n' +
      'User: "sum revenue for East region"\n' +
      'Context: Headers: Col A="Region"(text), Col B="Revenue"(number), 50 rows\n' +
      'Output: =SUMIF(A2:A50,"East",B2:B50)\n\n' +
      'User: "count unique names"\n' +
      'Context: Headers: Col A="Name"(text), 100 rows\n' +
      'Output: =COUNTA(UNIQUE(A2:A100))\n\n' +
      'User: "vlookup product price from Sheet2"\n' +
      'Context: Sheet="Orders", Headers: Col A="Product"(text), active cell B2\n' +
      'Output: =VLOOKUP(A2,Sheet2!A:B,2,FALSE)\n\n' +
      contextStr;
  },

  DEBUG: function(contextStr, memoryHints) {
    return 'You are an expert Google Sheets debugger.\n\n' +
      withMemoryBlock_(memoryHints) +
      'RULES:\n' +
      '1. First line: explain why the formula is broken in ONE clear sentence.\n' +
      '2. Second line: output the corrected formula starting with "=".\n' +
      '3. Do NOT use markdown or backticks.\n' +
      '4. Use the spreadsheet context to verify range references are correct.\n\n' +
      'EXAMPLES:\n' +
      'Input: =SUMIF(A:A,"East",B:B\n' +
      'Output:\n' +
      'Missing closing parenthesis.\n' +
      '=SUMIF(A:A,"East",B:B)\n\n' +
      'Input: =VLOOKUP(A2,B:C,3,FALSE)\n' +
      'Output:\n' +
      'Column index 3 exceeds the 2-column range B:C.\n' +
      '=VLOOKUP(A2,B:C,2,FALSE)\n\n' +
      contextStr;
  },

  EXPLAIN: function(contextStr, memoryHints) {
    return 'You are an expert Google Sheets instructor.\n\n' +
      withMemoryBlock_(memoryHints) +
      'RULES:\n' +
      '1. Break down the formula step-by-step using short bullet points.\n' +
      '2. Explain each function and what it does in plain English.\n' +
      '3. Reference actual column names from the context when available.\n' +
      '4. Keep it concise and beginner-friendly.\n' +
      '5. At the end, add a one-line summary of what the formula achieves.\n\n' +
      contextStr;
  },

  // The Fetch router uses JSON mode to get a clean { "url": "..." } response.
  // We hardcode well-known free APIs as preferred options to reduce hallucination.
  FETCH_ROUTER: 'You are a strict API routing assistant.\n\n' +
    'RULES:\n' +
    '1. The user wants to fetch data. Find a free, public API (no auth) that provides it.\n' +
    '2. Output ONLY a valid JSON object: {"url": "https://..."}\n' +
    '3. Prefer well-known APIs: jsonplaceholder, restcountries, coindesk, open-meteo, etc.\n' +
    '4. The URL must be a complete, directly fetchable endpoint.\n\n' +
    'EXAMPLES:\n' +
    'Input: "get 10 fake users"\nOutput: {"url": "https://jsonplaceholder.typicode.com/users"}\n\n' +
    'Input: "bitcoin price"\nOutput: {"url": "https://api.coindesk.com/v1/bpi/currentprice.json"}\n\n' +
    'Input: "list of countries"\nOutput: {"url": "https://restcountries.com/v3.1/all?fields=name,capital,population,region"}',

  // Dead simple URL extractor. We use temp=0.0 because we need exact extraction, not creativity.
  // The ERROR_NO_URL sentinel lets us distinguish "LLM couldn't find a URL" from "LLM hallucinated."
  PUSH_URL_EXTRACTOR: 'You are a URL extraction tool.\n\n' +
    'RULES:\n' +
    '1. Extract the webhook/API URL from the user\'s message.\n' +
    '2. Output ONLY the raw URL starting with http:// or https://.\n' +
    '3. No quotes, no backticks, no explanation.\n' +
    '4. If no valid URL is found, output: ERROR_NO_URL'
};

// ============================================
// FORMULA AGENT (generate — the only agent with a real self-correction loop)
// ============================================

var FormulaAgent = {
  // Build the system prompt (context + ambient memory hints) and the
  // Gemini `contents` array from conversation history + the current prompt.
  plan: function (session) {
    session.contextStr = formatContextForPrompt_(session.context);
    // Ranked, token-budgeted context from ContextRetriever.js (other sheets,
    // related tables, formula dependencies). Optional: callers that have none
    // get exactly the active-sheet context they always did.
    if (session.retrievalContext) session.contextStr += '\n\n' + session.retrievalContext;
    // Memory is ambient: agents read it automatically rather than requiring
    // every caller to thread it through (MemoryManager.js's design principle).
    session.memoryHints = MEMORY.buildContextString();
    session.systemPrompt = PROMPTS_.GENERATE(session.contextStr, session.memoryHints);
    session.contents = buildChatContents_(session.chatHistory, session.prompt);
    session.maxRetries = 2;
    return session;
  },

  // One generation attempt. Temperature decays each retry (0.2 -> 0.1 -> 0.0):
  // less creative, more constrained as verification keeps rejecting the output.
  execute: function (session) {
    var temperature = Math.max(0, 0.2 - session.attempt * CONFIG.VERIFICATION.TEMPERATURE_DECAY);
    var response = callGemini_({
      systemInstruction: session.systemPrompt,
      contents: session.contents,
      temperature: temperature,
      agent: 'FormulaAgent'
    });
    session.candidate = { formula: extractTextResponse_(response) };
    session.temperature = temperature;
    return session;
  },

  // Re-execute with the previous attempt's formula + a full structured
  // diagnostic (errors/warnings/hints, escalating to hard column/function
  // constraints on attempt 3) appended as new conversation turns — the LLM
  // sees its own bad output and exactly what was wrong with it.
  retry: function (session) {
    var feedback = buildRetryFeedback_(session.candidate.formula, session.verification, session.attempt + 1, session.context);
    session.contents = session.contents.concat([
      { role: 'model', parts: [{ text: session.candidate.formula }] },
      { role: 'user', parts: [{ text: feedback }] }
    ]);
    logInfo_('FormulaAgent', 'Self-correction attempt ' + session.attempt, { errors: session.verification.errors });
    return this.execute(session);
  },

  verify: function (session) {
    session.verification = verifyFormula_(session.candidate.formula, session.context);
    Observability.verification('FormulaAgent', session.verification);
    return session;
  },

  // Display-only text. Never branched on by anything else in the pipeline.
  explain: function (session) {
    var text = session.candidate.formula;
    if (session.verification.warnings.length > 0) {
      text += '\n\n⚠️ Warnings: ' + session.verification.warnings.join('; ');
    }
    if (!session.verification.valid) {
      text += '\n\n⚠️ Could not fully verify: ' + session.verification.errors.join('; ');
    }
    session.explanation = text;
    return session;
  }
};

// Legacy call shape preserved for Code.js/Planner.js — internally now just
// drives FormulaAgent through the generic loop and reshapes the structured
// session into the { text, formula, verified } object callers expect.
function agentGenerateFormula_(prompt, context, chatHistory, retrievalContext) {
  var session = runAgentLoop_(FormulaAgent, { prompt: prompt, context: context, chatHistory: chatHistory, retrievalContext: retrievalContext || '' });
  if (!session.verification.valid) {
    logWarn_('FormulaAgent', 'Returning unverified formula after retries', { errors: session.verification.errors });
  } else {
    logInfo_('FormulaAgent', 'Formula generated and verified', { attempt: session.attempt, temperature: session.temperature });
  }
  return {
    text: session.explanation,
    formula: session.candidate.formula,
    verified: session.verification.valid
  };
}

// ============================================
// DEBUG AGENT (single-shot — no self-correction loop, see the README's "Agent architecture" section)
// ============================================

var DebugAgent = {
  plan: function (session) {
    session.contextStr = formatContextForPrompt_(session.context);
    session.memoryHints = MEMORY.buildContextString();
    session.systemPrompt = PROMPTS_.DEBUG(session.contextStr, session.memoryHints);
    session.maxRetries = 0;
    return session;
  },

  execute: function (session) {
    var response = callGemini_({
      systemInstruction: session.systemPrompt,
      contents: [{ parts: [{ text: session.brokenFormula }] }],
      temperature: 0.2,
      agent: 'DebugAgent'
    });

    var result = extractTextResponse_(response);
    // The response is "explanation\n=FIXED_FORMULA". Scan from bottom to find the formula.
    var lines = result.split('\n').filter(function (l) { return l.trim(); });
    var fixedFormula = '';
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith('=')) { fixedFormula = lines[i].trim(); break; }
    }

    session.candidate = { explanationText: result, fixedFormula: fixedFormula };
    return session;
  },

  retry: function (session) { return this.execute(session); }, // unused (maxRetries: 0) — kept for interface uniformity

  // Strengthening: verify the extracted fix too, not just accept it blindly.
  verify: function (session) {
    session.verification = session.candidate.fixedFormula
      ? verifyFormula_(session.candidate.fixedFormula, session.context)
      : { valid: true, errors: [], warnings: [], hints: [] };
    Observability.verification('DebugAgent', session.verification);
    return session;
  },

  explain: function (session) {
    session.explanation = session.candidate.explanationText;
    return session;
  }
};

function agentDebugFormula_(brokenFormula, context) {
  var session = runAgentLoop_(DebugAgent, { brokenFormula: brokenFormula, context: context });
  return {
    text: session.explanation,
    formula: session.candidate.fixedFormula,
    isDebug: true,
    verification: session.verification
  };
}

// ============================================
// EXPLANATION AGENT (single-shot, no formula to verify)
// ============================================

var ExplanationAgent = {
  plan: function (session) {
    session.contextStr = formatContextForPrompt_(session.context);
    session.memoryHints = MEMORY.buildContextString();
    session.systemPrompt = PROMPTS_.EXPLAIN(session.contextStr, session.memoryHints);
    session.maxRetries = 0;
    return session;
  },

  execute: function (session) {
    var response = callGemini_({
      systemInstruction: session.systemPrompt,
      contents: [{ parts: [{ text: session.formula }] }],
      temperature: 0.5, // A bit more creative for natural language output
      agent: 'ExplanationAgent'
    });
    session.candidate = { explanationText: extractTextResponse_(response) };
    return session;
  },

  retry: function (session) { return this.execute(session); }, // unused (maxRetries: 0)

  verify: function (session) {
    session.verification = { valid: true, errors: [], warnings: [], hints: [] }; // nothing to structurally verify
    return session;
  },

  explain: function (session) {
    session.explanation = session.candidate.explanationText;
    return session;
  }
};

function agentExplainFormula_(formula, context) {
  var session = runAgentLoop_(ExplanationAgent, { formula: formula, context: context });
  return { text: session.explanation, isExplanation: true };
}

// ============================================
// DATA AGENT (Fetch)
// ============================================
//
// The fetch pipeline is inherently sequential (router call -> fetch -> flatten
// -> shape-check -> write) rather than a single generate/verify/retry
// candidate, so unlike FormulaAgent, its real logic lives in execute() as one
// action; verify() re-checks the shape standalone (useful on its own, e.g.
// for a future Observability view) rather than gating a retry that doesn't
// exist (maxRetries: 0, same as the original design — a failed step throws
// immediately, it doesn't get a second attempt).

var DataAgent = {
  plan: function (session) {
    session.maxRetries = 0;
    return session;
  },

  // Steps 1-4: LLM finds the API URL (JSON mode) -> fetch_api tool call
  // (SSRF validation happens inside its own execute(), gate 3) -> flatten
  // nested JSON into a 2D grid. Does not write yet.
  execute: function (session) {
    logInfo_('DataAgent', 'Starting fetch pipeline', { prompt: session.prompt });

    var routerResponse = callGemini_({
      model: CONFIG.MODELS.FAST,  // Flash is fine for URL discovery
      systemInstruction: PROMPTS_.FETCH_ROUTER,
      contents: [{ parts: [{ text: session.prompt }] }],
      jsonMode: true,
      temperature: 0.1,
      agent: 'DataAgent'
    });

    var routerText = extractTextResponse_(routerResponse);
    var apiConfig;
    try {
      apiConfig = JSON.parse(routerText);
    } catch (e) {
      throw createError_(ErrorType.PARSE_ERROR, 'AI failed to return a valid API route. Try being more specific. Got: ' + routerText);
    }
    if (!apiConfig.url) {
      throw createError_(ErrorType.PARSE_ERROR, 'AI response missing "url" field.');
    }

    var fetchRecord = executeStructuredToolCall_({
      tool_name: 'fetch_api',
      arguments: { url: apiConfig.url },
      verification: function (result) {
        var ok = result.statusCode >= 200 && result.statusCode < 300;
        return { passed: ok, statusCode: result.statusCode };
      }
    });
    if (!fetchRecord.ok) {
      throw createError_(ErrorType.API_ERROR, 'Failed to fetch from ' + apiConfig.url + ': ' + fetchRecord.error);
    }
    if (!fetchRecord.verification.passed) {
      throw createError_(ErrorType.API_ERROR, 'Failed to fetch from ' + apiConfig.url + ': HTTP ' + fetchRecord.result.statusCode);
    }

    session.candidate = { url: apiConfig.url, grid: flattenJsonToGrid_(fetchRecord.result.data) };
    return session;
  },

  retry: function (session) { return this.execute(session); }, // unused (maxRetries: 0)

  // Step 5: shape check. Throws (rather than just flagging invalid) because
  // there is no retry path here to hand a structured failure back to — this
  // matches the original agentFetchData_'s hard-stop behavior exactly.
  verify: function (session) {
    session.verification = verifyDataShape_(session.candidate.grid);
    if (!session.verification.valid) {
      throw createError_(ErrorType.VALIDATION_ERROR, 'Data shape invalid: ' + session.verification.error);
    }
    return session;
  },

  // Step 6: write the grid through the write_cells tool (computes the full
  // destination range from the values array and pushes the undo checkpoint
  // internally), then produce the human-readable summary.
  explain: function (session) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var startCell = sheet.getActiveCell();
    var writeRecord = executeStructuredToolCall_({
      tool_name: 'write_cells',
      arguments: { range: startCell.getA1Notation(), values: session.candidate.grid },
      expected_output: { success: true }
    });
    if (!writeRecord.ok) {
      throw createError_(ErrorType.API_ERROR, 'Failed to write fetched data: ' + writeRecord.error);
    }

    var grid = session.candidate.grid;
    logInfo_('DataAgent', 'Data pipeline complete', { rows: grid.length - 1, source: session.candidate.url });
    session.explanation = '✅ Data Pipeline Success!\n' +
      'Fetched ' + (grid.length - 1) + ' rows × ' + grid[0].length + ' columns\n' +
      'Source: ' + session.candidate.url + '\n' +
      'Inserted at: ' + writeRecord.result.range;
    session.writeRange = writeRecord.result.range;
    return session;
  }
};

function agentFetchData_(prompt, context) {
  var session = runAgentLoop_(DataAgent, { prompt: prompt, context: context });
  return { text: session.explanation, isData: true };
}

// ============================================
// PUSH AGENT (Webhook Sync)
// ============================================
//
// Same shape as DataAgent: sequential rather than generate/verify/retry, so
// the real logic lives in execute(); verify() re-confirms the response
// status standalone. maxRetries: 0 — no self-correction, matching the
// original design.

var PushAgent = {
  // Edge case caught here (not execute()): user selected the header row.
  // Pushing headers as data to a webhook is never what the user wants.
  plan: function (session) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var activeCell = sheet.getActiveCell();
    session.rowIndex = activeCell.getRow();
    var lastCol = sheet.getLastColumn();

    if (session.rowIndex === 1) throw createError_(ErrorType.VALIDATION_ERROR, 'You selected the header row. Click on a data row to push.');
    if (lastCol === 0) throw createError_(ErrorType.VALIDATION_ERROR, 'No data found in this sheet.');

    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var rowData = sheet.getRange(session.rowIndex, 1, 1, lastCol).getValues()[0];
    session.payload = {};
    headers.forEach(function (header, index) { if (header) session.payload[header] = rowData[index]; });

    session.maxRetries = 0;
    return session;
  },

  // Extract the webhook URL from the prompt (handles natural language like
  // "send this to https://webhook.site/abc-123"), then POST through the
  // fetch_api tool (SSRF validation happens inside its own execute(), gate 3).
  execute: function (session) {
    logInfo_('PushAgent', 'Starting push pipeline');

    var urlResponse = callGemini_({
      model: CONFIG.MODELS.FAST,
      systemInstruction: PROMPTS_.PUSH_URL_EXTRACTOR,
      contents: [{ parts: [{ text: session.prompt }] }],
      temperature: 0.0, // Zero temp for exact extraction
      agent: 'PushAgent'
    });

    var targetUrl = extractTextResponse_(urlResponse);
    if (targetUrl === 'ERROR_NO_URL' || !targetUrl.startsWith('http')) {
      throw createError_(ErrorType.PARSE_ERROR, 'Could not find a valid URL in your message. Please include the full webhook URL.');
    }

    var pushRecord = executeStructuredToolCall_({
      tool_name: 'fetch_api',
      arguments: { url: targetUrl, method: 'POST', body: JSON.stringify(session.payload) },
      verification: function (result) {
        var ok = result.statusCode >= 200 && result.statusCode < 300;
        return { passed: ok, statusCode: result.statusCode };
      }
    });
    if (!pushRecord.ok) {
      throw createError_(ErrorType.API_ERROR, pushRecord.error);
    }

    session.candidate = { url: targetUrl, statusCode: pushRecord.result.statusCode, verificationPassed: pushRecord.verification.passed };
    return session;
  },

  retry: function (session) { return this.execute(session); }, // unused (maxRetries: 0)

  verify: function (session) {
    if (!session.candidate.verificationPassed) {
      throw createError_(ErrorType.API_ERROR, 'Webhook rejected the payload. Status: ' + session.candidate.statusCode);
    }
    session.verification = { valid: true, errors: [], warnings: [], hints: [] };
    return session;
  },

  explain: function (session) {
    logInfo_('PushAgent', 'Push successful', { url: session.candidate.url, status: session.candidate.statusCode });
    session.explanation = '🚀 Sync Successful!\n' +
      'Row ' + session.rowIndex + ' pushed to webhook.\n' +
      'Status: ' + session.candidate.statusCode + '\n' +
      'Fields sent: ' + Object.keys(session.payload).join(', ');
    return session;
  }
};

function agentPushData_(prompt, context) {
  var session = runAgentLoop_(PushAgent, { prompt: prompt, context: context });
  return { text: session.explanation, isPush: true };
}

// ============================================
// CHAT HISTORY HELPERS
// ============================================

// Builds the Gemini `contents` array by appending the current prompt to existing history.
// Important to clone the history array so we don't mutate the original.
function buildChatContents_(chatHistory, currentPrompt) {
  var contents = [];
  if (chatHistory && chatHistory.length > 0) {
    contents = chatHistory.slice();
  }
  contents.push({ role: 'user', parts: [{ text: currentPrompt }] });
  return contents;
}

// Load conversation history from PropertiesService (persistent, no TTL).
// V1 used CacheService which expired after 6 hours and silently dropped data at 100KB.
// PropertiesService gives us 500KB and no expiry — much more reliable.
function loadChatHistory_() {
  var props = PropertiesService.getUserProperties();
  var historyJson = props.getProperty(CONFIG.CACHE.HISTORY_KEY);
  if (!historyJson) return [];
  try {
    var history = JSON.parse(historyJson);
    if (history.length > CONFIG.CACHE.MAX_HISTORY_TURNS) {
      history = history.slice(history.length - CONFIG.CACHE.MAX_HISTORY_TURNS);
    }
    return history;
  } catch (e) {
    // Corrupted JSON — nuke it and start fresh. Better than crashing.
    logWarn_('Agents', 'Failed to parse chat history, resetting');
    return [];
  }
}

// Save conversation history. Includes a safety valve: if the serialized JSON is
// approaching the PropertiesService limit (500KB), we trim the oldest half of the history.
// This prevents the silent data loss bug that V1 had with CacheService.
function saveChatHistory_(history) {
  if (history.length > CONFIG.CACHE.MAX_HISTORY_TURNS) {
    history = history.slice(history.length - CONFIG.CACHE.MAX_HISTORY_TURNS);
  }
  try {
    var json = JSON.stringify(history);
    // Leave 100KB headroom for other PropertiesService keys (rate limit, undo, etc.)
    if (json.length > 400000) {
      history = history.slice(Math.floor(history.length / 2));
      json = JSON.stringify(history);
    }
    PropertiesService.getUserProperties().setProperty(CONFIG.CACHE.HISTORY_KEY, json);
  } catch (e) {
    // Non-fatal — worst case the user loses history, not functionality
    logError_('Agents', 'Failed to save chat history: ' + e.message);
  }
}
