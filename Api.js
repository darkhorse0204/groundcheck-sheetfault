/**
 * Api.js — The Gemini API Client
 *
 * Every LLM call in the entire project goes through callGemini_(). No exceptions.
 * This gives us one place to handle retries, rate limits, JSON mode, function calling,
 * and temperature — instead of copy-pasting fetch boilerplate in 5 different functions
 * like V1 did.
 *
 * Supports: retry with exponential backoff, structured JSON output, Gemini function
 * calling (for the Router Agent), per-user rate limiting, and temperature control.
 */

// Pull the API key from Script Properties. We never hardcode it.
// If someone forks this and forgets to set it, they get a clear error immediately.
function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw createError_(ErrorType.API_ERROR, 'GEMINI_API_KEY not found in Script Properties. Set it via File > Project Properties.');
  return key;
}

/**
 * The unified Gemini call. Everything flows through here.
 *
 * Key options:
 *   model           - 'gemini-2.5-pro' or 'gemini-2.5-flash' (defaults to Pro)
 *   systemInstruction - the system prompt (includes context + few-shot examples)
 *   contents        - conversation history + current prompt
 *   tools           - function declarations (used by Router Agent)
 *   forceFunctionCall - set to true to make Gemini ALWAYS return a function call
 *   jsonMode        - set to true for structured JSON output (used by Fetch Agent)
 *   temperature     - 0.0-1.0 (low = deterministic, high = creative)
 */
function callGemini_(options) {
  // Gate: check rate limit BEFORE spending any compute
  checkRateLimit_();

  var apiKey = getApiKey_();
  var model = options.model || CONFIG.MODELS.PRIMARY;
  var url = CONFIG.API.BASE_URL + '/' + model + ':generateContent?key=' + apiKey;

  // Build the payload piece by piece. Only include fields that were requested.
  var payload = { contents: options.contents };

  if (options.systemInstruction) {
    payload.system_instruction = { parts: { text: options.systemInstruction } };
  }

  // Function calling — used by the Router Agent to classify intent
  if (options.tools) {
    payload.tools = options.tools;
    if (options.forceFunctionCall) {
      // mode: 'ANY' forces Gemini to pick one of our declared functions
      // instead of responding with free text. Critical for reliable routing.
      payload.tool_config = { function_calling_config: { mode: 'ANY' } };
    }
  }

  // JSON mode — makes Gemini return valid JSON instead of markdown-wrapped text.
  // Eliminates the entire class of "LLM returned ```json ... ```" parsing bugs from V1
  if (options.jsonMode) {
    payload.generationConfig = payload.generationConfig || {};
    payload.generationConfig.response_mime_type = 'application/json';
    if (options.responseSchema) {
      payload.generationConfig.response_schema = options.responseSchema;
    }
  }

  // Temperature: formula gen uses 0.2 (precise), explain uses 0.5 (natural), routing uses 0.1 (deterministic)
  if (options.temperature !== undefined) {
    payload.generationConfig = payload.generationConfig || {};
    payload.generationConfig.temperature = options.temperature;
  }

  var fetchOptions = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true  // We handle error codes ourselves
  };

  logInfo_('API', 'Calling Gemini', { model: model, jsonMode: !!options.jsonMode, hasTools: !!options.tools });

  var callStart = Date.now();
  Observability.prompt(options.agent, options.systemInstruction, extractLastUserText_(options.contents));

  // Wrap the actual fetch in retry logic
  return retryWithBackoff_(function() {
    var response = UrlFetchApp.fetch(url, fetchOptions);
    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());

    // 429 = Gemini's rate limit. Retry will handle the backoff.
    if (code === 429) {
      throw createError_(ErrorType.RATE_LIMIT_ERROR, 'Rate limited by Gemini. Please wait a moment and try again.');
    }
    // 5xx = Gemini is having a bad day. Retry is usually worth it.
    if (code >= 500) {
      throw createError_(ErrorType.API_ERROR, 'Gemini server error (' + code + '). Retrying...');
    }
    // Anything else non-200 is a hard error (bad request, auth failure, etc.)
    if (code !== 200) {
      var errMsg = (body.error && body.error.message) ? body.error.message : 'Gemini API error: ' + code;
      throw createError_(ErrorType.API_ERROR, errMsg);
    }

    // Only count successful calls against the rate limit
    incrementRateCounter_();

    // Track token usage + cost. usageMetadata is provided by the real Gemini
    // API; default to 0 defensively in case a caller's mock omits it.
    var usage = body.usageMetadata || {};
    var inputTokens = usage.promptTokenCount || 0;
    var outputTokens = usage.candidatesTokenCount || 0;
    ENTERPRISE.cost.record(model, inputTokens, outputTokens, options.agent || 'unknown');

    var pricing = CONFIG.MODEL_PRICING[model] || { input: 0.001, output: 0.003 };
    var costUsd = (inputTokens / 1e6 * pricing.input) + (outputTokens / 1e6 * pricing.output);
    Observability.cost(costUsd, inputTokens + outputTokens);
    Observability.agentCall(options.agent || 'unknown', model, Date.now() - callStart);

    return body;
  });
}

/** Best-effort extraction of the most recent user-role text, for the Observability Prompt Viewer. */
function extractLastUserText_(contents) {
  if (!contents || contents.length === 0) return '';
  var last = contents[contents.length - 1];
  if (!last.parts) return '';
  return last.parts.map(function (p) { return p.text || ''; }).join(' ');
}

// Pull the text out of a Gemini response and strip any markdown code fences.
// Gemini loves wrapping formulas in ```formula ... ``` even when told not to.
// The cleanMarkdownFencing_ call handles that consistently.
function extractTextResponse_(apiResponse) {
  if (!apiResponse.candidates || !apiResponse.candidates[0]) {
    throw createError_(ErrorType.API_ERROR, 'No response generated by Gemini.');
  }
  var parts = apiResponse.candidates[0].content.parts;
  var text = parts.map(function(p) { return p.text || ''; }).join('').trim();
  return cleanMarkdownFencing_(text);
}

// Pull the function call out of a Gemini response (used by the Router Agent).
// Returns null if Gemini responded with text instead of a function call.
function extractFunctionCall_(apiResponse) {
  if (!apiResponse.candidates || !apiResponse.candidates[0]) return null;
  var parts = apiResponse.candidates[0].content.parts;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].functionCall) return parts[i].functionCall;
  }
  return null;
}

// Gemini wraps output in ```json ... ``` or ```formula ... ``` even when you explicitly
// tell it not to. This is a known behavior. Strip it consistently here.
function cleanMarkdownFencing_(text) {
  return text.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
}

// Exponential backoff: 1s → 2s → 4s. Retries transient errors (429, 5xx).
// Immediately throws on validation and security errors — those won't get better with retrying.
function retryWithBackoff_(fn) {
  var lastError;
  for (var attempt = 0; attempt < CONFIG.RETRY.MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      // Security errors (SSRF) and validation errors should NEVER be retried
      if (e.type === ErrorType.VALIDATION_ERROR || e.type === ErrorType.SECURITY_ERROR) throw e;
      if (attempt < CONFIG.RETRY.MAX_ATTEMPTS - 1) {
        var delay = CONFIG.RETRY.BASE_DELAY_MS * Math.pow(2, attempt);
        logWarn_('API', 'Retry attempt ' + (attempt + 1) + ' after ' + delay + 'ms', { error: e.message });
        Utilities.sleep(delay);
      }
    }
  }
  throw lastError;
}

// Simple sliding-window rate limiter using PropertiesService.
// Tracks calls per user per minute. If the 60-second window expired, reset.
// This is coarse but effective for preventing runaway loops from burning API credits.
// NOTE: Not atomic — two simultaneous requests could both pass the check. Acceptable for GAS.
function checkRateLimit_() {
  var props = PropertiesService.getUserProperties();
  var windowStart = parseInt(props.getProperty(CONFIG.RATE_LIMIT.WINDOW_KEY) || '0');
  var counter = parseInt(props.getProperty(CONFIG.RATE_LIMIT.COUNTER_KEY) || '0');
  var now = Date.now();

  if (now - windowStart > 60000) {
    // Window expired, reset
    props.setProperty(CONFIG.RATE_LIMIT.WINDOW_KEY, String(now));
    props.setProperty(CONFIG.RATE_LIMIT.COUNTER_KEY, '0');
    return;
  }

  if (counter >= CONFIG.RATE_LIMIT.MAX_CALLS_PER_MINUTE) {
    throw createError_(ErrorType.RATE_LIMIT_ERROR, 'Rate limit exceeded. Please wait before making more requests.');
  }
}

// Bump the counter after a successful API call
function incrementRateCounter_() {
  var props = PropertiesService.getUserProperties();
  var counter = parseInt(props.getProperty(CONFIG.RATE_LIMIT.COUNTER_KEY) || '0');
  props.setProperty(CONFIG.RATE_LIMIT.COUNTER_KEY, String(counter + 1));
}
