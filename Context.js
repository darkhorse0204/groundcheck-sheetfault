/**
 * Context.js — Deep Spreadsheet Context Builder
 *
 * This is the single biggest upgrade from V1. The old getSheetContext() only passed
 * column headers and the active cell reference — the LLM was basically blind.
 * Now we pass: sheet name, dimensions, sample data, nearby formulas, inferred types,
 * and named ranges. The difference in output accuracy is night and day.
 *
 * TODO: For sheets with 50+ columns, we might want to only include the columns near
 * the active cell to avoid eating too much of the context window.
 */

// The main context builder. Called on every single request in handleRequest().
// Returns a fat object with everything the LLM needs to write accurate formulas.
function buildDeepContext() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getActiveSheet();
    var cell = sheet.getActiveCell();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();

    var context = {
      spreadsheetName: ss.getName(),
      sheetName: sheet.getName(),
      activeCell: cell.getA1Notation(),
      activeCellValue: cell.getValue(),
      activeCellFormula: cell.getFormula(),
      dimensions: { rows: lastRow, cols: lastCol },
      headers: [],
      sampleData: [],
      nearbyFormulas: [],
      columnTypes: {},
      namedRanges: []
    };

    // Row 1 = headers. If it's empty, the sheet probably isn't structured data
    if (lastCol > 0) {
      context.headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    }

    // Grab first N data rows so the LLM can see actual values, not just column names.
    // This is what lets it infer that "Revenue" is numeric with values like 50000, not just a string header.
    var sampleCount = Math.min(CONFIG.CONTEXT.SAMPLE_ROWS, Math.max(0, lastRow - 1));
    if (sampleCount > 0 && lastCol > 0) {
      context.sampleData = sheet.getRange(2, 1, sampleCount, lastCol).getValues();
    }

    // Scan for formulas around the active cell — helps the LLM maintain consistency
    // (e.g., if B2 has =SUMIF(...), B3 probably needs a similar pattern)
    context.nearbyFormulas = getNearbyFormulas_(sheet, cell);

    // Infer column types from sample data. The LLM needs to know if "Price" is a number
    // column vs. a string column to pick the right functions (SUM vs. CONCATENATE)
    context.columnTypes = inferColumnTypes_(sheet, lastRow, lastCol);

    // Named ranges — these are the cleanest way to reference data in formulas,
    // and the LLM should prefer them if they exist
    try {
      context.namedRanges = ss.getNamedRanges().map(function(r) {
        return { name: r.getName(), range: r.getRange().getA1Notation() };
      });
    } catch (e) { /* Some users don't have permission to read named ranges. Not critical. */ }

    logInfo_('Context', 'Built deep context', {
      sheet: context.sheetName,
      dims: context.dimensions,
      headersCount: context.headers.filter(Boolean).length
    });

    return context;
  } catch (e) {
    logError_('Context', 'Failed to build context: ' + e.message);
    throw createError_(ErrorType.CONTEXT_ERROR, 'Could not read spreadsheet context: ' + e.message);
  }
}

// Scans a NEARBY_RANGE-cell radius around the active cell for any formulas.
// This gives the LLM "peer" formulas to pattern-match against.
// e.g., if B2 has =A2*0.18, the LLM knows B3 should probably be =A3*0.18 too.
function getNearbyFormulas_(sheet, cell) {
  var formulas = [];
  var row = cell.getRow();
  var col = cell.getColumn();
  var range = CONFIG.CONTEXT.NEARBY_RANGE;
  var maxRow = sheet.getLastRow();
  var maxCol = sheet.getLastColumn();

  // Empty sheet edge case — nothing to scan
  if (maxRow === 0 || maxCol === 0) return formulas;

  // Clamp the scan window to sheet bounds
  var startRow = Math.max(1, row - range);
  var endRow = Math.min(maxRow, row + range);
  var startCol = Math.max(1, col - range);
  var endCol = Math.min(maxCol, col + range);

  var formulaGrid = sheet.getRange(startRow, startCol, endRow - startRow + 1, endCol - startCol + 1).getFormulas();

  for (var r = 0; r < formulaGrid.length; r++) {
    for (var c = 0; c < formulaGrid[r].length; c++) {
      if (formulaGrid[r][c]) {
        formulas.push({
          cell: sheet.getRange(startRow + r, startCol + c).getA1Notation(),
          formula: formulaGrid[r][c]
        });
      }
    }
  }
  return formulas;
}

// Quick-and-dirty type inference. We look at the first ~5 data rows and check if all
// non-empty values in a column are the same type. Not perfect (a column with 4 numbers
// and 1 text gets classified as 'text') but good enough for the LLM's purposes.
// TODO: Could add 'currency' or 'percentage' detection by checking for $ or % formats.
function inferColumnTypes_(sheet, lastRow, lastCol) {
  var types = {};
  if (lastRow < 2 || lastCol < 1) return types; // No data rows

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var sampleEnd = Math.min(6, lastRow); // Check first 5 data rows max
  var data = sheet.getRange(2, 1, sampleEnd - 1, lastCol).getValues();

  for (var c = 0; c < lastCol; c++) {
    if (!headers[c]) continue; // Skip blank headers
    var vals = data.map(function(row) { return row[c]; }).filter(function(v) { return v !== '' && v !== null && v !== undefined; });

    if (vals.length === 0) { types[headers[c]] = 'empty'; continue; }

    // Date check first because dates are also typeof 'object' in GAS
    if (vals.every(function(v) { return v instanceof Date; })) { types[headers[c]] = 'date'; }
    else if (vals.every(function(v) { return typeof v === 'number'; })) { types[headers[c]] = 'number'; }
    else if (vals.every(function(v) { return typeof v === 'boolean'; })) { types[headers[c]] = 'boolean'; }
    else { types[headers[c]] = 'text'; }
  }
  return types;
}

// Serializes the context object into a human-readable block that gets injected
// into the system prompt. The LLM sees this as structured text, not JSON.
// We tried passing raw JSON once — the LLM's formula accuracy actually dropped
// because it spent tokens parsing the structure instead of reasoning about the data.
function formatContextForPrompt_(context) {
  var lines = [];
  lines.push('=== SPREADSHEET CONTEXT ===');
  lines.push('Spreadsheet: "' + (context.spreadsheetName || '') + '"');
  lines.push('Sheet: "' + (context.sheetName || '') + '"');
  lines.push('Active Cell: ' + context.activeCell);

  if (context.activeCellValue !== '' && context.activeCellValue !== null) {
    lines.push('Active Cell Value: ' + String(context.activeCellValue));
  }
  if (context.activeCellFormula) {
    lines.push('Active Cell Formula: ' + context.activeCellFormula);
  }

  lines.push('Dimensions: ' + context.dimensions.rows + ' rows x ' + context.dimensions.cols + ' columns');

  if (context.headers.length > 0) {
    lines.push('\nColumn Headers (with inferred types):');
    context.headers.forEach(function(h, i) {
      if (h) {
        var type = context.columnTypes[h] || 'unknown';
        // NOTE: Only handles columns A-Z. For AA+ columns we'd need a proper col-to-letter converter.
        // Skipping for MVP since most sheets don't have 26+ columns.
        lines.push('  Col ' + String.fromCharCode(65 + (i % 26)) + ': "' + h + '" (' + type + ')');
      }
    });
  }

  if (context.sampleData && context.sampleData.length > 0) {
    lines.push('\nSample Data (first ' + context.sampleData.length + ' rows):');
    context.sampleData.forEach(function(row, i) {
      var rowStr = row.map(function(v) {
        if (v instanceof Date) return v.toLocaleDateString();
        if (v === '' || v === null) return '(empty)';
        return String(v);
      }).join(' | ');
      lines.push('  Row ' + (i + 2) + ': ' + rowStr);
    });
  }

  if (context.nearbyFormulas && context.nearbyFormulas.length > 0) {
    lines.push('\nFormulas near active cell:');
    context.nearbyFormulas.forEach(function(f) {
      lines.push('  ' + f.cell + ': ' + f.formula);
    });
  }

  if (context.namedRanges && context.namedRanges.length > 0) {
    lines.push('\nNamed Ranges:');
    context.namedRanges.forEach(function(r) {
      lines.push('  "' + r.name + '" -> ' + r.range);
    });
  }

  lines.push('=== END CONTEXT ===');
  return lines.join('\n');
}
