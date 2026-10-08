/**
 * Config.js — The single source of truth for every magic string in this project.
 * If you're hardcoding a model name or a TTL somewhere else, you're doing it wrong.
 */

var CONFIG = {
  MODELS: {
    PRIMARY: 'gemini-2.5-pro',     // Complex reasoning: formula gen, debug, explain
    FAST:    'gemini-2.5-flash'    // Classification, routing, planning, extraction
  },
  // Model pricing per 1M tokens (USD). Used by COST_TRACKER.
  MODEL_PRICING: {
    'gemini-2.5-pro':   { input: 1.25, output: 10.00 },
    'gemini-2.5-flash': { input: 0.075, output: 0.30 }
  },
  API: {
    BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/models'
  },
  CACHE: {
    HISTORY_KEY: 'CHAT_HISTORY',
    TTL: 21600,
    MAX_HISTORY_TURNS: 20
  },
  CONTEXT: {
    SAMPLE_ROWS: 5,
    NEARBY_RANGE: 3
  },
  // Verification + retry strategy
  VERIFICATION: {
    MAX_RETRIES: 3,                // Attempts before giving up and returning best result with warning
    BASE_DELAY_MS: 500,            // Between retry attempts (no backoff — we want fast correction)
    TEMPERATURE_DECAY: 0.1,        // Reduce temperature by this each retry (more deterministic)
    HALLUCINATION_THRESHOLD: 0.7,  // Confidence below this = likely hallucination
    // Per-layer switches (all on in production). The evaluation harness turns
    // them off one at a time for the ablation study; nothing else should.
    LAYERS: { structural: true, symbols: true, bounds: true, shape: true, grounding: true, circular: true, query: true },
    // true = a "suspicious" finding (text column fed to SUM, criterion value that
    // never occurs in its column, ...) counts as a failed verification and
    // triggers the repair loop; false = it is shown as a warning only.
    REPAIR_ON_SUSPICIOUS: false
  },
  RETRY: {
    MAX_ATTEMPTS: 3,
    BASE_DELAY_MS: 1000
  },
  RATE_LIMIT: {
    MAX_CALLS_PER_MINUTE: 15,
    COUNTER_KEY: 'RATE_LIMIT_COUNTER',
    WINDOW_KEY: 'RATE_LIMIT_WINDOW'
  },
  // Memory subsystem
  MEMORY: {
    CONVERSATION_TTL_SECONDS: 7200,   // 2-hour session window
    TASK_TTL_SECONDS:         14400,  // 4-hour task window
    MAX_TURNS:                15,     // Compress beyond this
    MAX_TOKENS_BEFORE_COMPRESS: 18000,
    KEEP_RECENT_TURNS:        8       // Keep verbatim after compression
  },
  // Planner
  PLANNER: {
    PLAN_KEY_PREFIX: 'PLAN_',         // UserProperties key prefix
    MAX_STEPS: 10,                    // Safety cap — plans longer than this are rejected
    PLAN_TTL_MS: 30 * 60 * 1000,     // 30 minutes before a pending plan expires
    // Estimated cost per step type (USD)
    STEP_COST: {
      llm_primary:  0.010,
      llm_fast:     0.001,
      tool_read:    0.000,
      tool_write:   0.000,
      tool_external:0.000
    }
  },
  // Enterprise
  ENTERPRISE: {
    UNDO_STACK_KEY:      'ENT_UNDO',
    REDO_STACK_KEY:      'ENT_REDO',
    AUDIT_LOG_KEY:       'ENT_AUDIT',
    EXEC_HISTORY_KEY:    'ENT_HISTORY',
    COST_LOG_KEY:        'ENT_COST',
    DRY_RUN_KEY:         'ENT_DRYRUN',
    MAX_UNDO_LEVELS:     10,
    MAX_AUDIT_EVENTS:    100,
    MAX_HISTORY_PLANS:   20,
    MAX_COST_RECORDS:    50
  }
};

// Error categories — every thrown error gets one of these so the UI can show the right message
// and the retry logic knows which errors to retry vs. which to bail on immediately
var ErrorType = {
  API_ERROR: 'API_ERROR',           // Gemini blew up or returned garbage
  CONTEXT_ERROR: 'CONTEXT_ERROR',   // Couldn't read the spreadsheet (permissions, empty sheet, etc.)
  VALIDATION_ERROR: 'VALIDATION_ERROR', // Formula verification or data shape check failed
  SECURITY_ERROR: 'SECURITY_ERROR',     // SSRF attempt or blocked URL — NEVER retried
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR', // User or Gemini rate limit hit
  PARSE_ERROR: 'PARSE_ERROR'            // LLM returned something we couldn't JSON.parse or make sense of
};

// Typed error factory. We tag errors with a .type property so retryWithBackoff_()
// can decide: retry API errors, but immediately throw on security/validation errors
function createError_(type, message) {
  var err = new Error('[' + type + '] ' + message);
  err.type = type;
  return err;
}

// Structured JSON logging → goes to Stackdriver (GAS's Cloud Logging).
// Every log entry has a timestamp, level, and component name so you can actually
// grep for "[ERROR] [Router]" when something breaks at 2am
function log_(level, component, message, data) {
  var entry = {
    timestamp: new Date().toISOString(),
    level: level,
    component: component,
    message: message
  };
  if (data) entry.data = data;
  console.log(JSON.stringify(entry));
}

// Convenience wrappers — because typing log_('INFO', ...) every time gets old fast
function logInfo_(component, message, data) { log_('INFO', component, message, data); }
function logError_(component, message, data) { log_('ERROR', component, message, data); }
function logWarn_(component, message, data) { log_('WARN', component, message, data); }
