'use strict';
/**
 * Execution oracle: evaluates a candidate formula placed at the workbook's
 * active cell using HyperFormula, an independent open-source spreadsheet
 * engine. This gives ground-truth labels (loud error / silent / correct)
 * without relying on the verifier under test.
 */
const { HyperFormula } = require('hyperformula');

const cache = new Map();

function getEngine(wb) {
  if (cache.has(wb.id)) {
    const hit = cache.get(wb.id);
    // Guard against label corruption: two different workbooks must never share an id.
    if (hit.sheetsRef !== wb.sheets || hit.activeCell !== wb.activeCell) {
      throw new Error('oracle cache collision: workbook id reused for a different workbook: ' + wb.id);
    }
    return hit;
  }
  const sheets = {};
  wb.sheetOrder.forEach((name) => { sheets[name] = wb.sheets[name].map((r) => r.slice()); });
  const hf = HyperFormula.buildFromSheets(sheets, { licenseKey: 'gpl-v3' });
  wb.namedRanges.forEach((nr) => {
    try { hf.addNamedExpression(nr.name, `=${nr.sheet}!$${nr.a1.split(':')[0].replace(/(\d+)/, '$$$1')}:$${nr.a1.split(':')[1].replace(/(\d+)/, '$$$1')}`); } catch (e) { /* ignore */ }
  });
  const entry = { hf, sheetId: hf.getSheetId(wb.main), sheetsRef: wb.sheets, activeCell: wb.activeCell };
  cache.set(wb.id, entry);
  return entry;
}

function cellCoords(wb) {
  const m = wb.activeCell.match(/^([A-Z]+)(\d+)$/);
  return { row: parseInt(m[2], 10) - 1, col: wb.activeCol - 1 };
}

function isError(v) {
  return v !== null && typeof v === 'object' && typeof v.type === 'string';
}

/**
 * Google Sheets accepts bare TRUE/FALSE; HyperFormula needs TRUE()/FALSE().
 * Rewrite them (outside string literals) so the oracle never mislabels valid
 * Sheets syntax as faulty.
 */
function normalizeForOracle(formula) {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => {
    if (i % 2 === 1) return part; // string literal
    return part.replace(/\b(TRUE|FALSE)\b(?!\s*\()/gi, (m) => m.toUpperCase() + '()');
  }).join('');
}

/** @returns {{ok:boolean, value:any, errorType:string|null}} */
function evaluate(wb, rawFormula) {
  const formula = normalizeForOracle(rawFormula);
  const { hf, sheetId } = getEngine(wb);
  const { row, col } = cellCoords(wb);
  let out;
  try {
    hf.setCellContents({ sheet: sheetId, row, col }, [[formula]]);
    const v = hf.getCellValue({ sheet: sheetId, row, col });
    out = isError(v) ? { ok: false, value: null, errorType: v.type } : { ok: true, value: v, errorType: null };
  } catch (e) {
    out = { ok: false, value: null, errorType: 'EXCEPTION' };
  }
  try { hf.setCellContents({ sheet: sheetId, row, col }, [[null]]); } catch (e) { /* ignore */ }
  return out;
}

function valuesEqual(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = Math.max(1e-6, Math.abs(b) * 1e-9);
    return Math.abs(a - b) <= tol || Math.abs(a - b) / Math.max(1, Math.abs(b)) < 1e-9;
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function clearCache() { cache.forEach((e) => e.hf.destroy()); cache.clear(); }

module.exports = { evaluate, valuesEqual, clearCache };
