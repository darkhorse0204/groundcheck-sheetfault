/**
 * Evaluates the validation pack in the real Google Sheets engine.
 *
 * How to run (needs a Google account; takes a few minutes):
 *   1. Upload eval/gsheets/pack.json to Google Drive and copy the file id from its share link.
 *   2. Open script.google.com, create a project, paste this file, set PACK_FILE_ID below.
 *   3. Run runValidation(). Authorize Sheets and Drive access when asked. A run stops after about five
 *      minutes (the Apps Script limit is six); run it again and it continues where it stopped.
 *   4. Open the spreadsheet "GroundCheck engine validation" (its URL is in the execution log), choose
 *      File > Download > CSV for the sheet "__results" and keep the file as results.csv.
 *   5. node gsheets/compare_gsheets.js gsheets/pack.json results.csv
 *
 * For each case the script builds the case's workbook (values, formulas and named ranges), puts the formula in
 * the workbook's target cell, lets Sheets calculate, and records what the cell shows. Nothing is sent anywhere
 * else: the sheets live in a new spreadsheet in the account that runs the script.
 */
var PACK_FILE_ID = 'PASTE_DRIVE_FILE_ID_OF_pack.json';
var BUDGET_MS = 5 * 60 * 1000;
var RESULT_SHEET = '__results';
var ERROR_RE = /^#(N\/A|REF!|NAME\?|VALUE!|DIV\/0!|NUM!|NULL!|ERROR!)/;

function runValidation() {
  var t0 = Date.now();
  var pack = JSON.parse(DriveApp.getFileById(PACK_FILE_ID).getBlob().getDataAsString());
  var props = PropertiesService.getScriptProperties();
  var ss = openOrCreate_(props);
  var res = ss.getSheetByName(RESULT_SHEET);
  var done = {};
  if (res.getLastRow() > 1) {
    res.getRange(2, 1, res.getLastRow() - 1, 1).getValues().forEach(function (r) { done[r[0]] = true; });
  }

  var groups = groupByWorkbook_(pack.cases);
  for (var g = 0; g < groups.length; g++) {
    var cases = groups[g].filter(function (c) { return !done[c.id]; });
    if (!cases.length) continue;
    if (Date.now() - t0 > BUDGET_MS) { Logger.log('time budget reached; run again to continue'); return; }
    var wb = pack.workbooks[cases[0].wbId];
    var made = buildWorkbook_(ss, wb);
    var rows = cases.map(function (c) { return evaluateCase_(made.main, wb, c); });
    res.getRange(res.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    teardown_(ss, made, wb);
  }
  Logger.log('all ' + pack.cases.length + ' cases evaluated');
}

function openOrCreate_(props) {
  var id = props.getProperty('SS_ID');
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('GroundCheck engine validation');
  props.setProperty('SS_ID', ss.getId());
  var res = ss.insertSheet(RESULT_SHEET);
  res.getRange(1, 1, 1, 5).setValues([['id', 'display', 'isError', 'value', 'note']]);
  ss.deleteSheet(ss.getSheets()[0]);
  Logger.log('spreadsheet: ' + ss.getUrl());
  return ss;
}

function groupByWorkbook_(cases) {
  var groups = [], last = null;
  cases.forEach(function (c) {
    if (c.wbId !== last) { groups.push([]); last = c.wbId; }
    groups[groups.length - 1].push(c);
  });
  return groups;
}

function buildWorkbook_(ss, wb) {
  var sheets = {};
  wb.sheetOrder.forEach(function (name) {
    var sh = ss.insertSheet(name);
    var grid = wb.sheets[name];
    var width = Math.max.apply(null, grid.map(function (r) { return r.length; }).concat([1]));
    var padded = grid.map(function (r) { var o = r.slice(); while (o.length < width) o.push(''); return o; });
    var rng = sh.getRange(1, 1, padded.length, width);
    rng.setValues(padded);
    // Sheets parses typed text ("2024-01-05", "00123") the way a user typing would; keep text as text
    var back = rng.getValues();
    for (var r = 0; r < padded.length; r++) {
      for (var c = 0; c < width; c++) {
        var want = padded[r][c];
        if (typeof want === 'string' && want !== '' && want.charAt(0) !== '=' && typeof back[r][c] !== 'string') {
          sh.getRange(r + 1, c + 1).setValue("'" + want);
        }
      }
    }
    sheets[name] = sh;
  });
  (wb.namedRanges || []).forEach(function (nr) {
    try { ss.setNamedRange(nr.name, sheets[nr.sheet].getRange(nr.a1)); } catch (e) { /* ignore a name Sheets rejects */ }
  });
  SpreadsheetApp.flush();
  return { sheets: sheets, main: sheets[wb.main] };
}

function evaluateCase_(main, wb, c) {
  var cell = main.getRange(wb.activeCell);
  var note = '';
  try {
    if (c.formula.charAt(0) === '=') cell.setFormula(c.formula); else cell.setValue(c.formula);
  } catch (e) { note = 'set failed: ' + e.message; }
  SpreadsheetApp.flush();
  var display = '', value = null;
  for (var k = 0; k < 8; k++) {
    display = cell.getDisplayValue();
    if (display !== 'Loading...') break;
    Utilities.sleep(500);
  }
  value = cell.getValue();
  var isError = ERROR_RE.test(display) || /^Err:/.test(display);
  cell.clearContent();
  var out = value instanceof Date ? value.toISOString() : value;
  return [c.id, display, isError ? 1 : 0, JSON.stringify(out === undefined ? null : out), note];
}

function teardown_(ss, made, wb) {
  (wb.namedRanges || []).forEach(function (nr) { try { ss.removeNamedRange(nr.name); } catch (e) { /* not set */ } });
  Object.keys(made.sheets).forEach(function (name) { ss.deleteSheet(made.sheets[name]); });
}
