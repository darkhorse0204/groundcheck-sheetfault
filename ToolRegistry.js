/**
 * ToolRegistry.js — Structured Tool Calling Engine
 *
 * Implements the four-gate pipeline described in the README's
 * "Tool architecture" section:
 *
 *   Gate 1 — REGISTRY LOOKUP    Does this tool name exist in TOOL_REGISTRY?
 *   Gate 2 — INPUT VALIDATION   Does args match the tool's inputSchema?
 *   Gate 3 — SECURITY CHECK     SSRF validation / formula validation / undo checkpoint
 *   Gate 4 — EXECUTION          The actual operation
 *
 * Every tool returns { ok: true, result } or { ok: false, error }. Tools never
 * throw — executeTool_() catches anything that slips through and converts it.
 *
 * One deliberate design choice worth calling out: undo checkpoints are taken
 * INSIDE each write tool's execute(), not generically in executeTool_()
 * before calling it. A generic pre-execute snapshot can only capture a single
 * cell before the tool has computed its actual destination range — that's
 * exactly the bug we used to have in Agents.js's agentFetchData_ (a snapshot
 * taken before the write range was known only ever restored 1/Nth of what was
 * overwritten). Gates 1-2 are centralized here; gate 3's specific security
 * action (SSRF check, undo, formula validation) is tool-specific and lives
 * with gate 4 inside each tool.
 */

// ============================================
// SECTION 1: SCHEMA VALIDATOR
// ============================================
// Lightweight JSON-Schema subset: type, required, properties, enum, minimum,
// maximum, minLength, maxLength, items, minItems, maxItems. Deliberately does
// NOT support $ref/anyOf/oneOf/allOf/pattern — no value for our tool schemas,
// only complexity.

function schemaTypeOf_(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null || value === undefined) return 'null';
  return typeof value;
}

function schemaTypeMatches_(actualType, expectedType) {
  if (expectedType === 'integer') return actualType === 'number';
  return actualType === expectedType;
}

function validateSchema_(value, schema, path) {
  path = path || 'args';
  var errors = [];

  if (schema.type) {
    var actualType = schemaTypeOf_(value);
    if (!schemaTypeMatches_(actualType, schema.type)) {
      errors.push('Schema violation at ' + path + ': expected ' + schema.type + ', got ' + actualType);
      return errors; // type mismatch makes deeper checks meaningless
    }
  }

  if (schema.enum && schema.enum.indexOf(value) === -1) {
    errors.push('Schema violation at ' + path + ': "' + value + '" not in allowed set [' + schema.enum.join(', ') + ']');
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push('Schema violation at ' + path + ': ' + value + ' is below minimum ' + schema.minimum);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push('Schema violation at ' + path + ': ' + value + ' exceeds maximum ' + schema.maximum);
    }
  }

  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push('Schema violation at ' + path + ': length ' + value.length + ' is below minLength ' + schema.minLength);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push('Schema violation at ' + path + ': length ' + value.length + ' exceeds maxLength ' + schema.maxLength);
    }
  }

  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push('Schema violation at ' + path + ': ' + value.length + ' items is below minItems ' + schema.minItems);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push('Schema violation at ' + path + ': ' + value.length + ' items exceeds maxItems ' + schema.maxItems);
    }
    if (schema.items) {
      for (var i = 0; i < value.length; i++) {
        errors = errors.concat(validateSchema_(value[i], schema.items, path + '[' + i + ']'));
      }
    }
  }

  if (schema.type === 'object' && schema.properties) {
    (schema.required || []).forEach(function (reqKey) {
      if (value[reqKey] === undefined || value[reqKey] === null) {
        errors.push('Schema violation at ' + path + '.' + reqKey + ': missing required field');
      }
    });
    Object.keys(schema.properties).forEach(function (key) {
      if (value[key] !== undefined) {
        errors = errors.concat(validateSchema_(value[key], schema.properties[key], path + '.' + key));
      }
    });
  }

  return errors;
}

// Entry point: validates a tool call's args object against its inputSchema
// (an object schema expressed as { properties, required } at the top level).
function validateToolArgs_(args, inputSchema) {
  var objSchema = { type: 'object', properties: inputSchema.properties || {}, required: inputSchema.required || [] };
  return validateSchema_(args || {}, objSchema, 'args');
}

// ============================================
// SECTION 2: SQL MINI-PARSER (run_sql)
// ============================================
// Supported grammar:
//   SELECT cols FROM table [WHERE cond (AND cond)*] [ORDER BY col [ASC|DESC]] [LIMIT n]
// Deliberately unsupported: OR, JOIN, GROUP BY, HAVING, subqueries, COUNT(*),
// SUM() — grouped aggregation is generate_pivot's job. "Limited" here is a
// security feature (no query-injection attack surface), not a shortcoming.

function parseSql_(query) {
  var trimmed = (query || '').trim();
  if (!/^select\s/i.test(trimmed)) {
    throw new Error('Only SELECT queries are supported.');
  }

  var m = trimmed.match(
    /^select\s+(.+?)\s+from\s+("[^"]+"|'[^']+'|[A-Za-z0-9_]+)(\s+where\s+(.+?))?(\s+order\s+by\s+([A-Za-z0-9_]+)(\s+(asc|desc))?)?(\s+limit\s+(\d+))?\s*$/i
  );
  if (!m) {
    throw new Error('Could not parse SQL query. Grammar: SELECT cols FROM table [WHERE cond] [ORDER BY col [ASC|DESC]] [LIMIT n]');
  }

  var selectClause = m[1].trim();
  var fromClause = m[2].replace(/^["']|["']$/g, '');
  var whereClause = m[4] ? m[4].trim() : null;
  var orderByCol = m[6] || null;
  var orderByDir = (m[8] || 'asc').toLowerCase();
  var limit = m[10] ? parseInt(m[10], 10) : null;

  var columns = selectClause === '*' ? ['*'] : selectClause.split(',').map(function (c) { return c.trim(); });
  var conditions = whereClause ? whereClause.split(/\s+and\s+/i).map(parseSqlCondition_) : [];

  return {
    columns: columns,
    from: fromClause,
    where: conditions,
    orderBy: orderByCol ? { column: orderByCol, direction: orderByDir } : null,
    limit: limit
  };
}

function parseSqlCondition_(expr) {
  expr = expr.trim();
  if (/\bis\s+not\s+null$/i.test(expr)) {
    return { column: expr.replace(/\bis\s+not\s+null$/i, '').trim(), op: 'IS NOT NULL', value: null };
  }
  if (/\bis\s+null$/i.test(expr)) {
    return { column: expr.replace(/\bis\s+null$/i, '').trim(), op: 'IS NULL', value: null };
  }
  var m = expr.match(/^([A-Za-z0-9_]+)\s*(!=|<>|>=|<=|=|>|<|contains)\s*(.+)$/i);
  if (!m) throw new Error('Could not parse WHERE condition: "' + expr + '"');

  var column = m[1];
  var op = m[2].toUpperCase();
  var rawValue = m[3].trim();
  var value;
  if (/^'.*'$/.test(rawValue) || /^".*"$/.test(rawValue)) {
    value = rawValue.substring(1, rawValue.length - 1);
  } else if (!isNaN(Number(rawValue))) {
    value = Number(rawValue);
  } else {
    throw new Error('Unsupported value literal in WHERE clause: "' + rawValue + '" (quote string values)');
  }
  return { column: column, op: op, value: value };
}

function evaluateSqlCondition_(row, headerIndex, cond) {
  var idx = headerIndex[cond.column.toLowerCase()];
  if (idx === undefined) throw new Error('Unknown column in WHERE clause: "' + cond.column + '"');
  var cell = row[idx];
  switch (cond.op) {
    case '=': return cell == cond.value; // eslint-disable-line eqeqeq
    case '!=':
    case '<>': return cell != cond.value; // eslint-disable-line eqeqeq
    case '>': return cell > cond.value;
    case '>=': return cell >= cond.value;
    case '<': return cell < cond.value;
    case '<=': return cell <= cond.value;
    case 'CONTAINS': return String(cell).toLowerCase().indexOf(String(cond.value).toLowerCase()) !== -1;
    case 'IS NULL': return cell === '' || cell === null || cell === undefined;
    case 'IS NOT NULL': return !(cell === '' || cell === null || cell === undefined);
    default: throw new Error('Unsupported operator: ' + cond.op);
  }
}

function runSql_(args) {
  var parsed;
  try {
    parsed = parseSql_(args.query);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(parsed.from);
  if (!sheet) {
    return { ok: false, error: 'Sheet "' + parsed.from + '" does not exist. Use search_headers to find the right sheet.' };
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return { ok: true, result: { headers: [], rows: [], rowCount: 0, totalMatched: 0, truncated: false, query: args.query, outputRange: null } };
  }

  var allValues = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var sheetHeaders = allValues[0];
  var headerIndex = {};
  sheetHeaders.forEach(function (h, i) { headerIndex[String(h).toLowerCase()] = i; });

  var selectedColumns = parsed.columns[0] === '*' ? sheetHeaders.slice() : parsed.columns;
  var selectedIndexes = [];
  for (var c = 0; c < selectedColumns.length; c++) {
    var idx = headerIndex[selectedColumns[c].toLowerCase()];
    if (idx === undefined) {
      return { ok: false, error: 'Unknown column in SELECT: "' + selectedColumns[c] + '". Available: ' + sheetHeaders.join(', ') };
    }
    selectedIndexes.push(idx);
  }

  var dataRows = allValues.slice(1);
  var filtered;
  try {
    filtered = dataRows.filter(function (row) {
      return parsed.where.every(function (cond) { return evaluateSqlCondition_(row, headerIndex, cond); });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (parsed.orderBy) {
    var orderIdx = headerIndex[parsed.orderBy.column.toLowerCase()];
    if (orderIdx === undefined) return { ok: false, error: 'Unknown column in ORDER BY: "' + parsed.orderBy.column + '"' };
    var dir = parsed.orderBy.direction === 'desc' ? -1 : 1;
    filtered.sort(function (a, b) {
      if (a[orderIdx] < b[orderIdx]) return -1 * dir;
      if (a[orderIdx] > b[orderIdx]) return 1 * dir;
      return 0;
    });
  }

  var totalMatched = filtered.length;
  var maxRows = Math.min(args.maxRows || 500, 2000);
  var effectiveLimit = parsed.limit ? Math.min(parsed.limit, maxRows) : maxRows;
  var limited = filtered.slice(0, effectiveLimit);

  var resultRows = limited.map(function (row) {
    return selectedIndexes.map(function (i) { return row[i]; });
  });

  var outputRange = null;
  if (args.outputSheet) {
    var outSheet = ss.getSheetByName(args.outputSheet) || ss.insertSheet(args.outputSheet);
    var startCell = outSheet.getRange(args.outputCell || 'A1');
    var grid = [selectedColumns].concat(resultRows);
    var range = outSheet.getRange(startCell.getRow(), startCell.getColumn(), grid.length, grid[0].length || 1);
    ENTERPRISE.undo.push('run_sql output', outSheet.getName(), range.getA1Notation());
    range.setValues(grid);
    outputRange = range.getA1Notation();
  }

  return {
    ok: true,
    result: {
      headers: selectedColumns,
      rows: resultRows,
      rowCount: resultRows.length,
      totalMatched: totalMatched,
      truncated: resultRows.length < totalMatched,
      query: args.query,
      outputRange: outputRange
    }
  };
}

// ============================================
// SECTION 3: PIVOT BUILDER (generate_pivot)
// ============================================

var PIVOT_AGGREGATIONS_ = {
  SUM: function (values) { return values.reduce(function (a, b) { return a + b; }, 0); },
  COUNT: function (values) { return values.length; },
  AVERAGE: function (values) { return values.length ? values.reduce(function (a, b) { return a + b; }, 0) / values.length : 0; },
  MAX: function (values) { return values.length ? Math.max.apply(null, values) : 0; },
  MIN: function (values) { return values.length ? Math.min.apply(null, values) : 0; }
};

function generatePivot_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sourceSheet = ss.getSheetByName(args.sourceSheet);
  if (!sourceSheet) return { ok: false, error: 'sourceSheet "' + args.sourceSheet + '" does not exist.' };

  var sourceRange;
  try {
    sourceRange = sourceSheet.getRange(args.sourceRange);
  } catch (e) {
    return { ok: false, error: 'Invalid sourceRange "' + args.sourceRange + '": ' + e.message };
  }

  var values = sourceRange.getValues();
  if (values.length < 2) return { ok: false, error: 'sourceRange must include a header row plus at least one data row.' };

  var headers = values[0];
  var headerIndex = {};
  headers.forEach(function (h, i) { headerIndex[String(h).toLowerCase()] = i; });

  var rowIdx = headerIndex[args.rowField.toLowerCase()];
  if (rowIdx === undefined) return { ok: false, error: 'rowField "' + args.rowField + '" not found in header row.' };
  var valueIdx = headerIndex[args.valueField.toLowerCase()];
  if (valueIdx === undefined) return { ok: false, error: 'valueField "' + args.valueField + '" not found in header row.' };
  var colIdx = null;
  if (args.colField) {
    colIdx = headerIndex[args.colField.toLowerCase()];
    if (colIdx === undefined) return { ok: false, error: 'colField "' + args.colField + '" not found in header row.' };
  }

  var aggFn = PIVOT_AGGREGATIONS_[args.aggregation];
  if (!aggFn) return { ok: false, error: 'Unknown aggregation "' + args.aggregation + '". Use SUM, COUNT, AVERAGE, MAX, or MIN.' };

  var pivot = {};
  var rowKeys = [], colKeys = [], seenRow = {}, seenCol = {};

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var rowKey = String(row[rowIdx]);
    var colKey = colIdx !== null ? String(row[colIdx]) : 'value';
    var val = Number(row[valueIdx]) || 0;

    if (!seenRow[rowKey]) { seenRow[rowKey] = true; rowKeys.push(rowKey); }
    if (!seenCol[colKey]) { seenCol[colKey] = true; colKeys.push(colKey); }

    pivot[rowKey] = pivot[rowKey] || {};
    pivot[rowKey][colKey] = pivot[rowKey][colKey] || [];
    pivot[rowKey][colKey].push(val);
  }

  rowKeys.sort();
  colKeys.sort();

  var headerRow = colIdx !== null ? [''].concat(colKeys) : [args.rowField, args.valueField];
  var grid = [headerRow];
  rowKeys.forEach(function (rowKey) {
    var outRow = [rowKey];
    colKeys.forEach(function (colKey) {
      var bucket = (pivot[rowKey] && pivot[rowKey][colKey]) || [];
      outRow.push(aggFn(bucket));
    });
    grid.push(outRow);
  });

  if (args.includeGrandTotal !== false) {
    var totalRow = ['Grand Total'];
    colKeys.forEach(function (colKey) {
      var allValsForCol = [];
      rowKeys.forEach(function (rowKey) {
        allValsForCol = allValsForCol.concat((pivot[rowKey] && pivot[rowKey][colKey]) || []);
      });
      totalRow.push(aggFn(allValsForCol));
    });
    grid.push(totalRow);
  }

  var outputSheetName = args.outputSheet || ('Pivot_' + new Date().getTime());
  var outSheet = ss.getSheetByName(outputSheetName);
  var isNewSheet = !outSheet;
  if (!outSheet) outSheet = ss.insertSheet(outputSheetName);

  var startCell = outSheet.getRange(args.outputCell || 'A1');
  var range = outSheet.getRange(startCell.getRow(), startCell.getColumn(), grid.length, grid[0].length);

  if (isNewSheet) {
    ENTERPRISE.audit.record({ type: 'SHEET_CREATED', sheetName: outputSheetName, tool: 'generate_pivot' });
  } else {
    ENTERPRISE.undo.push('generate_pivot output', outSheet.getName(), range.getA1Notation());
  }

  range.setValues(grid);
  try { outSheet.getRange(startCell.getRow(), startCell.getColumn(), 1, grid[0].length).setFontWeight('bold'); } catch (e) { /* formatting is best-effort */ }

  return {
    ok: true,
    result: {
      outputSheet: outputSheetName,
      outputRange: range.getA1Notation(),
      rowCount: rowKeys.length,
      colCount: colKeys.length,
      rowField: args.rowField,
      colField: args.colField || null,
      valueField: args.valueField,
      aggregation: args.aggregation
    }
  };
}

// ============================================
// SECTION 4: DASHBOARD BUILDER (generate_dashboard)
// ============================================

function generateDashboard_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sourceSheet = ss.getSheetByName(args.sourceSheet);
  if (!sourceSheet) return { ok: false, error: 'sourceSheet "' + args.sourceSheet + '" does not exist.' };

  var outputSheetName = args.outputSheet || 'Dashboard';
  var existing = ss.getSheetByName(outputSheetName);
  if (existing && !args.overwrite) {
    return { ok: false, error: 'Sheet "' + outputSheetName + '" already exists. Pass overwrite=true to replace it.' };
  }

  // Validate every metric BEFORE creating or mutating the output sheet. A
  // validation failure must never leave a half-built dashboard sheet behind —
  // that would then block a subsequent legitimate call with a spurious
  // "already exists" error.
  var context = buildDeepContext();
  for (var v = 0; v < args.metrics.length; v++) {
    // metrics are written to column B of the output sheet, starting at row 4
    var precheck = verifyFormula_(args.metrics[v].formula, targetContext_(context, outputSheetName, 'B' + (4 + v)));
    if (!precheck.valid) {
      return { ok: false, error: 'Metric "' + args.metrics[v].label + '" formula failed validation: ' + precheck.errors.join('; ') };
    }
  }

  var dashSheet = existing || ss.insertSheet(outputSheetName);
  if (existing) {
    ENTERPRISE.audit.record({ type: 'DASHBOARD_OVERWRITE', sheetName: outputSheetName });
  } else {
    ENTERPRISE.audit.record({ type: 'SHEET_CREATED', sheetName: outputSheetName, tool: 'generate_dashboard' });
  }

  dashSheet.getRange(1, 1).setValue(args.title);

  var row = 3;
  dashSheet.getRange(row, 1).setValue('METRICS');
  row++;

  var metricsAdded = 0;
  for (var i = 0; i < args.metrics.length; i++) {
    var metric = args.metrics[i];
    dashSheet.getRange(row, 1).setValue(metric.label);
    dashSheet.getRange(row, 2).setFormula(metric.formula);
    metricsAdded++;
    row++;
  }

  row += 1; // spacer before charts

  var chartsCreated = 0;
  var charts = args.charts || [];
  for (var c = 0; c < charts.length; c++) {
    var chartSpec = charts[c];
    var chartResult = createChart_({
      dataRange: chartSpec.dataRange,
      chartType: chartSpec.chartType,
      title: chartSpec.title,
      targetSheet: outputSheetName,
      anchorCell: 'A' + row
    });
    if (!chartResult.ok) {
      return { ok: false, error: 'Chart "' + chartSpec.title + '" failed: ' + chartResult.error };
    }
    chartsCreated++;
    row += 15; // stack charts vertically
  }

  ENTERPRISE.ops.record({
    type: 'generate_dashboard',
    description: 'Created dashboard "' + outputSheetName + '" (' + metricsAdded + ' metrics, ' + chartsCreated + ' charts)',
    sheetName: outputSheetName,
    undoable: false
  });

  return {
    ok: true,
    result: {
      dashboardSheet: outputSheetName,
      metricsAdded: metricsAdded,
      chartsCreated: chartsCreated,
      layout: 'Title at A1, metrics from A4, charts stacked below starting row ' + (row - chartsCreated * 15)
    }
  };
}

// ============================================
// SECTION 5: HEADER SECURITY (fetch_api)
// ============================================

var FETCH_HEADER_BLOCKLIST_ = [
  /^host$/i,
  /^x-forwarded-for$/i,
  /^x-forwarded-host$/i,
  /^x-real-ip$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^transfer-encoding$/i,
  /^content-length$/i
];

// Splits caller-supplied headers into { allowed, blocked }. Basic-auth
// Authorization values are blocked too — credentials must not travel through
// the tool system; Bearer tokens are fine.
function filterRequestHeaders_(headers) {
  var allowed = {};
  var blocked = [];
  Object.keys(headers || {}).forEach(function (key) {
    var isBlocked = FETCH_HEADER_BLOCKLIST_.some(function (p) { return p.test(key); });
    if (!isBlocked && /^authorization$/i.test(key) && /^\s*basic\s/i.test(String(headers[key]))) {
      isBlocked = true;
    }
    if (isBlocked) {
      blocked.push(key);
    } else {
      allowed[key] = headers[key];
    }
  });
  return { allowed: allowed, blocked: blocked };
}

// ============================================
// TOOL IMPLEMENTATIONS (1, 3, 5, 8, 9 use plain SpreadsheetApp calls;
// 2, 4, 6, 7, 10, 11 are the more involved ones defined above)
// ============================================

function parseA1Cell_(a1) {
  var m = String(a1).match(/^([A-Za-z]+)(\d+)$/);
  if (!m) throw new Error('Invalid cell reference: ' + a1);
  var letters = m[1].toUpperCase();
  var col = 0;
  for (var i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  return { row: parseInt(m[2], 10), col: col };
}

function readCells_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = args.sheet ? ss.getSheetByName(args.sheet) : ss.getActiveSheet();
  if (!sheet) return { ok: false, error: 'Sheet "' + args.sheet + '" does not exist.' };

  var range;
  try { range = sheet.getRange(args.range); } catch (e) { return { ok: false, error: 'Invalid range "' + args.range + '": ' + e.message }; }

  var maxRows = Math.min(args.maxRows || 500, 1000);
  if (range.getNumRows() > maxRows) {
    range = sheet.getRange(range.getRow(), range.getColumn(), maxRows, range.getNumColumns());
  }

  var result = {
    values: range.getValues().map(function (row) {
      return row.map(function (v) { return v instanceof Date ? v.toISOString() : v; });
    }),
    rowCount: range.getNumRows(),
    colCount: range.getNumColumns(),
    sheetName: sheet.getName()
  };
  if (args.includeFormulas) result.formulas = range.getFormulas();

  return { ok: true, result: result };
}

function writeCells_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = args.sheet ? ss.getSheetByName(args.sheet) : ss.getActiveSheet();
  if (!sheet) return { ok: false, error: 'Sheet "' + args.sheet + '" does not exist.' };

  var values = args.values;
  var colCount = values.length > 0 ? values[0].length : 0;
  for (var i = 0; i < values.length; i++) {
    if (!Array.isArray(values[i]) || values[i].length !== colCount) {
      return { ok: false, error: 'Row ' + (i + 1) + ' has inconsistent column count (expected ' + colCount + ').' };
    }
  }
  if (colCount === 0) return { ok: false, error: 'values must contain at least one row with at least one column.' };

  var startCell;
  try { startCell = sheet.getRange(args.range); } catch (e) { return { ok: false, error: 'Invalid range "' + args.range + '": ' + e.message }; }

  var destRange = sheet.getRange(startCell.getRow(), startCell.getColumn(), values.length, colCount);
  ENTERPRISE.undo.push('write_cells', sheet.getName(), destRange.getA1Notation());
  destRange.setValues(values);

  return {
    ok: true,
    result: {
      success: true,
      range: destRange.getA1Notation(),
      rowsWritten: values.length,
      colsWritten: colCount,
      sheetName: sheet.getName()
    }
  };
}

function readFormulaTool_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = args.sheet ? ss.getSheetByName(args.sheet) : ss.getActiveSheet();
  if (!sheet) return { ok: false, error: 'Sheet "' + args.sheet + '" does not exist.' };

  var cell;
  try { cell = sheet.getRange(args.cell); } catch (e) { return { ok: false, error: 'Invalid cell "' + args.cell + '": ' + e.message }; }

  var formula = cell.getFormula();
  return {
    ok: true,
    result: {
      cell: args.cell,
      formula: formula || '',
      value: cell.getValue(),
      hasFormula: !!formula,
      sheetName: sheet.getName()
    }
  };
}

function insertFormulaTool_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = args.sheet ? ss.getSheetByName(args.sheet) : ss.getActiveSheet();
  if (!sheet) return { ok: false, error: 'Sheet "' + args.sheet + '" does not exist.' };

  // judge circularity against the cell actually being written, not the active cell
  var verification = verifyFormula_(args.formula, targetContext_(buildDeepContext(), sheet.getName(), args.cell));
  if (!verification.valid) {
    return { ok: false, error: 'Formula failed validation: ' + verification.errors.join('; ') };
  }

  var cell;
  try { cell = sheet.getRange(args.cell); } catch (e) { return { ok: false, error: 'Invalid cell "' + args.cell + '": ' + e.message }; }

  ENTERPRISE.undo.push('insert_formula', sheet.getName(), cell.getA1Notation());
  cell.setFormula(args.formula);

  return {
    ok: true,
    result: {
      cell: args.cell,
      formula: args.formula,
      computedValue: cell.getValue(),
      verified: true,
      warnings: verification.warnings,
      sheetName: sheet.getName()
    }
  };
}

function createChart_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sourceSheet = args.sheet ? ss.getSheetByName(args.sheet) : ss.getActiveSheet();
  if (!sourceSheet) return { ok: false, error: 'Sheet "' + (args.sheet || '') + '" does not exist.' };

  var dataRange;
  try { dataRange = sourceSheet.getRange(args.dataRange); } catch (e) { return { ok: false, error: 'Invalid dataRange "' + args.dataRange + '": ' + e.message }; }

  var targetSheet = args.targetSheet ? ss.getSheetByName(args.targetSheet) : sourceSheet;
  if (!targetSheet) return { ok: false, error: 'targetSheet "' + args.targetSheet + '" does not exist.' };

  var builderMethodMap = {
    BAR: 'asBarChart', LINE: 'asLineChart', PIE: 'asPieChart',
    COLUMN: 'asColumnChart', AREA: 'asAreaChart', SCATTER: 'asScatterChart'
  };
  var builderMethod = builderMethodMap[args.chartType];
  if (!builderMethod) return { ok: false, error: 'Unknown chartType "' + args.chartType + '". Use BAR, LINE, PIE, COLUMN, AREA, or SCATTER.' };

  var anchor = args.anchorCell ? parseA1Cell_(args.anchorCell) : { row: targetSheet.getLastRow() + 2, col: 1 };

  var builder = targetSheet.newChart()[builderMethod]();
  builder.addRange(dataRange);
  builder.setPosition(anchor.row, anchor.col, 0, 0);
  builder.setOption('title', args.title);
  if (args.xAxisLabel) builder.setOption('hAxis.title', args.xAxisLabel);
  if (args.yAxisLabel) builder.setOption('vAxis.title', args.yAxisLabel);

  var chart = builder.build();
  targetSheet.insertChart(chart);

  ENTERPRISE.ops.record({
    type: 'create_chart',
    description: 'Created ' + args.chartType + ' chart "' + args.title + '" on ' + targetSheet.getName(),
    sheetName: targetSheet.getName(),
    undoable: false
  });

  return {
    ok: true,
    result: {
      chartId: chart.getChartId(),
      chartType: args.chartType,
      title: args.title,
      dataRange: dataRange.getA1Notation(),
      anchorCell: args.anchorCell || (String.fromCharCode(64 + anchor.col) + anchor.row),
      sheetName: targetSheet.getName()
    }
  };
}

function fetchApiTool_(args) {
  var safeUrl;
  try {
    safeUrl = validateUrl_(args.url);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var headerFilter = filterRequestHeaders_(args.headers || {});

  if (args.body) {
    try { JSON.parse(args.body); } catch (e) { return { ok: false, error: 'body is not valid JSON.' }; }
  }

  // followRedirects:false — UrlFetchApp would otherwise follow a 30x to an internal
  // address after we validated the original URL. We follow redirects ourselves and
  // re-validate every hop (see the loop below).
  var fetchOptions = { method: (args.method || 'GET').toLowerCase(), headers: headerFilter.allowed, muteHttpExceptions: true, followRedirects: false };
  if (args.body) {
    fetchOptions.contentType = 'application/json';
    fetchOptions.payload = args.body;
  }

  var response;
  try {
    response = UrlFetchApp.fetch(safeUrl, fetchOptions);

    var hops = 0, currentUrl = safeUrl;
    while ([301, 302, 303, 307, 308].indexOf(response.getResponseCode()) !== -1 && hops < 3) {
      var respHeaders = typeof response.getAllHeaders === 'function' ? response.getAllHeaders() : (typeof response.getHeaders === 'function' ? response.getHeaders() : {});
      var location = respHeaders && (respHeaders['Location'] || respHeaders['location']);
      if (!location) break;
      var nextUrl = absolutizeUrl_(location, currentUrl);
      try { validateUrl_(nextUrl); } catch (blocked) { return { ok: false, error: 'Redirect blocked: ' + blocked.message }; }
      currentUrl = nextUrl;
      response = UrlFetchApp.fetch(currentUrl, { method: 'get', muteHttpExceptions: true, followRedirects: false });
      hops++;
    }
  } catch (e) {
    return { ok: false, error: 'Fetch failed: ' + e.message };
  }

  var statusCode = response.getResponseCode();
  var contentTypeHeader = '';
  try {
    var allHeaders = typeof response.getAllHeaders === 'function' ? response.getAllHeaders() : {};
    contentTypeHeader = allHeaders['Content-Type'] || allHeaders['content-type'] || '';
  } catch (e) { /* not every response mock implements getAllHeaders */ }

  var bodyText = response.getContentText();
  var data;
  var isJson = contentTypeHeader.indexOf('application/json') !== -1 || contentTypeHeader === '';
  if (isJson) {
    // Many webhook receivers (Zapier, Make, n8n) return 200 with an empty
    // body on success — that's not "invalid JSON", it's "no body". Only
    // attempt to parse when there's actually something to parse.
    if (!bodyText || !bodyText.trim()) {
      data = null;
    } else {
      try { data = JSON.parse(bodyText); } catch (e) { return { ok: false, error: 'Response was not valid JSON.' }; }
    }
  } else if (contentTypeHeader.indexOf('text/plain') !== -1 || contentTypeHeader.indexOf('text/csv') !== -1) {
    data = bodyText;
  } else {
    return { ok: false, error: 'Unsupported content type: ' + contentTypeHeader };
  }

  var maxRows = Math.min(args.maxRows || 200, 1000);
  var rowCount, schema, truncated = false;
  if (Array.isArray(data)) {
    rowCount = data.length;
    if (data.length > maxRows) { data = data.slice(0, maxRows); truncated = true; }
    schema = data.length > 0 && data[0] !== null && typeof data[0] === 'object' ? Object.keys(data[0]) : undefined;
  }

  return {
    ok: true,
    result: {
      statusCode: statusCode,
      data: data,
      rowCount: rowCount,
      schema: schema,
      truncated: truncated,
      blockedHeaders: headerFilter.blocked,
      contentType: contentTypeHeader
    }
  };
}

function searchHeadersTool_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allSheets = ss.getSheets();
  var targetSheets = args.sheets && args.sheets.length > 0
    ? allSheets.filter(function (s) { return args.sheets.indexOf(s.getName()) !== -1; })
    : allSheets;

  var matchType = args.matchType || 'contains';
  var query = args.query.toLowerCase();
  var matches = [];
  var totalHeaders = 0;

  targetSheets.forEach(function (sheet) {
    var lastCol = sheet.getLastColumn();
    var lastRow = sheet.getLastRow();
    if (lastCol === 0) return;
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    totalHeaders += headers.filter(Boolean).length;
    var types = inferColumnTypes_(sheet, lastRow, lastCol);

    headers.forEach(function (h, i) {
      if (!h) return;
      var headerLower = String(h).toLowerCase();
      var isMatch =
        matchType === 'exact' ? headerLower === query :
        matchType === 'fuzzy' ? query.split(/\s+/).some(function (w) { return headerLower.indexOf(w) !== -1; }) :
        headerLower.indexOf(query) !== -1;
      if (!isMatch) return;

      var sampleValues = [];
      if (lastRow > 1) {
        var sampleCount = Math.min(3, lastRow - 1);
        sampleValues = sheet.getRange(2, i + 1, sampleCount, 1).getValues().map(function (r) { return r[0]; });
      }

      matches.push({
        header: h,
        column: colIndexToLetter_(i + 1),
        columnIndex: i,
        sheet: sheet.getName(),
        type: types[h] || 'unknown',
        sampleValues: sampleValues
      });
    });
  });

  return { ok: true, result: { matches: matches, totalSheets: targetSheets.length, totalHeaders: totalHeaders } };
}

function inspectWorkbookTool_(args) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var allSheets = ss.getSheets();

  var sheetsOut = allSheets
    .filter(function (s) {
      if (args.sheetFilter && args.sheetFilter.length > 0) return args.sheetFilter.indexOf(s.getName()) !== -1;
      return true;
    })
    .filter(function (s) {
      var hidden = typeof s.isSheetHidden === 'function' ? s.isSheetHidden() : false;
      return args.includeHidden ? true : !hidden;
    })
    .map(function (s) {
      var lastRow = s.getLastRow();
      var lastCol = s.getLastColumn();
      var headers = lastCol > 0 ? s.getRange(1, 1, 1, lastCol).getValues()[0] : [];
      return {
        name: s.getName(),
        index: s.getIndex(),
        hidden: typeof s.isSheetHidden === 'function' ? s.isSheetHidden() : false,
        rowCount: lastRow,
        colCount: lastCol,
        frozenRows: typeof s.getFrozenRows === 'function' ? s.getFrozenRows() : 0,
        headers: headers,
        columnTypes: inferColumnTypes_(s, lastRow, lastCol),
        hasCharts: typeof s.getCharts === 'function' ? s.getCharts().length > 0 : false,
        hasPivots: false,
        tables: []
      };
    });

  return {
    ok: true,
    result: {
      title: ss.getName(),
      locale: typeof ss.getSpreadsheetLocale === 'function' ? ss.getSpreadsheetLocale() : 'en_US',
      timeZone: typeof ss.getSpreadsheetTimeZone === 'function' ? ss.getSpreadsheetTimeZone() : 'Etc/GMT',
      sheetCount: sheetsOut.length,
      sheets: sheetsOut,
      namedRanges: ss.getNamedRanges().map(function (r) { return { name: r.getName(), range: r.getRange().getA1Notation() }; }),
      charts: args.includeCharts === false ? [] : []
    }
  };
}

// ============================================
// SECTION 6: TOOL_REGISTRY — the 11 tools
// ============================================

var TOOL_REGISTRY = {
  read_cells: {
    description: 'Read values (and optionally formulas) from any range in any sheet.',
    isDestructive: false,
    inputSchema: {
      required: ['range'],
      properties: {
        sheet: { type: 'string', description: 'Sheet name. Defaults to active sheet.' },
        range: { type: 'string', description: 'A1 notation, e.g. "A1:E10".' },
        includeFormulas: { type: 'boolean' },
        maxRows: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    },
    execute: readCells_
  },

  write_cells: {
    description: 'Write a 2D array of values to a range. Formula strings ("=...") are written as formulas.',
    isDestructive: true,
    inputSchema: {
      required: ['range', 'values'],
      properties: {
        sheet: { type: 'string' },
        range: { type: 'string', description: 'Top-left cell A1 notation, e.g. "A1".' },
        values: { type: 'array', items: { type: 'array' } }
      }
    },
    execute: writeCells_
  },

  read_formula: {
    description: 'Read the formula and computed value of a single cell.',
    isDestructive: false,
    inputSchema: {
      required: ['cell'],
      properties: { sheet: { type: 'string' }, cell: { type: 'string' } }
    },
    execute: readFormulaTool_
  },

  insert_formula: {
    description: 'Insert a single validated formula into a specific cell.',
    isDestructive: true,
    isFormula: true,
    inputSchema: {
      required: ['cell', 'formula'],
      properties: {
        cell: { type: 'string' },
        formula: { type: 'string', maxLength: 4000 },
        sheet: { type: 'string' }
      }
    },
    execute: insertFormulaTool_
  },

  create_chart: {
    description: 'Create a chart on a sheet using a data range.',
    isDestructive: true,
    inputSchema: {
      required: ['dataRange', 'chartType', 'title'],
      properties: {
        dataRange: { type: 'string' },
        chartType: { type: 'string', enum: ['BAR', 'LINE', 'PIE', 'COLUMN', 'AREA', 'SCATTER'] },
        title: { type: 'string', maxLength: 100 },
        sheet: { type: 'string' },
        targetSheet: { type: 'string' },
        anchorCell: { type: 'string' },
        xAxisLabel: { type: 'string' },
        yAxisLabel: { type: 'string' },
        hasHeaders: { type: 'boolean' }
      }
    },
    execute: createChart_
  },

  fetch_api: {
    description: 'Perform an HTTP request to an external endpoint and return structured data.',
    isDestructive: false,
    isExternal: true,
    inputSchema: {
      required: ['url'],
      properties: {
        url: { type: 'string', maxLength: 500 },
        method: { type: 'string', enum: ['GET', 'POST'] },
        headers: { type: 'object' },
        body: { type: 'string' },
        maxRows: { type: 'integer', minimum: 1, maximum: 1000 }
      }
    },
    execute: fetchApiTool_
  },

  run_sql: {
    description: 'Execute a read-only SQL SELECT query over sheet data in memory.',
    isDestructive: false,
    inputSchema: {
      required: ['query'],
      properties: {
        query: { type: 'string', maxLength: 500 },
        outputSheet: { type: 'string' },
        outputCell: { type: 'string' },
        maxRows: { type: 'integer', minimum: 1, maximum: 2000 }
      }
    },
    execute: runSql_
  },

  search_headers: {
    description: 'Find column headers across all sheets that match a query.',
    isDestructive: false,
    inputSchema: {
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        sheets: { type: 'array', items: { type: 'string' } },
        matchType: { type: 'string', enum: ['exact', 'contains', 'fuzzy'] }
      }
    },
    execute: searchHeadersTool_
  },

  inspect_workbook: {
    description: "Return a structural overview of the workbook — the agent's map before deciding where to operate.",
    isDestructive: false,
    inputSchema: {
      required: [],
      properties: {
        includeHidden: { type: 'boolean' },
        includeCharts: { type: 'boolean' },
        sheetFilter: { type: 'array', items: { type: 'string' } }
      }
    },
    execute: inspectWorkbookTool_
  },

  generate_pivot: {
    description: 'Create a pivot table from sheet data: group by rowField, optionally cross-tabulate by colField, aggregate valueField.',
    isDestructive: true,
    inputSchema: {
      required: ['sourceSheet', 'sourceRange', 'rowField', 'valueField', 'aggregation'],
      properties: {
        sourceSheet: { type: 'string' },
        sourceRange: { type: 'string' },
        rowField: { type: 'string' },
        colField: { type: 'string' },
        valueField: { type: 'string' },
        aggregation: { type: 'string', enum: ['SUM', 'COUNT', 'AVERAGE', 'MAX', 'MIN'] },
        outputSheet: { type: 'string' },
        outputCell: { type: 'string' },
        includeGrandTotal: { type: 'boolean' }
      }
    },
    execute: generatePivot_
  },

  generate_dashboard: {
    description: 'Create a formatted dashboard sheet with metric cards and charts.',
    isDestructive: true,
    isFormula: true,
    inputSchema: {
      required: ['title', 'sourceSheet', 'metrics'],
      properties: {
        title: { type: 'string', maxLength: 80 },
        sourceSheet: { type: 'string' },
        metrics: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            required: ['label', 'formula'],
            properties: { label: { type: 'string' }, formula: { type: 'string' }, format: { type: 'string' } }
          }
        },
        charts: {
          type: 'array', maxItems: 6,
          items: {
            type: 'object',
            required: ['dataRange', 'chartType', 'title'],
            properties: {
              dataRange: { type: 'string' },
              chartType: { type: 'string', enum: ['BAR', 'LINE', 'PIE', 'COLUMN', 'AREA', 'SCATTER'] },
              title: { type: 'string' }
            }
          }
        },
        outputSheet: { type: 'string' },
        overwrite: { type: 'boolean' }
      }
    },
    execute: generateDashboard_
  }
};

// ============================================
// SECTION 7: PUBLIC API
// ============================================

/**
 * The single dispatch entry point. Runs gates 1-2 here; gate 3's specific
 * security action and gate 4's execution both live inside tool.execute()
 * (see file header for why). Never throws.
 */
function executeTool_(name, args) {
  var tool = TOOL_REGISTRY[name];
  if (!tool) return { ok: false, error: 'Unknown tool: "' + name + '"' };

  var errors = validateToolArgs_(args || {}, tool.inputSchema);
  if (errors.length > 0) return { ok: false, error: errors[0] };

  try {
    return tool.execute(args || {});
  } catch (e) {
    logError_('ToolRegistry', 'Tool execution threw: ' + name, { error: e.message });
    return { ok: false, error: 'Tool "' + name + '" failed: ' + e.message };
  }
}

// ============================================
// STRUCTURED TOOL CALLING
// ============================================
//
// Every operation an agent performs is expressed as one structured call:
//   { tool_name, arguments, expected_output, verification }
// No agent calls SpreadsheetApp or UrlFetchApp directly — everything goes
// through executeStructuredToolCall_(), which wraps executeTool_()'s four
// gates with an explicit verification step:
//
//   expected_output — optional plain object of expected result fields.
//     Each key is compared (deep-equal) against the actual result; any
//     mismatch fails verification without failing the underlying tool call
//     itself (the operation still happened — verification just flags that
//     it didn't produce what was expected).
//   verification — optional custom predicate: function(result) -> a value
//     that's falsy, or an object; verification passes unless the function
//     throws or returns an object with `passed: false` explicitly.
//
// The returned record always has the same shape regardless of tool, so
// callers (and a future Observability layer) can log/inspect every
// operation uniformly.

/** Pure: compares expected_output's keys against the actual result. */
function checkExpectedOutput_(result, expectedOutput) {
  if (!expectedOutput) return { checked: false, passed: true, mismatches: [] };

  var mismatches = [];
  Object.keys(expectedOutput).forEach(function (key) {
    var expected = expectedOutput[key];
    var actual = result ? result[key] : undefined;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push({ key: key, expected: expected, actual: actual });
    }
  });

  return { checked: true, passed: mismatches.length === 0, mismatches: mismatches };
}

/** Runs a caller-supplied verification predicate against the tool's result. Never throws. */
function runCustomVerification_(result, verification) {
  if (!verification || typeof verification !== 'function') {
    return { ran: false, passed: true, details: null };
  }
  try {
    var details = verification(result);
    var passed = !(details && details.passed === false);
    return { ran: true, passed: passed, details: details === undefined ? null : details };
  } catch (e) {
    return { ran: true, passed: false, details: { error: e.message } };
  }
}

/**
 * Executes one structured tool call end-to-end: dispatch through
 * executeTool_() (gates 1-4), then check expected_output and run any custom
 * verification. Returns a uniform record — never throws.
 *
 * @param {{tool_name: string, arguments: object, expected_output: ?object, verification: ?function}} call
 */
function executeStructuredToolCall_(call) {
  if (!call || !call.tool_name) {
    return {
      tool_name: call && call.tool_name, arguments: call && call.arguments,
      ok: false, error: 'Structured tool call is missing tool_name', result: null,
      verification: { passed: false, expectedOutputCheck: { checked: false, passed: false, mismatches: [] }, customCheck: { ran: false, passed: false, details: null } }
    };
  }

  var dispatch = executeTool_(call.tool_name, call.arguments || {});

  var expectedOutputCheck = dispatch.ok
    ? checkExpectedOutput_(dispatch.result, call.expected_output)
    : { checked: false, passed: false, mismatches: [] };
  var customCheck = dispatch.ok
    ? runCustomVerification_(dispatch.result, call.verification)
    : { ran: false, passed: false, details: null };

  var record = {
    tool_name: call.tool_name,
    arguments: call.arguments || {},
    expected_output: call.expected_output || null,
    ok: dispatch.ok,
    error: dispatch.ok ? null : dispatch.error,
    result: dispatch.ok ? dispatch.result : null,
    verification: {
      passed: dispatch.ok && expectedOutputCheck.passed && customCheck.passed,
      expectedOutputCheck: expectedOutputCheck,
      customCheck: customCheck
    }
  };

  logInfo_('ToolRegistry', 'Structured tool call', { tool_name: record.tool_name, ok: record.ok, verified: record.verification.passed });
  Observability.toolCall(record);
  Observability.verification(record.tool_name, { valid: record.verification.passed, errors: record.ok ? [] : [record.error], warnings: [] });
  return record;
}

function schemaToGeminiType_(type) {
  var map = { string: 'STRING', number: 'NUMBER', integer: 'NUMBER', boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT' };
  return map[type] || 'STRING';
}

function schemaToGeminiParam_(schema) {
  var param = { type: schemaToGeminiType_(schema.type) };
  if (schema.description) param.description = schema.description;
  if (schema.enum) param.enum = schema.enum;
  if (schema.type === 'array' && schema.items) param.items = schemaToGeminiParam_(schema.items);
  if (schema.type === 'object' && schema.properties) {
    param.properties = {};
    Object.keys(schema.properties).forEach(function (k) {
      param.properties[k] = schemaToGeminiParam_(schema.properties[k]);
    });
    if (schema.required) param.required = schema.required;
  }
  return param;
}

// Translates TOOL_REGISTRY into Gemini function-calling declarations. One
// source of truth drives both input validation and the LLM-facing schema.
function buildGeminiDeclarations_() {
  return [{
    functionDeclarations: Object.keys(TOOL_REGISTRY).map(function (name) {
      var tool = TOOL_REGISTRY[name];
      var properties = {};
      Object.keys(tool.inputSchema.properties || {}).forEach(function (k) {
        properties[k] = schemaToGeminiParam_(tool.inputSchema.properties[k]);
      });
      return {
        name: name,
        description: tool.description,
        parameters: { type: 'OBJECT', properties: properties, required: tool.inputSchema.required || [] }
      };
    })
  }];
}
