/**
 * ContextRetriever.js — Relevance-Ranked Context Selection
 *
 * Chooses which parts of the workbook (as modeled by SpreadsheetEngine.js)
 * are worth spending prompt tokens on for a given request, instead of always
 * dumping the whole active sheet into every system prompt. Ranks
 * SpreadsheetEngine's embedding-ready chunks by seven signals, then greedily
 * fills a token budget with the highest-scoring chunks — minimizing tokens
 * spent while maximizing how useful what IS sent actually is.
 *
 * Ranking signals (see scoreChunk_):
 *   1. Active sheet       — chunk belongs to the sheet the user is looking at
 *   2. Referenced formulas — chunk's cells are read by / feed into the active cell
 *   3. Semantic similarity — lexical overlap between the user's prompt and chunk text
 *      (NOT a real embedding model — no Gemini/network call happens here, matching
 *      SpreadsheetEngine.js's "pure deterministic analysis only" constraint. This is
 *      a deterministic stand-in a future component could swap for real embedding
 *      similarity computed over SpreadsheetEngine's embeddingChunks without changing
 *      this file's scoring/selection logic.)
 *   4. Shared headers     — chunk's column headers overlap the active table's headers
 *      or headers mentioned directly in the prompt
 *   5. Neighboring tables — chunk's table sits next to the active table on the same sheet
 *   6. Dependency graph    — chunk's cells are graph-close to the active cell (either direction)
 *   7. Previous conversation — chunk's terms overlap recent conversation turns
 *
 * Design: same pure-function/thin-wrapper split as SpreadsheetEngine.js — the
 * scoring and selection algorithm takes plain data (a model, a prompt string,
 * conversation text) and has no SpreadsheetApp/MEMORY calls at all. Only the
 * top-level retrieveContext_() wrapper reads live state.
 */

var CONTEXT_RETRIEVER_CONFIG_ = {
  MAX_CONTEXT_TOKENS: 1500,       // Default token budget for selected context
  DEPENDENCY_MAX_HOPS: 3,         // How far to search the formula graph for signal 6
  NEIGHBOR_GAP_CELLS: 2,          // How close two tables' bands must be to count as "neighboring"
  WEIGHTS: {
    activeSheet: 3,
    referencedFormulas: 5,
    semanticSimilarity: 4,
    sharedHeaders: 2,
    neighboringTables: 1.5,
    dependencyGraph: 3,
    previousConversation: 1
  }
};

// ============================================
// TEXT / TOKEN HELPERS (pure)
// ============================================

var STOPWORDS_ = { 'the': 1, 'a': 1, 'an': 1, 'of': 1, 'in': 1, 'on': 1, 'for': 1, 'to': 1, 'and': 1, 'is': 1, 'this': 1, 'that': 1, 'with': 1 };

/** Pure: lowercase word tokens, punctuation stripped, stopwords removed, empties dropped. */
function tokenize_(text) {
  if (!text) return [];
  var words = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ');
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length > 1 && !STOPWORDS_[w]) out.push(w);
  }
  return out;
}

/** Pure: Jaccard similarity (0..1) between two token lists — the deterministic semantic-similarity stand-in. */
function jaccardSimilarity_(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  var setA = {}, setB = {};
  tokensA.forEach(function (t) { setA[t] = true; });
  tokensB.forEach(function (t) { setB[t] = true; });

  var intersection = 0;
  var unionSet = {};
  Object.keys(setA).forEach(function (t) { unionSet[t] = true; if (setB[t]) intersection++; });
  Object.keys(setB).forEach(function (t) { unionSet[t] = true; });

  var unionSize = Object.keys(unionSet).length;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

// ============================================
// A1 RANGE HELPERS (pure)
// ============================================

var SENTINEL_MAX_ = 1000000;

/** Pure: parses "A1", "A1:B10", "A:A", or "1:1" into {startRow,startCol,endRow,endCol}. */
function parseRefBounds_(ref) {
  var clean = ref.replace(/\$/g, '');

  var wholeCol = clean.match(/^([A-Za-z]+):([A-Za-z]+)$/);
  if (wholeCol) {
    var c1 = colLetterToIndex_(wholeCol[1]), c2 = colLetterToIndex_(wholeCol[2]);
    return { startRow: 1, endRow: SENTINEL_MAX_, startCol: Math.min(c1, c2), endCol: Math.max(c1, c2) };
  }

  var wholeRow = clean.match(/^(\d+):(\d+)$/);
  if (wholeRow) {
    var r1 = parseInt(wholeRow[1], 10), r2 = parseInt(wholeRow[2], 10);
    return { startRow: Math.min(r1, r2), endRow: Math.max(r1, r2), startCol: 1, endCol: SENTINEL_MAX_ };
  }

  var m = clean.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/);
  if (!m) return null;
  var startCol = colLetterToIndex_(m[1]);
  var startRow = parseInt(m[2], 10);
  if (!m[3]) return { startRow: startRow, endRow: startRow, startCol: startCol, endCol: startCol };
  var endCol = colLetterToIndex_(m[3]);
  var endRow = parseInt(m[4], 10);
  return {
    startRow: Math.min(startRow, endRow), endRow: Math.max(startRow, endRow),
    startCol: Math.min(startCol, endCol), endCol: Math.max(startCol, endCol)
  };
}

function colLetterToIndex_(letters) {
  var n = 0;
  var upper = letters.toUpperCase();
  for (var i = 0; i < upper.length; i++) n = n * 26 + (upper.charCodeAt(i) - 64);
  return n;
}

/** Pure: do two A1 bound boxes overlap? */
function boundsOverlap_(a, b) {
  if (!a || !b) return false;
  return a.startRow <= b.endRow && a.endRow >= b.startRow && a.startCol <= b.endCol && a.endCol >= b.startCol;
}

// ============================================
// SIGNAL 1: ACTIVE SHEET
// ============================================

function scoreActiveSheet_(chunk, activeSheetName) {
  return chunk.sheet && chunk.sheet === activeSheetName ? 1 : 0;
}

// ============================================
// SIGNAL 2 & 6: REFERENCED FORMULAS / DEPENDENCY GRAPH
// ============================================

/**
 * Pure: BFS over the formula graph (treated as undirected — a chunk can be
 * relevant whether the active cell depends ON it or things depend ON the
 * active cell through it) up to maxHops. Returns node -> hop distance.
 */
function bfsGraphDistances_(formulaGraph, startNode, maxHops) {
  var adjacency = {};
  function addEdge(a, b) {
    adjacency[a] = adjacency[a] || {};
    adjacency[a][b] = true;
  }
  formulaGraph.nodes.forEach(function (n) {
    (formulaGraph.edges[n] || []).forEach(function (dep) {
      addEdge(n, dep);
      addEdge(dep, n);
    });
  });

  var distances = {};
  distances[startNode] = 0;
  var queue = [startNode];
  while (queue.length > 0) {
    var current = queue.shift();
    var d = distances[current];
    if (d >= maxHops) continue;
    var neighbors = adjacency[current] || {};
    Object.keys(neighbors).forEach(function (n) {
      if (distances[n] === undefined) {
        distances[n] = d + 1;
        queue.push(n);
      }
    });
  }
  return distances;
}

/**
 * Pure: does this table intersect any node within `graphDistances` (formula
 * graph BFS result)? Returns the closest hop distance found, or null.
 */
function tableGraphDistance_(table, graphDistances) {
  var best = null;
  Object.keys(graphDistances).forEach(function (node) {
    var sep = node.indexOf('!');
    var sheet = node.slice(0, sep);
    var ref = node.slice(sep + 1);
    if (sheet !== table.sheet) return;
    var bounds = parseRefBounds_(ref);
    var tableBounds = { startRow: table.startRow, endRow: table.startRow + table.numRows - 1, startCol: table.startCol, endCol: table.startCol + table.numCols - 1 };
    if (boundsOverlap_(bounds, tableBounds)) {
      var d = graphDistances[node];
      if (best === null || d < best) best = d;
    }
  });
  return best;
}

// ============================================
// SIGNAL 4: SHARED HEADERS
// ============================================

function scoreSharedHeaders_(chunkHeaders, referenceHeaders) {
  if (!chunkHeaders || !referenceHeaders || referenceHeaders.length === 0) return 0;
  var refSet = {};
  referenceHeaders.forEach(function (h) { refSet[String(h).toLowerCase()] = true; });
  var overlap = 0;
  chunkHeaders.forEach(function (h) { if (refSet[String(h).toLowerCase()]) overlap++; });
  return overlap / referenceHeaders.length;
}

// ============================================
// SIGNAL 5: NEIGHBORING TABLES
// ============================================

/** Pure: are two tables on the same sheet with bands close enough to be "neighbors"? */
function tablesAreNeighbors_(a, b, gap) {
  if (a.sheet !== b.sheet || a.id === b.id) return false;
  var aRowEnd = a.startRow + a.numRows - 1, bRowEnd = b.startRow + b.numRows - 1;
  var aColEnd = a.startCol + a.numCols - 1, bColEnd = b.startCol + b.numCols - 1;

  var verticallyAdjacent = (Math.abs(a.startRow - bRowEnd) <= gap || Math.abs(b.startRow - aRowEnd) <= gap) &&
    a.startCol <= bColEnd && b.startCol <= aColEnd;
  var horizontallyAdjacent = (Math.abs(a.startCol - bColEnd) <= gap || Math.abs(b.startCol - aColEnd) <= gap) &&
    a.startRow <= bRowEnd && b.startRow <= aRowEnd;

  return verticallyAdjacent || horizontallyAdjacent;
}

// ============================================
// LOOKUP HELPERS
// ============================================

/** Pure: finds the table (if any) whose range contains the given cell ref, on the given sheet. */
function findTableContainingCell_(model, sheetName, cellRef) {
  if (!cellRef) return null;
  var cellBounds = parseRefBounds_(cellRef);
  if (!cellBounds) return null;

  var sheetModel = model.workbook.sheets.filter(function (s) { return s.name === sheetName; })[0];
  if (!sheetModel) return null;

  var found = null;
  sheetModel.tables.forEach(function (table) {
    var tableBounds = { startRow: table.startRow, endRow: table.startRow + table.numRows - 1, startCol: table.startCol, endCol: table.startCol + table.numCols - 1 };
    if (boundsOverlap_(cellBounds, tableBounds)) found = table;
  });
  return found;
}

/** Pure: the table object a given chunk (of type 'table') corresponds to, or null. */
function findTableForChunk_(model, chunk) {
  if (chunk.type !== 'table') return null;
  var found = null;
  model.workbook.sheets.forEach(function (sheetModel) {
    sheetModel.tables.forEach(function (table) { if (table.id === chunk.id) found = table; });
  });
  return found;
}

// ============================================
// SCORING
// ============================================

/**
 * Pure: scores one chunk against the current retrieval context.
 * @returns {{ chunk, score, signals }}
 */
function scoreChunk_(chunk, ctx) {
  var weights = CONTEXT_RETRIEVER_CONFIG_.WEIGHTS;
  var signals = {};

  signals.activeSheet = scoreActiveSheet_(chunk, ctx.activeSheetName);

  var chunkTable = findTableForChunk_(ctx.model, chunk);
  var graphDist = chunkTable && ctx.activeCellDistances ? tableGraphDistance_(chunkTable, ctx.activeCellDistances) : null;
  signals.referencedFormulas = graphDist !== null && graphDist <= 1 ? 1 : 0;
  signals.dependencyGraph = graphDist !== null ? 1 / (1 + graphDist) : 0;

  signals.semanticSimilarity = jaccardSimilarity_(ctx.promptTokens, tokenize_(chunk.text));

  var referenceHeaders = ctx.activeTable ? ctx.activeTable.headers : ctx.mentionedHeaders;
  signals.sharedHeaders = chunkTable ? scoreSharedHeaders_(chunkTable.headers, referenceHeaders) : 0;

  signals.neighboringTables = (chunkTable && ctx.activeTable && chunkTable.id !== ctx.activeTable.id &&
    tablesAreNeighbors_(chunkTable, ctx.activeTable, CONTEXT_RETRIEVER_CONFIG_.NEIGHBOR_GAP_CELLS)) ? 1 : 0;

  signals.previousConversation = ctx.conversationTokens.length > 0 ? jaccardSimilarity_(ctx.conversationTokens, tokenize_(chunk.text)) : 0;

  var score = 0;
  Object.keys(signals).forEach(function (key) { score += (weights[key] || 0) * signals[key]; });

  return { chunk: chunk, score: score, signals: signals };
}

// ============================================
// SELECTION (greedy knapsack under a token budget)
// ============================================

/**
 * Pure: scores every chunk, sorts by score descending, and greedily fills
 * maxTokens with the highest-scoring chunks that still fit — maximizing
 * relevance per token spent rather than truncating arbitrarily.
 */
function selectContext_(model, options) {
  options = options || {};
  var maxTokens = options.maxTokens !== undefined ? options.maxTokens : CONTEXT_RETRIEVER_CONFIG_.MAX_CONTEXT_TOKENS;

  var promptTokens = tokenize_(options.prompt);
  var conversationTokens = tokenize_(options.conversationText);
  var activeTable = findTableContainingCell_(model, options.activeSheetName, options.activeCellRef);

  var activeCellDistances = null;
  if (options.activeSheetName && options.activeCellRef && model.formulaGraph.nodes.length > 0) {
    var activeNode = options.activeSheetName + '!' + options.activeCellRef.replace(/\$/g, '');
    activeCellDistances = bfsGraphDistances_(model.formulaGraph, activeNode, CONTEXT_RETRIEVER_CONFIG_.DEPENDENCY_MAX_HOPS);
  }

  var ctx = {
    model: model,
    activeSheetName: options.activeSheetName,
    activeTable: activeTable,
    activeCellDistances: activeCellDistances,
    promptTokens: promptTokens,
    conversationTokens: conversationTokens,
    mentionedHeaders: options.mentionedHeaders || []
  };

  var scored = model.embeddingChunks.map(function (chunk) { return scoreChunk_(chunk, ctx); });
  scored.sort(function (a, b) { return b.score - a.score; });

  var selected = [];
  var totalTokens = 0;
  scored.forEach(function (entry) {
    if (totalTokens + entry.chunk.tokenEstimate > maxTokens) return;
    selected.push(entry);
    totalTokens += entry.chunk.tokenEstimate;
  });

  return {
    selected: selected,
    totalTokens: totalTokens,
    maxTokens: maxTokens,
    consideredCount: scored.length,
    allScored: scored
  };
}

/** Pure: joins selected chunks into one prompt-ready context string. */
function buildRetrievalContextString_(selection) {
  if (selection.selected.length === 0) return '';
  var lines = ['=== RETRIEVED CONTEXT (' + selection.selected.length + '/' + selection.consideredCount + ' chunks, ~' + selection.totalTokens + ' tokens) ==='];
  selection.selected.forEach(function (entry) {
    lines.push('');
    lines.push(entry.chunk.text);
  });
  return lines.join('\n');
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Impure top-level entry point: reads the active spreadsheet + conversation
 * memory, runs SpreadsheetEngine.analyze(), and returns the selected,
 * budget-capped context ready to inject into an agent's system prompt.
 */
function retrieveContext_(prompt, options) {
  options = options || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var activeSheet = ss.getActiveSheet();
  var activeSheetName = activeSheet.getName();
  var activeCellRef = activeSheet.getActiveCell().getA1Notation();

  var model = options.model || SpreadsheetEngine.analyze();

  var conversationText = '';
  if (typeof MEMORY !== 'undefined') {
    try { conversationText = MEMORY.conversation.getSummary(); } catch (e) { /* memory may not be initialized yet */ }
  }

  var selection = selectContext_(model, {
    prompt: prompt,
    activeSheetName: activeSheetName,
    activeCellRef: activeCellRef,
    conversationText: conversationText,
    maxTokens: options.maxTokens
  });

  return {
    contextString: buildRetrievalContextString_(selection),
    selection: selection,
    model: model
  };
}

var ContextRetriever = {
  retrieve: retrieveContext_,
  selectContext: selectContext_,
  scoreChunk: scoreChunk_,
  buildRetrievalContextString: buildRetrievalContextString_,

  tokenize: tokenize_,
  jaccardSimilarity: jaccardSimilarity_,
  parseRefBounds: parseRefBounds_,
  boundsOverlap: boundsOverlap_,
  bfsGraphDistances: bfsGraphDistances_,
  tablesAreNeighbors: tablesAreNeighbors_,
  findTableContainingCell: findTableContainingCell_,
  findTableForChunk: findTableForChunk_
};
