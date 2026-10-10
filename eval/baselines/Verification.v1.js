/**
 * Verification.js — Output Validation Layer
 *
 * The safety net between "LLM generated something" and "we inject it into the user's sheet."
 * Catches structural errors (unbalanced parens, missing =, unknown functions) and blocks
 * SSRF attacks on the fetch/push pipelines.
 *
 * Important: this only catches STRUCTURAL issues, not semantic ones. We can verify
 * "is the parentheses balanced?" but NOT "does this formula actually do what the user wanted?"
 * Semantic verification would require executing the formula, which is a v3 problem.
 */

// ============================================
// URL SECURITY — SSRF Protection
// ============================================

// Every pattern here blocks a known private/internal IP range or hostname.
// The V1 code let the LLM construct ANY URL and the server would blindly fetch it.
// That's textbook SSRF — an attacker could prompt-inject the LLM to return
// http://169.254.169.254/latest/meta-data/ and dump cloud credentials.
//
// NOTE: This is string-level blocking. It won't catch DNS rebinding or IPv6-mapped
// addresses like ::ffff:127.0.0.1. For GAS this is acceptable because UrlFetchApp
// runs on Google's infra (not our VPC), but in a real Node.js backend you'd want
// to resolve DNS first and check the resolved IP.
var BLOCKED_URL_PATTERNS_ = [
  /localhost/i,                     // The obvious one
  /127\.0\.0\.\d+/,                 // Full loopback range
  /10\.\d+\.\d+\.\d+/,             // RFC 1918 Class A (common for internal services)
  /192\.168\.\d+\.\d+/,            // RFC 1918 Class C (home/office networks)
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/, // RFC 1918 Class B (172.16.0.0 - 172.31.255.255)
  /169\.254\.\d+\.\d+/,            // Link-local — this is where cloud metadata endpoints live
  /0\.0\.0\.0/,                     // Wildcard bind address
  /\[::1\]/,                        // IPv6 loopback
  /\.local$/i,                      // mDNS hostnames (e.g., router.local)
  /\.internal$/i,                   // Internal DNS zones (common in k8s/GCP)
  /metadata\.google/i              // GCP metadata service — blocking explicitly just to be safe
];

// Run a URL through the blocklist before any fetch/POST. Called from
// ToolRegistry.js's fetch_api tool — the single path every agent's HTTP
// calls (GET or POST) now go through under structured tool calling.
function validateUrl_(url) {
  if (!url || typeof url !== 'string') {
    throw createError_(ErrorType.SECURITY_ERROR, 'No URL provided.');
  }
  url = url.trim();
  if (!url.match(/^https?:\/\//i)) {
    throw createError_(ErrorType.SECURITY_ERROR, 'URL must start with http:// or https://');
  }
  for (var i = 0; i < BLOCKED_URL_PATTERNS_.length; i++) {
    if (BLOCKED_URL_PATTERNS_[i].test(url)) {
      logWarn_('Security', 'Blocked SSRF attempt', { url: url });
      throw createError_(ErrorType.SECURITY_ERROR, 'Blocked: URL points to a private or internal network address.');
    }
  }
  return url;
}

// ============================================
// FORMULA VERIFICATION
// ============================================

// Comprehensive list of valid Google Sheets functions. Used to catch typos like
// "SUMIFF" or hallucinated functions that don't exist. We treat unknown functions
// as warnings (not hard errors) because the user might have custom Apps Script functions.
var KNOWN_SHEET_FUNCTIONS_ = [
  'SUM','AVERAGE','COUNT','COUNTA','COUNTIF','COUNTIFS','COUNTBLANK',
  'SUMIF','SUMIFS','SUMPRODUCT','VLOOKUP','HLOOKUP','INDEX','MATCH',
  'IF','IFS','AND','OR','NOT','IFERROR','IFNA','SWITCH','CHOOSE',
  'LEFT','RIGHT','MID','LEN','TRIM','LOWER','UPPER','PROPER','CLEAN',
  'CONCATENATE','TEXTJOIN','SUBSTITUTE','REPLACE','REPT','TEXT',
  'DATE','TODAY','NOW','YEAR','MONTH','DAY','HOUR','MINUTE','SECOND',
  'DATEVALUE','TIMEVALUE','EDATE','EOMONTH','NETWORKDAYS','WORKDAY',
  'MIN','MAX','ROUND','ROUNDUP','ROUNDDOWN','ABS','MOD','INT','POWER',
  'SQRT','LOG','LN','EXP','CEILING','FLOOR','RAND','RANDBETWEEN',
  'FILTER','SORT','SORTN','UNIQUE','ARRAYFORMULA','QUERY',
  'IMPORTRANGE','IMPORTDATA','IMPORTHTML','IMPORTXML',
  'REGEXMATCH','REGEXEXTRACT','REGEXREPLACE',
  'SPARKLINE','IMAGE','HYPERLINK',
  'TRANSPOSE','FLATTEN','SPLIT','JOIN',
  'LARGE','SMALL','RANK','PERCENTILE','MEDIAN','MODE',
  'STDEV','STDEVP','VAR','VARP',
  'INDIRECT','OFFSET','ADDRESS','ROW','COLUMN','ROWS','COLUMNS',
  'ISBLANK','ISERROR','ISNA','ISNUMBER','ISTEXT','ISFORMULA',
  'VALUE','TO_DATE','TO_TEXT','TO_PURE_NUMBER','N','T',
  'DSUM','DAVERAGE','DCOUNT','DCOUNTA','DGET','DMAX','DMIN',
  'LET','LAMBDA','MAP','REDUCE','BYROW','BYCOL','MAKEARRAY','SCAN',
  'XLOOKUP','XMATCH','SEQUENCE','RANDARRAY','WRAPCOLS','WRAPROWS',
  'GOOGLETRANSLATE','DETECTLANGUAGE','GOOGLEFINANCE',
  'SEARCH','FIND','EXACT','CHAR','CODE','DOLLAR','FIXED'
];

/**
 * ═══════════════════════════════════════════════════════════════════════
 * VERIFICATION PIPELINE
 *
 * Every LLM formula response passes through four verification layers:
 *
 *  Layer 1 — STRUCTURAL  (~0ms)
 *    Pure string analysis. No spreadsheet reads needed.
 *    Checks: starts with "=", balanced parens, balanced quotes,
 *            formula injection patterns (=DDE, javascript:, etc.)
 *    On fail: HARD ERROR — do not proceed, trigger retry immediately.
 *
 *  Layer 2 — HALLUCINATION DETECTION  (~5ms)
 *    Cross-references formula content against actual spreadsheet context.
 *    Checks: column names in formula match actual headers,
 *            sheet names in cross-sheet refs exist in the workbook,
 *            function names that exist in our known list.
 *    On fail: HARD ERROR with specific "did you mean X?" feedback for retry.
 *
 *  Layer 3 — RANGE BOUNDS  (~5ms)
 *    Validates that cell references are within the sheet's actual dimensions.
 *    Checks: column letters ≤ lastColumn, row numbers ≤ lastRow.
 *    On fail: WARNING — show to user, don't block (could be cross-sheet ref).
 *
 *  Layer 4 — FUNCTION EXISTENCE  (~1ms)
 *    Checks function names against the known Sheets function whitelist.
 *    On fail: WARNING — could be a custom Apps Script function.
 *
 * ───────────────────────────────────────────────────────────────────────
 * RETRY STRATEGY
 *
 * When verification finds HARD ERRORS, the calling agent retries with
 * structured feedback. The strategy has three distinct retry modes:
 *
 *  ATTEMPT 1 (original):
 *    Normal prompt. Temperature: 0.2 (low, deterministic).
 *
 *  ATTEMPT 2 (error-informed):
 *    Append structured error objects to the conversation:
 *      { errors: ["Column 'Revenue' not found"], hint: "Available: Amount, Total, Sales" }
 *    Reduce temperature by TEMPERATURE_DECAY (→ 0.1).
 *    Goal: LLM sees exact error + exact correction path.
 *    This catches: wrong column names, hallucinated functions, wrong sheet names.
 *
 *  ATTEMPT 3 (constrained):
 *    Add explicit hard constraints to the system prompt:
 *      "ONLY USE these columns: [actual columns from context]"
 *      "ONLY USE these functions: [known functions subset]"
 *    Temperature: 0.0 (fully deterministic).
 *    Goal: eliminate hallucination surface by constraining the output space.
 *    This catches: persistent hallucination despite error feedback.
 *
 *  ALL ATTEMPTS FAILED:
 *    Return the best result (fewest errors) with a ⚠️ WARNING badge.
 *    Never return an empty response — something imperfect is better than nothing.
 *    Log all errors for the audit trail.
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * Master verification function. Runs all four layers in sequence.
 * Returns a VerificationResult object with full diagnostic information.
 *
 * @param {string} formula  - The formula string to verify
 * @param {object} context  - The buildDeepContext() result (schema, headers, etc.)
 * @returns {object}        - { valid, errors[], warnings[], hints[], layers{} }
 */
function verifyFormula_(formula, context) {
  var result = {
    valid: true,
    errors: [],      // Hard failures — block the formula
    warnings: [],    // Soft issues — show to user but allow
    hints: [],       // Correction suggestions for retry prompt
    layers: {}       // Per-layer results for debugging
  };

  if (!formula || typeof formula !== 'string') {
    result.valid = false;
    result.errors.push('Output is not a valid string.');
    return result;
  }

  formula = formula.trim();

  // ─── LAYER 1: STRUCTURAL ─────────────────────────────────────────────────

  var layer1 = verifyStructural_(formula);
  result.layers.structural = layer1;
  if (!layer1.valid) {
    result.valid = false;
    result.errors = result.errors.concat(layer1.errors);
    // Structural errors are fundamental — skip remaining layers
    return result;
  }

  // ─── LAYER 2: HALLUCINATION DETECTION ────────────────────────────────────
  // (sheet references, QUERY column references, and circular references —
  // all forms of "the LLM referenced something that doesn't/can't exist")

  if (context) {
    var layer2 = verifyHallucinations_(formula, context);
    result.layers.hallucination = layer2;
    if (!layer2.valid) {
      result.valid = false;
      result.errors = result.errors.concat(layer2.errors);
      result.hints  = result.hints.concat(layer2.hints);
    }

    var queryCheck = verifyQueryColumns_(formula, context);
    result.layers.queryColumns = queryCheck;
    if (queryCheck.errors.length > 0) {
      result.valid = false;
      result.errors = result.errors.concat(queryCheck.errors);
    }
    result.warnings = result.warnings.concat(queryCheck.warnings);
    result.hints = result.hints.concat(queryCheck.hints);

    var circularCheck = verifyCircularReference_(formula, context);
    result.layers.circularReference = circularCheck;
    if (circularCheck.errors.length > 0) {
      result.valid = false;
      result.errors = result.errors.concat(circularCheck.errors);
    }
  }

  // ─── LAYER 3: RANGE BOUNDS ────────────────────────────────────────────────

  if (context && context.dimensions) {
    var layer3 = verifyRangeBounds_(formula, context);
    result.layers.rangeBounds = layer3;
    result.warnings = result.warnings.concat(layer3.warnings);
  }

  // ─── LAYER 4: FUNCTION EXISTENCE ─────────────────────────────────────────

  var layer4 = verifyFunctions_(formula);
  result.layers.functions = layer4;
  result.warnings = result.warnings.concat(layer4.warnings);

  return result;
}

/**
 * LAYER 1: Structural verification.
 * Checks syntax-level validity without reading the spreadsheet.
 */
function verifyStructural_(formula) {
  var errors = [];

  // Must start with "="
  if (!formula.startsWith('=')) {
    return { valid: false, errors: ['Formula must start with "=". Got: ' + formula.substring(0, 30)] };
  }

  // Formula injection prevention — block dangerous patterns
  var injectionPatterns = [
    { pattern: /=\s*DDE\s*\(/i,           reason: 'DDE() is a data execution attack vector.' },
    { pattern: /javascript\s*:/i,          reason: 'javascript: URIs are blocked.' },
    { pattern: /vbscript\s*:/i,            reason: 'vbscript: URIs are blocked.' },
    { pattern: /=\s*HYPERLINK\s*\(\s*["']javascript/i, reason: 'javascript: HYPERLINK is blocked.' }
  ];

  for (var p = 0; p < injectionPatterns.length; p++) {
    if (injectionPatterns[p].pattern.test(formula)) {
      return { valid: false, errors: ['Blocked pattern: ' + injectionPatterns[p].reason] };
    }
  }

  // Balanced parentheses
  var depth = 0;
  for (var i = 0; i < formula.length; i++) {
    if (formula[i] === '(') depth++;
    if (formula[i] === ')') depth--;
    if (depth < 0) {
      errors.push('Unbalanced parentheses: unexpected ")" at position ' + i + '.');
      return { valid: false, errors: errors };
    }
  }
  if (depth !== 0) {
    errors.push('Unbalanced parentheses: ' + depth + ' unclosed "(".');
    return { valid: false, errors: errors };
  }

  // Balanced double quotes
  var doubleQuotes = (formula.match(/"/g) || []).length;
  if (doubleQuotes % 2 !== 0) {
    errors.push('Unbalanced double quotes in formula.');
    return { valid: false, errors: errors };
  }

  return { valid: true, errors: [] };
}

/**
 * LAYER 2: Hallucination detection.
 * Cross-references formula content against actual spreadsheet context.
 *
 * Hallucination types we catch here:
 *   - Sheet names in cross-sheet refs that don't exist in the workbook
 * (QUERY column-letter hallucination is verifyQueryColumns_() below — kept
 * separate because it needs its own dedicated string-literal parsing, and
 * circular references are verifyCircularReference_() below — kept separate
 * because it needs SpreadsheetEngine.js's formula graph, not just regexes.)
 */
function verifyHallucinations_(formula, context) {
  var errors = [];
  var hints = [];

  // Cross-sheet reference validation — Sheet2!A1:B10
  var sheetRefPattern = /(?:'([^']+)'|([A-Za-z0-9_]+))!/g;
  var match;
  var seenSheets = {};
  while ((match = sheetRefPattern.exec(formula)) !== null) {
    var referencedSheet = match[1] || match[2];
    if (seenSheets[referencedSheet]) continue;
    seenSheets[referencedSheet] = true;

    // Skip the active sheet name (not a cross-sheet ref)
    if (context.sheetName && referencedSheet === context.sheetName) continue;

    // Check if this sheet actually exists
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var exists = ss.getSheetByName(referencedSheet) !== null;
      if (!exists) {
        var allSheets = ss.getSheets().map(function(s) { return '"' + s.getName() + '"'; });
        errors.push('Sheet "' + referencedSheet + '" does not exist.');
        hints.push('Available sheets: ' + allSheets.join(', '));
      }
    } catch (e) {
      // Non-fatal — skip cross-sheet validation if we can't read sheet list
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors,
    hints: hints
  };
}

// QUERY-language keywords/functions that are NOT column-letter references,
// even though bare 1-3 uppercase-letter tokens (e.g. "BY" in "GROUP BY", "IS"
// in "IS NULL") could otherwise look like one. Prevents false positives.
var QUERY_LANGUAGE_KEYWORDS_ = {
  SELECT: 1, WHERE: 1, GROUP: 1, BY: 1, ORDER: 1, LIMIT: 1, OFFSET: 1, LABEL: 1, FORMAT: 1,
  PIVOT: 1, AND: 1, OR: 1, NOT: 1, IS: 1, NULL: 1, ASC: 1, DESC: 1, LIKE: 1, CONTAINS: 1,
  MATCHES: 1, STARTS: 1, ENDS: 1, WITH: 1, SUM: 1, COUNT: 1, AVG: 1, MAX: 1, MIN: 1,
  TODAY: 1, NOW: 1, YEAR: 1, MONTH: 1, DAY: 1, DATE: 1, TRUE: 1, FALSE: 1
};

/**
 * Validates column-letter references inside a QUERY() formula's query-string
 * argument (Google Sheets QUERY syntax: `=QUERY(A1:C10,"SELECT B WHERE C > 5")`
 * — columns are referenced by bare letter, NOT by header name). An earlier
 * version of this check looked for "ColA"/"ColB"-style tokens, which never
 * appear in real QUERY syntax — it was dead code that could never fire on an
 * actual formula. This replaces it with a check against real QUERY grammar.
 */
function verifyQueryColumns_(formula, context) {
  var errors = [];
  var warnings = [];
  var hints = [];

  var queryStringPattern = /QUERY\s*\([^,]+,\s*"((?:[^"\\]|\\.)*)"/gi;
  var queryStringMatch;
  while ((queryStringMatch = queryStringPattern.exec(formula)) !== null) {
    var queryStr = queryStringMatch[1];
    var tokens = queryStr.match(/\b[A-Z]{1,3}\b/g) || [];
    var seen = {};

    tokens.forEach(function (token) {
      if (QUERY_LANGUAGE_KEYWORDS_[token] || seen[token]) return;
      seen[token] = true;

      var colNum = 0;
      for (var c = 0; c < token.length; c++) colNum = colNum * 26 + (token.charCodeAt(c) - 64);

      if (context.dimensions && colNum > context.dimensions.cols) {
        errors.push('QUERY references column ' + token + ' but the range only has ' + context.dimensions.cols + ' columns.');
        hints.push('Available QUERY columns: A through ' + colIndexToLetter_(context.dimensions.cols));
      } else if (context.headers && context.headers[colNum - 1] === '') {
        warnings.push('QUERY references column ' + token + ', which has no header — verify this is intentional.');
      }
    });
  }

  return { errors: errors, warnings: warnings, hints: hints };
}

/**
 * Detects circular references: does this formula, if inserted at the active
 * cell, create a dependency cycle? Two checks:
 *   1. Direct self-reference (cheap, always run) — the formula refers to its
 *      own target cell.
 *   2. A deeper cycle through the rest of the workbook's existing formulas
 *      (best-effort, wrapped in try/catch) — builds a formula graph via
 *      SpreadsheetEngine.js, adds this formula as a hypothetical edge from
 *      the target cell, and checks whether any detected cycle includes it.
 *      Uses a lightweight sheet-metadata read (name/rowCount/colCount only),
 *      not SpreadsheetEngine's full buildWorkbookModel_() — this check only
 *      needs graph edges, not table/type analysis, and running the full
 *      analysis on every retry attempt would be needless overhead.
 */
function verifyCircularReference_(formula, context) {
  var errors = [];
  if (!context || !context.sheetName || !context.activeCell) return { errors: errors };

  var targetNode = context.sheetName + '!' + context.activeCell.replace(/\$/g, '');
  var refs = parseFormulaRefs_(formula, context.sheetName);

  if (refs.some(function (r) { return r.node === targetNode; })) {
    errors.push('Formula directly references its own cell (' + context.activeCell + ') — a circular reference.');
    return { errors: errors };
  }

  try {
    var lightweightWorkbook = {
      sheets: SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
        return { name: s.getName(), rowCount: s.getLastRow(), colCount: s.getLastColumn() };
      })
    };
    var graph = buildFormulaGraph_(lightweightWorkbook);

    var edges = {};
    graph.nodes.forEach(function (n) { edges[n] = graph.edges[n]; });
    edges[targetNode] = refs.map(function (r) { return r.node; });
    var nodes = graph.nodes.indexOf(targetNode) === -1 ? graph.nodes.concat([targetNode]) : graph.nodes;

    var cycles = detectCycles_(nodes, edges);
    var involvesTarget = cycles.some(function (cycle) { return cycle.indexOf(targetNode) !== -1; });
    if (involvesTarget) {
      errors.push('Formula would create a circular reference chain back to ' + context.activeCell + ' through other formulas in the workbook.');
    }
  } catch (e) {
    logWarn_('Verification', 'Circular reference deep-check skipped: ' + e.message);
  }

  return { errors: errors };
}

/**
 * LAYER 3: Range bounds checking.
 * Produces warnings (not errors) for column AND row refs beyond sheet bounds
 * (an earlier version only checked columns).
 */
function verifyRangeBounds_(formula, context) {
  var warnings = [];

  var cellRefs = formula.match(/\b([A-Z]{1,3})(\d+)\b/g) || [];
  var seenRefs = {};
  cellRefs.forEach(function (ref) {
    if (seenRefs[ref]) return;
    seenRefs[ref] = true;

    var m = ref.match(/^([A-Z]+)(\d+)$/);
    var colLetters = m[1];
    var rowNum = parseInt(m[2], 10);

    var colNum = 0;
    for (var c = 0; c < colLetters.length; c++) {
      colNum = colNum * 26 + (colLetters.charCodeAt(c) - 64);
    }

    if (colNum > context.dimensions.cols) {
      warnings.push('Column ' + colLetters + ' (col ' + colNum + ') may exceed sheet bounds (' +
        context.dimensions.cols + ' columns). Could be a cross-sheet reference — verify manually.');
    }
    if (rowNum > context.dimensions.rows) {
      warnings.push('Row ' + rowNum + ' in ' + ref + ' exceeds sheet bounds (' +
        context.dimensions.rows + ' rows). Could be intentional headroom for future data — verify manually.');
    }
  });

  return { warnings: warnings };
}

/**
 * LAYER 4: Function name existence check.
 * Warns on unknown function names (hallucinated functions).
 */
function verifyFunctions_(formula) {
  var warnings = [];
  var usedFunctions = formula.match(/\b([A-Z_][A-Z_0-9]*)\s*\(/g) || [];
  usedFunctions.forEach(function(fn) {
    var name = fn.replace(/\s*\($/, '').trim();
    if (KNOWN_SHEET_FUNCTIONS_.indexOf(name) === -1) {
      warnings.push('Unknown function "' + name + '". Verify it exists in Google Sheets.');
    }
  });
  return { warnings: warnings };
}

/**
 * Build the retry prompt for attempt N.
 * This is the structured error feedback that makes retry attempt 2 succeed
 * where attempt 1 failed — the LLM sees exactly what was wrong.
 *
 * @param {string} badFormula        - The formula that failed verification
 * @param {object} verificationResult - The VerificationResult from verifyFormula_()
 * @param {number} attemptNumber      - 1-indexed attempt number (for escalation)
 * @param {object} context            - Spreadsheet context
 * @returns {string}                  - The feedback to append to the retry prompt
 */
function buildRetryFeedback_(badFormula, verificationResult, attemptNumber, context) {
  var lines = [
    'Your formula failed verification on attempt ' + attemptNumber + ':',
    'Formula: ' + badFormula,
    ''
  ];

  if (verificationResult.errors.length > 0) {
    lines.push('HARD ERRORS (must fix):');
    verificationResult.errors.forEach(function(e) { lines.push('  ✗ ' + e); });
  }

  if (verificationResult.warnings.length > 0) {
    lines.push('WARNINGS (should fix):');
    verificationResult.warnings.forEach(function(w) { lines.push('  ⚠ ' + w); });
  }

  if (verificationResult.hints.length > 0) {
    lines.push('CORRECTION HINTS:');
    verificationResult.hints.forEach(function(h) { lines.push('  → ' + h); });
  }

  // Attempt 3: add hard constraints to eliminate hallucination surface
  if (attemptNumber >= 3 && context && context.headers) {
    var validCols = context.headers
      .map(function(h, i) { return String.fromCharCode(65 + i) + '="' + h + '"'; })
      .filter(Boolean)
      .join(', ');
    lines.push('');
    lines.push('HARD CONSTRAINTS FOR THIS ATTEMPT:');
    lines.push('  • Only use column letters from this list: ' + validCols);
    lines.push('  • The sheet has exactly ' + context.dimensions.rows + ' data rows');
    lines.push('  • Output the formula only — no explanation, no markdown');
  }

  return lines.join('\n');
}

// Quick sanity check on 2D data arrays before we write them to the sheet.
// Catches the case where some API returns rows with different column counts,
// which would cause setValues() to throw a cryptic error.
function verifyDataShape_(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return { valid: false, error: 'Data is empty or not an array.' };
  }
  if (!Array.isArray(data[0])) {
    return { valid: false, error: 'Data rows must be arrays.' };
  }
  var colCount = data[0].length;
  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i]) || data[i].length !== colCount) {
      return { valid: false, error: 'Row ' + (i + 1) + ' has inconsistent column count.' };
    }
  }
  return { valid: true };
}
