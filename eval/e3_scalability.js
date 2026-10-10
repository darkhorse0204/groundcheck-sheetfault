'use strict';
/**
 * E3 — Cost and scalability of workbook analysis and verification.
 *
 *   node e3_scalability.js
 *
 * On Google Apps Script the dominant cost of reading a spreadsheet is the number
 * of SpreadsheetApp calls (each is a round trip), not CPU time, so every
 * measurement reports BOTH: median Node CPU time (a lower bound, platform
 * dependent) and the count of SpreadsheetApp calls (platform independent).
 *
 * Measured: (a) SpreadsheetEngine.analyze() vs workbook size, (b) one formula
 * verification by the shipped verifier (v1) and the current one (v2), including
 * the data reads the grounding layer adds, (c) the effect of the engine's row cap.
 */
const fs = require('fs');
const path = require('path');
const { generateWorkbook, colLetter } = require('./lib/workbookGen');
const { makeRng } = require('./lib/rng');
const { loadWorkbook, readBaseline } = require('./lib/gas');
const { median } = require('./lib/stats');

/** Wraps an object so every method call (and the objects it returns) is counted. */
function counting(obj, counter, depth) {
  depth = depth || 0;
  if (obj === null || typeof obj !== 'object' || depth > 3) return obj;
  return new Proxy(obj, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      return (...a) => {
        counter.calls++;
        const r = v.apply(target, a);
        return counting(r, counter, depth + 1);
      };
    }
  });
}

function instrument(env) {
  const counter = { calls: 0 };
  const realSS = env.spreadsheet;
  env.sandbox.SpreadsheetApp.getActiveSpreadsheet = () => counting(realSS, counter);
  return counter;
}

/** Builds a workbook with `rows` data rows, `sheets` total sheets and `formulas` live formulas on the main sheet. */
function bigWorkbook(rows, sheets, formulas) {
  const wb = generateWorkbook('sales', 1, { rows, withNamedRanges: false });
  const rng = makeRng(rows * 31 + sheets);
  const main = wb.sheets[wb.main];
  const extraCol = wb.lastCol + 3; // helper column of formulas, separated from the table by blank columns
  for (let r = 0; r < Math.min(formulas, rows); r++) {
    while (main[r + 1].length < extraCol) main[r + 1].push('');
    main[r + 1][extraCol - 1] = `=F${r + 2}*1.1`;
  }
  while (wb.sheetOrder.length < sheets) {
    const k = wb.sheetOrder.length;
    const name = `Data${k}`;
    const data = [['ID', 'Value', 'Label']];
    for (let i = 0; i < Math.min(rows, 200); i++) data.push([i, rng.int(1, 999), 'x' + (i % 7)]);
    wb.sheets[name] = data;
    wb.sheetOrder.push(name);
  }
  wb.id = `e3-${rows}-${sheets}-${formulas}`;
  return wb;
}

function timeIt(fn, reps) {
  const times = [];
  for (let i = 0; i < reps; i++) { const t0 = process.hrtime.bigint(); fn(); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  return median(times);
}

function main() {
  const results = { analyze: [], verify: [] };
  const configs = [
    { rows: 100, sheets: 3, formulas: 0 }, { rows: 500, sheets: 3, formulas: 0 }, { rows: 1000, sheets: 3, formulas: 0 }, { rows: 2000, sheets: 3, formulas: 0 },
    { rows: 500, sheets: 3, formulas: 500 }, { rows: 2000, sheets: 3, formulas: 2000 },
    { rows: 500, sheets: 10, formulas: 100 }, { rows: 500, sheets: 20, formulas: 100 }, { rows: 500, sheets: 40, formulas: 100 }
  ];
  const v1Src = readBaseline('Verification.v1.js');

  configs.forEach((cfg) => {
    const wb = bigWorkbook(cfg.rows, cfg.sheets, cfg.formulas);
    const env = loadWorkbook(wb);
    env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
    const counter = instrument(env);

    // (a) workbook analysis
    counter.calls = 0;
    let model;
    const analyzeMs = timeIt(() => { counter.calls = 0; model = env.sandbox.SpreadsheetEngine.analyze(); }, 3);
    const analyzeCalls = counter.calls;

    // (b) verification of one realistic formula (cross-sheet lookup + conditional sum) at the active cell
    const formula = `=SUMIF(B2:B${wb.lastRow},"East",F2:F${wb.lastRow})/SUM(F2:F${wb.lastRow})`;
    const row = { ...cfg, analyzeMs, analyzeCalls, tables: model.workbook.sheets.reduce((a, s) => a + s.tables.length, 0), chunks: model.embeddingChunks.length };
    [['v2', undefined], ['v1', { 'Verification.js': v1Src }]].forEach(([key, overrides]) => {
      const e = loadWorkbook(wb, { sourceOverrides: overrides });
      e.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
      const c = instrument(e);
      const ctx = e.sandbox.buildDeepContext();
      row[key + 'Ms'] = timeIt(() => { c.calls = 0; e.sandbox.verifyFormula_(formula, ctx); }, 5);
      row[key + 'Calls'] = c.calls;
    });
    results.analyze.push(row);
    console.log(`rows=${String(cfg.rows).padStart(4)} sheets=${String(cfg.sheets).padStart(2)} formulas=${String(cfg.formulas).padStart(4)} | analyze ${analyzeMs.toFixed(1).padStart(7)} ms ${String(analyzeCalls).padStart(4)} calls | verify v1 ${row.v1Ms.toFixed(2)} ms ${row.v1Calls} calls  v2 ${row.v2Ms.toFixed(2)} ms ${row.v2Calls} calls`);
  });

  fs.writeFileSync(path.join(__dirname, 'results', 'e3_scalability.json'), JSON.stringify(results, null, 1));
}

main();
