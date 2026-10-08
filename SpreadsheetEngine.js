/**
 * SpreadsheetEngine.js — Full Workbook Model with Type Inference
 *
 * Pure, deterministic, offline analysis of a workbook. NO Gemini calls, no
 * network calls of any kind — everything here is SpreadsheetApp reads plus
 * plain JS computation. This is the "understanding" layer future components
 * (ContextRetriever.js, semantic search, etc.) can build on; it produces the
 * structured model, not the retrieval/ranking on top of it.
 *
 * Analysis proceeds through one strict layer hierarchy, each layer built from
 * the one before it:
 *
 *   Workbook -> Sheets -> Tables -> Headers -> Data Types -> Formula Graph
 *   -> Named Ranges -> Charts -> Pivot Tables -> Relationships
 *   -> Dependency Graph -> Statistics -> Embeddings-ready Chunks
 *
 * Design note — pure vs. GAS-facing functions:
 * Most of the real logic (table detection, type inference, formula-reference
 * parsing, dependency-graph algorithms, chunk building) is written as pure
 * functions over plain arrays/objects with no SpreadsheetApp calls at all.
 * Thin wrapper functions read the spreadsheet and hand plain data to the pure
 * functions. This means almost the entire engine can be unit tested with
 * plain JS fixtures — no mock Sheet/Range objects needed for the interesting
 * parts — and it keeps each piece of logic reasoning about one thing.
 */

var SPREADSHEET_ENGINE_CONFIG_ = {
  MAX_ROWS_PER_SHEET: 2000,   // Safety cap so one huge sheet can't blow the 6-minute GAS execution limit
  MAX_COLS_PER_SHEET: 200,
  SAMPLE_ROWS_PER_TABLE: 5,   // Rows included verbatim in embedding chunks
  MAX_CHUNK_CHARS: 2000       // Embedding chunks are split if they'd exceed this
};

// ============================================
// LAYER 1-2: WORKBOOK -> SHEETS
// ============================================

/** Impure: reads the active spreadsheet's top-level metadata. */
function buildWorkbookModel_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  return {
    spreadsheetId: ss.getId(),
    title: ss.getName(),
    locale: typeof ss.getSpreadsheetLocale === 'function' ? ss.getSpreadsheetLocale() : 'en_US',
    timeZone: typeof ss.getSpreadsheetTimeZone === 'function' ? ss.getSpreadsheetTimeZone() : 'Etc/GMT',
    sheetCount: sheets.length,
    sheets: sheets.map(buildSheetModel_)
  };
}

/** Impure: reads one sheet's metadata + its used-range grid, then hands off to pure analysis. */
function buildSheetModel_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  var sheetModel = {
    name: sheet.getName(),
    index: sheet.getIndex(),
    hidden: typeof sheet.isSheetHidden === 'function' ? sheet.isSheetHidden() : false,
    rowCount: lastRow,
    colCount: lastCol,
    frozenRows: typeof sheet.getFrozenRows === 'function' ? sheet.getFrozenRows() : 0,
    tables: []
  };

  if (lastRow === 0 || lastCol === 0) return sheetModel;

  var readRows = Math.min(lastRow, SPREADSHEET_ENGINE_CONFIG_.MAX_ROWS_PER_SHEET);
  var readCols = Math.min(lastCol, SPREADSHEET_ENGINE_CONFIG_.MAX_COLS_PER_SHEET);
  var grid = sheet.getRange(1, 1, readRows, readCols).getValues();

  var numberFormats = null;
  try {
    if (typeof sheet.getRange(1, 1, readRows, readCols).getNumberFormats === 'function') {
      numberFormats = sheet.getRange(1, 1, readRows, readCols).getNumberFormats();
    }
  } catch (e) { /* number formats are a nice-to-have for currency/percentage detection, not required */ }

  sheetModel.tables = analyzeGrid_(grid, sheetModel.name, numberFormats);
  return sheetModel;
}

// ============================================
// LAYER 3-5: TABLES -> HEADERS -> DATA TYPES
// ============================================

/** Pure: is every cell in this row blank? */
function isRowBlank_(row) {
  for (var i = 0; i < row.length; i++) {
    var v = row[i];
    if (v !== '' && v !== null && v !== undefined) return false;
  }
  return true;
}

/** Pure: is column `col` blank across grid rows [rowStart, rowEnd] (inclusive, 0-indexed)? */
function isColBlankInBand_(grid, rowStart, rowEnd, col) {
  for (var r = rowStart; r <= rowEnd; r++) {
    var v = grid[r][col];
    if (v !== '' && v !== null && v !== undefined) return false;
  }
  return true;
}

/**
 * Pure: splits a grid into rectangular "table" bands — contiguous blocks of
 * non-empty cells separated from other blocks by at least one fully-blank
 * row or column. This is a heuristic (real spreadsheets don't declare table
 * boundaries), but it's the same practical heuristic spreadsheet tools use:
 * blank rows/columns are the strongest available signal of "new table."
 *
 * @returns {Array<{rowStart,rowEnd,colStart,colEnd}>} 0-indexed, inclusive bands
 */
function detectTableBands_(grid) {
  if (!grid || grid.length === 0) return [];
  var numCols = grid[0].length;

  var rowBands = [];
  var bandStart = null;
  for (var r = 0; r < grid.length; r++) {
    var blank = isRowBlank_(grid[r]);
    if (!blank && bandStart === null) bandStart = r;
    if (blank && bandStart !== null) { rowBands.push([bandStart, r - 1]); bandStart = null; }
  }
  if (bandStart !== null) rowBands.push([bandStart, grid.length - 1]);

  var bands = [];
  rowBands.forEach(function (rowBand) {
    var rowStart = rowBand[0], rowEnd = rowBand[1];
    var colStart = null;
    for (var c = 0; c < numCols; c++) {
      var blank = isColBlankInBand_(grid, rowStart, rowEnd, c);
      if (!blank && colStart === null) colStart = c;
      if (blank && colStart !== null) {
        bands.push({ rowStart: rowStart, rowEnd: rowEnd, colStart: colStart, colEnd: c - 1 });
        colStart = null;
      }
    }
    if (colStart !== null) {
      bands.push({ rowStart: rowStart, rowEnd: rowEnd, colStart: colStart, colEnd: numCols - 1 });
    }
  });

  return bands;
}

/** Pure: population-free helpers for numeric stats. */
function median_(sortedNums) {
  var n = sortedNums.length;
  if (n === 0) return null;
  var mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

function sampleStdev_(nums, mean) {
  if (nums.length < 2) return 0;
  var sumSq = nums.reduce(function (acc, v) { return acc + (v - mean) * (v - mean); }, 0);
  return Math.sqrt(sumSq / (nums.length - 1));
}

/**
 * Pure: infers a single column's data type + summary stats from its raw
 * values (and optionally the cell number-format strings, for distinguishing
 * currency/percentage from plain numbers — GAS's getNumberFormats()).
 *
 * Types: 'empty' | 'text' | 'number' | 'currency' | 'percentage' | 'boolean' | 'date' | 'mixed'
 */
function analyzeColumnType_(values, numberFormats) {
  var nonEmpty = [];
  var nonEmptyFormats = [];
  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    if (v !== '' && v !== null && v !== undefined) {
      nonEmpty.push(v);
      nonEmptyFormats.push((numberFormats && numberFormats[i]) || '');
    }
  }

  if (nonEmpty.length === 0) {
    return { type: 'empty', count: 0, nullCount: values.length, stats: null };
  }

  var allNumbers = nonEmpty.every(function (v) { return typeof v === 'number'; });
  // Object.prototype.toString.call() rather than `instanceof Date`: GAS's
  // SpreadsheetApp always returns Date objects from the same realm so either
  // check works in production, but toString detection is the robust
  // realm-agnostic way to identify a Date and costs nothing extra.
  var allDates = nonEmpty.every(function (v) { return Object.prototype.toString.call(v) === '[object Date]'; });
  var allBooleans = nonEmpty.every(function (v) { return typeof v === 'boolean'; });
  var allStrings = nonEmpty.every(function (v) { return typeof v === 'string'; });

  var base = { count: nonEmpty.length, nullCount: values.length - nonEmpty.length };

  if (allNumbers) {
    var isCurrency = nonEmptyFormats.length > 0 && nonEmptyFormats.every(function (f) { return /[$€£¥]/.test(f); });
    var isPercentage = nonEmptyFormats.length > 0 && nonEmptyFormats.every(function (f) { return /%/.test(f); });

    var sorted = nonEmpty.slice().sort(function (a, b) { return a - b; });
    var sum = nonEmpty.reduce(function (a, b) { return a + b; }, 0);
    var mean = sum / nonEmpty.length;

    base.stats = {
      min: sorted[0], max: sorted[sorted.length - 1], sum: sum, mean: mean,
      median: median_(sorted), stdev: sampleStdev_(nonEmpty, mean)
    };
    base.type = isCurrency ? 'currency' : isPercentage ? 'percentage' : 'number';
    return base;
  }

  if (allDates) {
    var times = nonEmpty.map(function (d) { return d.getTime(); });
    base.stats = {
      minDate: new Date(Math.min.apply(null, times)).toISOString(),
      maxDate: new Date(Math.max.apply(null, times)).toISOString()
    };
    base.type = 'date';
    return base;
  }

  if (allBooleans) {
    var trueCount = nonEmpty.filter(function (v) { return v === true; }).length;
    base.stats = { trueCount: trueCount, falseCount: nonEmpty.length - trueCount };
    base.type = 'boolean';
    return base;
  }

  if (allStrings) {
    var uniqueSet = {};
    var minLength = Infinity, maxLength = 0;
    nonEmpty.forEach(function (s) {
      uniqueSet[s] = true;
      minLength = Math.min(minLength, s.length);
      maxLength = Math.max(maxLength, s.length);
    });
    base.stats = { uniqueCount: Object.keys(uniqueSet).length, minLength: minLength, maxLength: maxLength };
    base.type = 'text';
    return base;
  }

  base.stats = null;
  base.type = 'mixed';
  return base;
}

/**
 * Pure: builds one full table object (headers + per-column data types) from
 * a detected band. A band's first row is treated as a header row only if
 * every cell in it is non-empty text AND there's at least one data row below
 * it — otherwise the whole band is data with synthetic "Column1".."ColumnN"
 * headers.
 */
function buildTableFromBand_(grid, band, sheetName, numberFormats) {
  var rowStart = band.rowStart, rowEnd = band.rowEnd, colStart = band.colStart, colEnd = band.colEnd;
  var numRows = rowEnd - rowStart + 1;
  var numCols = colEnd - colStart + 1;

  var headerRow = grid[rowStart].slice(colStart, colEnd + 1);
  var looksLikeHeader = numRows > 1 && headerRow.every(function (v) {
    return typeof v === 'string' && v !== '';
  });

  var headers = looksLikeHeader
    ? headerRow
    : headerRow.map(function (_, i) { return 'Column' + (i + 1); });

  var dataStartRow = looksLikeHeader ? rowStart + 1 : rowStart;

  var columns = [];
  for (var c = 0; c < numCols; c++) {
    var colIndex = colStart + c;
    var columnValues = [];
    var columnFormats = numberFormats ? [] : null;
    for (var r = dataStartRow; r <= rowEnd; r++) {
      columnValues.push(grid[r][colIndex]);
      if (columnFormats) columnFormats.push(numberFormats[r][colIndex]);
    }
    var analysis = analyzeColumnType_(columnValues, columnFormats);
    columns.push({
      header: headers[c],
      index: c,
      columnLetter: colIndexToLetter_(colIndex + 1),
      dataType: analysis.type,
      count: analysis.count,
      nullCount: analysis.nullCount,
      stats: analysis.stats
    });
  }

  var startColLetter = colIndexToLetter_(colStart + 1);
  var endColLetter = colIndexToLetter_(colEnd + 1);
  var range = startColLetter + (rowStart + 1) + ':' + endColLetter + (rowEnd + 1);

  return {
    id: sheetName + '!' + range,
    sheet: sheetName,
    range: range,
    startRow: rowStart + 1,
    startCol: colStart + 1,
    numRows: numRows,
    numCols: numCols,
    hasHeaderRow: looksLikeHeader,
    headers: headers,
    dataRowCount: Math.max(0, rowEnd - dataStartRow + 1),
    columns: columns
  };
}

/** Pure: detects tables in a grid and builds full table models for each. */
function analyzeGrid_(grid, sheetName, numberFormats) {
  var bands = detectTableBands_(grid);
  return bands.map(function (band) {
    return buildTableFromBand_(grid, band, sheetName, numberFormats);
  });
}

// ============================================
// LAYER 6: FORMULA GRAPH
// ============================================
//
// A best-effort static parser, not a real formula tokenizer/AST. Known
// limitation: a function name whose letters+trailing-digits shape looks like
// a cell reference (e.g. LOG10, a real Sheets function) would false-match if
// not for one heuristic that eliminates the entire class: a real cell
// reference is never immediately followed by "(" in valid formula syntax
// (that's always a function call). This check is deliberately done AFTER
// each regex match completes (comparing the literal character following the
// match), not as a trailing `(?!...)` on the pattern itself — a lookahead
// there is defeated by its own backtracking: matching "LOG10(" would first
// try the full "LOG10", fail the lookahead since "(" follows, then backtrack
// the digit run down to "LOG1" — which is NOT immediately followed by "("
// (the leftover "0" is) — and wrongly succeed. A post-match string check
// has nothing left to backtrack into. Range references (A1:B10, A:A) are
// treated as a single graph node — expanding a range like A:A into one node
// per cell would make the graph intractable for no analytical benefit here.

var CELL_REF_PATTERN_ = /(?:(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*))!)?(\$?[A-Za-z]{1,3}\$?[0-9]+)(?::(\$?[A-Za-z]{1,3}\$?[0-9]+))?/g;

/** Pure: blanks out quoted string literals so their contents can't be mistaken for refs. */
function stripStringLiterals_(formula) {
  return formula.replace(/"(?:[^"]|"")*"/g, function (m) {
    var blanks = '';
    for (var i = 0; i < m.length; i++) blanks += ' ';
    return blanks;
  });
}

/**
 * Pure: extracts every cell/range reference a formula depends on.
 * @returns {Array<{sheet, ref, isRange, node}>}
 */
function parseFormulaRefs_(formula, currentSheetName) {
  if (!formula || formula.charAt(0) !== '=') return [];

  var cleaned = stripStringLiterals_(formula);
  var refs = [];
  var seen = {};
  var match;

  CELL_REF_PATTERN_.lastIndex = 0;
  while ((match = CELL_REF_PATTERN_.exec(cleaned)) !== null) {
    var followedByParen = /^\s*\(/.test(cleaned.slice(match.index + match[0].length));
    if (followedByParen) continue; // it's a function call (e.g. LOG10(...)), not a cell reference

    var sheetName = match[1] || match[2] || currentSheetName;
    var startRef = match[3];
    var endRef = match[4];
    var isRange = !!endRef;
    var refText = startRef + (endRef ? ':' + endRef : '');
    var node = sheetName + '!' + refText;

    if (seen[node]) continue;
    seen[node] = true;
    refs.push({ sheet: sheetName, ref: refText, isRange: isRange, node: node });
  }

  return refs;
}

/** Impure: reads every formula cell across all sheets and builds the dependency graph. */
function buildFormulaGraph_(workbookModel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var nodes = [];
  var edges = {}; // node -> [dependency node ids]
  var formulasByNode = {};

  workbookModel.sheets.forEach(function (sheetModel) {
    if (sheetModel.rowCount === 0 || sheetModel.colCount === 0) return;
    var sheet = ss.getSheetByName(sheetModel.name);
    if (!sheet) return;

    var readRows = Math.min(sheetModel.rowCount, SPREADSHEET_ENGINE_CONFIG_.MAX_ROWS_PER_SHEET);
    var readCols = Math.min(sheetModel.colCount, SPREADSHEET_ENGINE_CONFIG_.MAX_COLS_PER_SHEET);
    var formulas = sheet.getRange(1, 1, readRows, readCols).getFormulas();

    for (var r = 0; r < formulas.length; r++) {
      for (var c = 0; c < formulas[r].length; c++) {
        var formula = formulas[r][c];
        if (!formula) continue;

        var cellRef = colIndexToLetter_(c + 1) + (r + 1);
        var node = sheetModel.name + '!' + cellRef;
        var deps = parseFormulaRefs_(formula, sheetModel.name);

        nodes.push(node);
        edges[node] = deps.map(function (d) { return d.node; });
        formulasByNode[node] = { formula: formula, dependencies: deps };
      }
    }
  });

  return { nodes: nodes, edges: edges, formulas: formulasByNode };
}

// ============================================
// LAYER 7-9: NAMED RANGES -> CHARTS -> PIVOT TABLES
// ============================================

/** Impure: collects named ranges (workbook-scoped in GAS's API). */
function collectNamedRanges_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getNamedRanges().map(function (nr) {
    return { name: nr.getName(), range: nr.getRange().getA1Notation() };
  });
}

/** Impure: collects chart metadata per sheet. */
function collectCharts_(workbookModel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var charts = [];
  workbookModel.sheets.forEach(function (sheetModel) {
    var sheet = ss.getSheetByName(sheetModel.name);
    if (!sheet || typeof sheet.getCharts !== 'function') return;
    sheet.getCharts().forEach(function (chart) {
      charts.push({
        chartId: chart.getChartId(),
        sheet: sheetModel.name,
        chartType: typeof chart.getChartType === 'function' ? String(chart.getChartType()) : 'UNKNOWN'
      });
    });
  });
  return charts;
}

/**
 * Impure: best-effort pivot table detection via Range.getPivotTables().
 * Not every GAS environment/mock supports this call, so it degrades to an
 * empty list rather than failing the whole analysis.
 */
function collectPivotTables_(workbookModel) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pivots = [];
  workbookModel.sheets.forEach(function (sheetModel) {
    if (sheetModel.rowCount === 0 || sheetModel.colCount === 0) return;
    var sheet = ss.getSheetByName(sheetModel.name);
    if (!sheet) return;
    try {
      var dataRange = sheet.getRange(1, 1, sheetModel.rowCount, sheetModel.colCount);
      if (typeof dataRange.getPivotTables !== 'function') return;
      dataRange.getPivotTables().forEach(function (pivot) {
        pivots.push({
          sheet: sheetModel.name,
          sourceDataRange: typeof pivot.getSourceDataRange === 'function' ? pivot.getSourceDataRange().getA1Notation() : null
        });
      });
    } catch (e) { /* pivot table introspection is best-effort */ }
  });
  return pivots;
}

// ============================================
// LAYER 10: RELATIONSHIPS
// ============================================

/**
 * Pure: aggregates the cell-level formula graph into a sheet-level
 * relationship summary — which sheets reference which other sheets, how
 * often, and a few sample cells as evidence.
 */
function buildRelationships_(formulaGraph) {
  var relKey = function (from, to) { return from + '->' + to; };
  var rels = {};

  formulaGraph.nodes.forEach(function (node) {
    var fromSheet = node.split('!')[0];
    var info = formulaGraph.formulas[node];
    if (!info) return;

    info.dependencies.forEach(function (dep) {
      if (dep.sheet === fromSheet) return; // same-sheet refs aren't a cross-sheet relationship
      var key = relKey(fromSheet, dep.sheet);
      if (!rels[key]) {
        rels[key] = { from: fromSheet, to: dep.sheet, count: 0, sampleCells: [] };
      }
      rels[key].count++;
      if (rels[key].sampleCells.length < 5) {
        rels[key].sampleCells.push(node + ' -> ' + dep.node);
      }
    });
  });

  return Object.keys(rels).map(function (k) { return rels[k]; });
}

// ============================================
// LAYER 11: DEPENDENCY GRAPH
// ============================================
//
// Adds graph-theoretic properties on top of the raw Formula Graph: which
// formulas feed off other formulas (vs. off raw input cells), circular
// references, and how deep the longest dependency chain runs. Range
// dependencies (A1:B10) aren't traversed for cycle/depth purposes — they
// aren't graph nodes themselves (see the Formula Graph section).

/** Pure: DFS-based cycle detection. Returns an array of cycles (each an array of node ids). */
function detectCycles_(nodes, edges) {
  var WHITE = 0, GRAY = 1, BLACK = 2;
  var color = {};
  var nodeSet = {};
  nodes.forEach(function (n) { color[n] = WHITE; nodeSet[n] = true; });
  var cycles = [];

  function dfs(node, stack) {
    color[node] = GRAY;
    stack.push(node);
    (edges[node] || []).forEach(function (dep) {
      if (!nodeSet[dep]) return; // range refs / non-formula cells aren't traversable nodes
      if (color[dep] === GRAY) {
        var idx = stack.indexOf(dep);
        cycles.push(stack.slice(idx).concat(dep));
      } else if (color[dep] === WHITE) {
        dfs(dep, stack);
      }
    });
    stack.pop();
    color[node] = BLACK;
  }

  nodes.forEach(function (n) { if (color[n] === WHITE) dfs(n, []); });
  return cycles;
}

/** Pure: longest-dependency-chain depth per node (0 = depends only on non-formula inputs, or nothing). */
function computeDepths_(nodes, edges) {
  var depth = {};
  var visiting = {};
  var nodeSet = {};
  nodes.forEach(function (n) { nodeSet[n] = true; });

  function computeDepth(node) {
    if (depth[node] !== undefined) return depth[node];
    if (visiting[node]) return 0; // cycle guard — already-broken cycles are reported separately
    visiting[node] = true;

    var maxDepth = 0;
    (edges[node] || []).forEach(function (dep) {
      if (!nodeSet[dep]) return;
      maxDepth = Math.max(maxDepth, computeDepth(dep) + 1);
    });

    visiting[node] = false;
    depth[node] = maxDepth;
    return maxDepth;
  }

  nodes.forEach(computeDepth);
  return depth;
}

/** Pure: builds the full dependency graph analysis from a Formula Graph. */
function buildDependencyGraph_(formulaGraph) {
  var nodes = formulaGraph.nodes;
  var edges = formulaGraph.edges;
  var nodeSet = {};
  nodes.forEach(function (n) { nodeSet[n] = true; });

  var cycles = detectCycles_(nodes, edges);
  var depths = computeDepths_(nodes, edges);

  var hasDependent = {};
  nodes.forEach(function (n) {
    (edges[n] || []).forEach(function (dep) { if (nodeSet[dep]) hasDependent[dep] = true; });
  });

  var roots = nodes.filter(function (n) {
    return (edges[n] || []).every(function (dep) { return !nodeSet[dep]; });
  });
  var leaves = nodes.filter(function (n) { return !hasDependent[n]; });

  var maxDepth = 0;
  nodes.forEach(function (n) { maxDepth = Math.max(maxDepth, depths[n] || 0); });

  return {
    nodeCount: nodes.length,
    edgeCount: nodes.reduce(function (sum, n) { return sum + (edges[n] || []).length; }, 0),
    cycles: cycles,
    hasCycles: cycles.length > 0,
    depths: depths,
    maxDepth: maxDepth,
    roots: roots,   // formulas that depend only on raw input cells (or nothing)
    leaves: leaves  // formulas nothing else depends on
  };
}

// ============================================
// LAYER 12: STATISTICS
// ============================================

/** Pure: workbook + sheet level aggregate statistics. */
function computeStatistics_(workbookModel, formulaGraph, dependencyGraph) {
  var totalCells = 0, totalFormulaCells = formulaGraph.nodes.length, totalTables = 0;
  var typeCounts = {};

  var perSheet = workbookModel.sheets.map(function (sheetModel) {
    totalCells += sheetModel.rowCount * sheetModel.colCount;
    totalTables += sheetModel.tables.length;

    var sheetFormulaCount = formulaGraph.nodes.filter(function (n) {
      return n.split('!')[0] === sheetModel.name;
    }).length;

    sheetModel.tables.forEach(function (table) {
      table.columns.forEach(function (col) {
        typeCounts[col.dataType] = (typeCounts[col.dataType] || 0) + 1;
      });
    });

    var sheetCells = sheetModel.rowCount * sheetModel.colCount;
    return {
      sheet: sheetModel.name,
      cellCount: sheetCells,
      tableCount: sheetModel.tables.length,
      formulaCount: sheetFormulaCount,
      formulaDensity: sheetCells > 0 ? sheetFormulaCount / sheetCells : 0
    };
  });

  return {
    totalCells: totalCells,
    totalFormulaCells: totalFormulaCells,
    formulaDensity: totalCells > 0 ? totalFormulaCells / totalCells : 0,
    totalTables: totalTables,
    columnTypeCounts: typeCounts,
    dependencyGraph: {
      maxDepth: dependencyGraph.maxDepth,
      cycleCount: dependencyGraph.cycles.length,
      rootCount: dependencyGraph.roots.length,
      leafCount: dependencyGraph.leaves.length
    },
    perSheet: perSheet
  };
}

// ============================================
// LAYER 13: EMBEDDINGS-READY CHUNKS
// ============================================
//
// Deterministic text chunking, NOT embedding computation — no model is
// called here. Each chunk is a bounded, self-contained block of text plus
// metadata, ready to be handed to an embedding API by a future component.

/** Pure: splits long text on line boundaries into pieces <= maxChars. */
function splitIntoChunks_(text, maxChars) {
  if (text.length <= maxChars) return [text];
  var lines = text.split('\n');
  var chunks = [];
  var current = '';
  lines.forEach(function (line) {
    if ((current + '\n' + line).length > maxChars && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current.length > 0 ? current + '\n' + line : line;
    }
  });
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function formatTableChunkText_(table) {
  var lines = [];
  // Column letters and the data-row span are what a formula needs to address the table
  // (without them a model guesses letters or falls back to header names).
  var lastRow = table.startRow + table.numRows - 1;
  var firstData = table.hasHeaderRow ? table.startRow + 1 : table.startRow;
  lines.push('Sheet "' + table.sheet + '", table ' + table.range +
    (table.hasHeaderRow ? ' (header in row ' + table.startRow + ', data in rows ' + firstData + '-' + lastRow + ')' : ' (no header row detected)') + ':');
  lines.push('Columns: ' + table.columns.map(function (c) {
    return c.columnLetter + ' "' + c.header + '" (' + c.dataType + ')';
  }).join(', '));
  lines.push('Rows: ' + table.dataRowCount);
  table.columns.forEach(function (c) {
    if (!c.stats) return;
    if (c.dataType === 'number' || c.dataType === 'currency' || c.dataType === 'percentage') {
      lines.push('  ' + c.columnLetter + ' ' + c.header + ': min=' + c.stats.min + ' max=' + c.stats.max + ' mean=' + c.stats.mean.toFixed(2));
    } else if (c.dataType === 'date') {
      lines.push('  ' + c.columnLetter + ' ' + c.header + ': from ' + c.stats.minDate + ' to ' + c.stats.maxDate);
    } else if (c.dataType === 'text') {
      lines.push('  ' + c.columnLetter + ' ' + c.header + ': ' + c.stats.uniqueCount + ' unique values');
    }
  });
  return lines.join('\n');
}

function formatRelationshipChunkText_(relationships) {
  if (relationships.length === 0) return null;
  var lines = ['Cross-sheet relationships:'];
  relationships.forEach(function (rel) {
    lines.push('  ' + rel.from + ' references ' + rel.to + ' (' + rel.count + ' formula' + (rel.count === 1 ? '' : 's') + ')');
  });
  return lines.join('\n');
}

function formatDependencyChunkText_(dependencyGraph) {
  var lines = ['Formula dependency graph: ' + dependencyGraph.nodeCount + ' formulas, max chain depth ' + dependencyGraph.maxDepth + '.'];
  if (dependencyGraph.hasCycles) {
    lines.push('WARNING: ' + dependencyGraph.cycles.length + ' circular reference(s) detected: ' +
      dependencyGraph.cycles.map(function (c) { return c.join(' -> '); }).join('; '));
  }
  return lines.join('\n');
}

/**
 * Pure: builds the final embeddings-ready chunk list from the fully-assembled
 * model. One chunk per table (with column type + stats summary), one for
 * named ranges, one for cross-sheet relationships (if any), one for the
 * dependency graph. Long chunks are split on line boundaries.
 */
function buildEmbeddingChunks_(model) {
  var maxChars = SPREADSHEET_ENGINE_CONFIG_.MAX_CHUNK_CHARS;
  var rawChunks = [];

  model.workbook.sheets.forEach(function (sheetModel) {
    sheetModel.tables.forEach(function (table) {
      rawChunks.push({ id: table.id, type: 'table', sheet: table.sheet, text: formatTableChunkText_(table) });
    });
  });

  if (model.namedRanges.length > 0) {
    var nrText = 'Named ranges:\n' + model.namedRanges.map(function (nr) {
      return '  "' + nr.name + '" -> ' + nr.range;
    }).join('\n');
    rawChunks.push({ id: 'named-ranges', type: 'namedRanges', sheet: null, text: nrText });
  }

  var relText = formatRelationshipChunkText_(model.relationships);
  if (relText) rawChunks.push({ id: 'relationships', type: 'relationships', sheet: null, text: relText });

  if (model.dependencyGraph.nodeCount > 0) {
    rawChunks.push({
      id: 'dependency-graph', type: 'dependencyGraph', sheet: null,
      text: formatDependencyChunkText_(model.dependencyGraph)
    });
  }

  var chunks = [];
  rawChunks.forEach(function (raw) {
    var pieces = splitIntoChunks_(raw.text, maxChars);
    pieces.forEach(function (text, i) {
      chunks.push({
        id: pieces.length > 1 ? raw.id + '#' + (i + 1) : raw.id,
        type: raw.type,
        sheet: raw.sheet,
        text: text,
        tokenEstimate: Math.ceil(text.length / 4)
      });
    });
  });

  return chunks;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Runs the full pipeline in the exact documented layer order and returns the
 * complete model. Pure deterministic analysis only — never calls Gemini or
 * any other network API.
 */
function analyzeWorkbook_() {
  var workbook = buildWorkbookModel_();                                    // Workbook -> Sheets -> Tables -> Headers -> Data Types
  var formulaGraph = buildFormulaGraph_(workbook);                         // Formula Graph
  var namedRanges = collectNamedRanges_();                                 // Named Ranges
  var charts = collectCharts_(workbook);                                   // Charts
  var pivotTables = collectPivotTables_(workbook);                         // Pivot Tables
  var relationships = buildRelationships_(formulaGraph);                   // Relationships
  var dependencyGraph = buildDependencyGraph_(formulaGraph);               // Dependency Graph
  var statistics = computeStatistics_(workbook, formulaGraph, dependencyGraph); // Statistics

  var model = {
    workbook: workbook,
    formulaGraph: formulaGraph,
    namedRanges: namedRanges,
    charts: charts,
    pivotTables: pivotTables,
    relationships: relationships,
    dependencyGraph: dependencyGraph,
    statistics: statistics
  };

  model.embeddingChunks = buildEmbeddingChunks_(model);                    // Embeddings-ready Chunks
  return model;
}

/**
 * SpreadsheetEngine — public facade. Exposes the full pipeline plus every
 * individual layer (each independently testable and reusable).
 */
var SpreadsheetEngine = {
  analyze: analyzeWorkbook_,

  buildWorkbookModel: buildWorkbookModel_,
  buildSheetModel: buildSheetModel_,

  detectTableBands: detectTableBands_,
  buildTableFromBand: buildTableFromBand_,
  analyzeGrid: analyzeGrid_,
  analyzeColumnType: analyzeColumnType_,

  parseFormulaRefs: parseFormulaRefs_,
  buildFormulaGraph: buildFormulaGraph_,

  collectNamedRanges: collectNamedRanges_,
  collectCharts: collectCharts_,
  collectPivotTables: collectPivotTables_,

  buildRelationships: buildRelationships_,

  detectCycles: detectCycles_,
  computeDepths: computeDepths_,
  buildDependencyGraph: buildDependencyGraph_,

  computeStatistics: computeStatistics_,

  buildEmbeddingChunks: buildEmbeddingChunks_
};
