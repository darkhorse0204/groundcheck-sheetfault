/**
 * Tools.js — JSON Flattening
 *
 * Structured tool calling: every spreadsheet mutation and every external
 * HTTP call goes through ToolRegistry.js's executeTool_()/
 * executeStructuredToolCall_() — no agent calls SpreadsheetApp or
 * UrlFetchApp directly. This file used to also hold direct-execution
 * helpers (toolReadRange_, toolWriteRange_, toolGetMetadata_,
 * toolFetchExternalApi_, toolPostWebhook_) that duplicated what
 * ToolRegistry.js's read_cells/write_cells/inspect_workbook/fetch_api tools
 * already do properly (schema validation, undo checkpoints, header
 * filtering) — they've been removed now that nothing calls them.
 *
 * What's left here is the JSON flattener: a pure data transform (API
 * response -> 2D grid) with no SpreadsheetApp/UrlFetchApp calls of its own,
 * so it doesn't belong in ToolRegistry.js's tool catalogue — it's a helper
 * the fetch_api tool's caller uses to shape data before calling write_cells.
 */

// ============================================
// FLATTEN JSON → 2D ARRAY
// ============================================

// Converts a potentially nested JSON API response into a flat 2D array for spreadsheet injection.
// V1's version silently dropped any nested objects. This one uses dot-notation flattening:
//   { address: { city: "NYC" } } → column header becomes "address.city", value is "NYC"
//   Arrays get JSON.stringify()'d into the cell as a string (not ideal, but better than dropping them)
//
// TODO: Add an option to limit the number of rows injected (cap at 500?) so we don't
// hit the GAS 6-minute timeout on huge API responses.
function flattenJsonToGrid_(rawData) {
  // Step 1: Find the actual data array. API responses are inconsistent —
  // some return a raw array, some wrap it in { "results": [...] } or { "data": [...] }
  var dataArray;
  if (Array.isArray(rawData)) {
    dataArray = rawData;
  } else {
    // Hunt for the first array property — that's usually the data payload
    for (var key in rawData) {
      if (rawData.hasOwnProperty(key) && Array.isArray(rawData[key]) && rawData[key].length > 0) {
        dataArray = rawData[key];
        break;
      }
    }
    // No array found? Wrap the whole thing as a single-row result
    if (!dataArray) dataArray = [rawData];
  }

  if (dataArray.length === 0) {
    throw createError_(ErrorType.PARSE_ERROR, 'API returned empty data.');
  }

  // Step 2: Flatten each object
  var flattenedRows = dataArray.map(function(obj) { return flattenObject_(obj); });

  // Step 3: Collect all unique keys across all rows as column headers.
  // Different rows might have different keys (sparse data), so we union them.
  var headerSet = {};
  flattenedRows.forEach(function(flat) {
    Object.keys(flat).forEach(function(k) { headerSet[k] = true; });
  });
  var headers = Object.keys(headerSet);

  // Step 4: Build the 2D grid — headers as row 0, data below
  var grid = [headers];
  flattenedRows.forEach(function(flat) {
    var row = headers.map(function(h) {
      var val = flat[h];
      if (val === undefined || val === null) return '';
      if (typeof val === 'object') return JSON.stringify(val); // Fallback for anything we missed
      return val; // Preserve native types — numbers stay numbers, not strings
    });
    grid.push(row);
  });

  return grid;
}

// Recursive dot-notation flattener. Turns nested objects into flat key-value pairs.
// { user: { name: "Joe", address: { city: "NYC" } } }
//   → { "user.name": "Joe", "user.address.city": "NYC" }
// Arrays are stringified because you can't really represent an array in a single cell
// without serialization. Could improve this later with array expansion into multiple columns.
function flattenObject_(obj, prefix) {
  var result = {};
  prefix = prefix || '';
  for (var key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    var fullKey = prefix ? prefix + '.' + key : key;
    var val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      // Recurse into nested objects
      var nested = flattenObject_(val, fullKey);
      for (var nk in nested) {
        if (nested.hasOwnProperty(nk)) result[nk] = nested[nk];
      }
    } else if (Array.isArray(val)) {
      result[fullKey] = JSON.stringify(val);
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

// ============================================
// UNDO SUPPORT
// ============================================
//
// NOTE: The single-slot LAST_UNDO mechanism that used to live here
// (storePreviousValue_ / undoLastAction / hasUndoAvailable) has been removed.
// It collided with Code.js's ENTERPRISE-backed undoLastAction()/hasUndoAvailable()
// at the global GAS namespace level — both files declare top-level functions with
// the same name, and GAS silently lets the alphabetically-later file (Tools.js)
// win, which meant every write path that pushed onto ENTERPRISE.undo (the 10-level
// stack) was undone by a popper that only ever looked at a single PropertiesService
// key. All undo now goes through ENTERPRISE.undo (see Enterprise.js) — call
// ENTERPRISE.undo.push(description, sheetName, range) before a destructive write.
