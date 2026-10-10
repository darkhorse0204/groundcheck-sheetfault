'use strict';
/**
 * Loads a generated workbook into the add-on's real source files (running
 * unmodified in a Node vm sandbox with GAS globals stubbed — see
 * test/support/gasEnvironment.js) and returns handles for calling the
 * production functions against it.
 */
const fs = require('fs');
const path = require('path');
const { createGasEnvironment } = require('../../test/support/gasEnvironment');

const BASELINE_DIR = path.join(__dirname, '..', 'baselines');

function readBaseline(file) { return fs.readFileSync(path.join(BASELINE_DIR, file), 'utf8'); }

/**
 * @param {object} wb          workbook from workbookGen
 * @param {object} [opts]      { sourceOverrides, urlFetchStub, activeCell, extraFormulas, noRateLimit }
 */
function loadWorkbook(wb, opts) {
  opts = opts || {};
  const env = createGasEnvironment({
    sheetName: wb.main,
    sheetData: wb.sheets[wb.main].map((r) => r.slice()),
    namedRanges: wb.namedRanges,
    sourceOverrides: opts.sourceOverrides,
    urlFetchStub: opts.urlFetchStub,
    spreadsheetName: `Eval ${wb.id}`
  });
  wb.sheetOrder.slice(1).forEach((name) => env.spreadsheet._addSheet(name, wb.sheets[name].map((r) => r.slice())));
  env.spreadsheet._setActiveSheet(wb.main);

  const sheet = env.spreadsheet.getSheetByName(wb.main);
  const cell = opts.activeCell || wb.activeCell;
  const m = cell.match(/^([A-Z]+)(\d+)$/);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  sheet.setActiveCellPosition(parseInt(m[2], 10), col);

  (opts.extraFormulas || []).forEach((f) => env.spreadsheet.getSheetByName(f.sheet).getRange(f.cell).setFormula(f.formula));

  if (opts.noRateLimit !== false) {
    env.sandbox.CONFIG.RATE_LIMIT.MAX_CALLS_PER_MINUTE = 1e9;
  }
  return env;
}

module.exports = { loadWorkbook, readBaseline };
