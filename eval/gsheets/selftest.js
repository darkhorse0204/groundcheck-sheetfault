'use strict';
/**
 * Self-test of the Google Sheets validation harness WITHOUT Google: Validate.gs is run in a sandbox against a mock of
 * the Apps Script services (SpreadsheetApp, DriveApp, PropertiesService, ...) backed by HyperFormula, then
 * compare_gsheets.js is run on the CSV it produces. Because the mock IS HyperFormula, every case must agree; a
 * failure here means a bug in the harness (pack format, workbook construction, resumption, CSV, comparison).
 * It says nothing about Google Sheets itself.
 *
 *   node gsheets/selftest.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { HyperFormula } = require('hyperformula');

const packPath = path.join(__dirname, 'pack.json');
const packText = fs.readFileSync(packPath, 'utf8');

const ERR = { DIV_BY_ZERO: '#DIV/0!', NAME: '#NAME?', VALUE: '#VALUE!', NUM: '#NUM!', NA: '#N/A', REF: '#REF!', CYCLE: '#REF!', ERROR: '#ERROR!' };
const isErr = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string';
const normalize = (f) => f.split(/("(?:[^"]|"")*")/).map((p, i) => (i % 2 ? p : p.replace(/\b(TRUE|FALSE)\b(?!\s*\()/gi, (m) => m.toUpperCase() + '()'))).join('');
const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const a1 = (s) => { const m = s.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/); return { r: +m[2], c: colNum(m[1]), r2: m[4] ? +m[4] : +m[2], c2: m[3] ? colNum(m[3]) : colNum(m[1]) }; };

class PlainSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getRange(r, c, nr, nc) { const s = this; return { setValues: (v) => v.forEach((row, i) => { s.rows[r - 1 + i] = row.slice(); }), getValues: () => s.rows.slice(r - 1, r - 1 + nr).map((x) => x.slice(c - 1, c - 1 + nc)) }; }
}
class HfSheet {
  constructor(ss, name) { this.ss = ss; this.name = name; }
  getName() { return this.name; }
  get id() { return this.ss.hf.getSheetId(this.name); }
  getRange(...a) {
    const sh = this;
    let r, c, nr, nc;
    if (typeof a[0] === 'string') { const p = a1(a[0]); r = p.r; c = p.c; nr = p.r2 - p.r + 1; nc = p.c2 - p.c + 1; }
    else { [r, c, nr, nc] = a; nr = nr || 1; nc = nc || 1; }
    const addr = (i, j) => ({ sheet: sh.id, row: r - 1 + i, col: c - 1 + j });
    const show = (v) => (isErr(v) ? ERR[v.type] || '#' + v.type : v === null || v === undefined ? '' : v);
    return {
      sheet: sh, r, c, nr, nc,
      setValues: (v) => sh.ss.hf.setCellContents({ sheet: sh.id, row: r - 1, col: c - 1 }, v.map((row) => row.map((x) => (x === '' ? null : x)))),
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(show(sh.ss.hf.getCellValue(addr(i, j)))); out.push(row); } return out; },
      // the benchmark's oracle normalises TRUE/FALSE even in text stored without "=", so the mock does the same
      setValue: (v) => sh.ss.hf.setCellContents(addr(0, 0), [[typeof v === 'string' ? normalize(v[0] === "'" ? v.slice(1) : v) : v]]),
      setFormula: (f) => sh.ss.hf.setCellContents(addr(0, 0), [[normalize(f)]]),
      getDisplayValue: () => String(show(sh.ss.hf.getCellValue(addr(0, 0)))),
      getValue: () => show(sh.ss.hf.getCellValue(addr(0, 0))),
      clearContent: () => sh.ss.hf.setCellContents(addr(0, 0), [[null]])
    };
  }
}
class Ss {
  constructor(id) { this.id = id; this.hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' }); this.sheets = []; this.insertSheet('Sheet1'); }
  getId() { return this.id; }
  getUrl() { return 'mock://' + this.id; }
  insertSheet(name) { const s = name.startsWith('__') ? new PlainSheet(name) : new HfSheet(this, name); if (!name.startsWith('__')) this.hf.addSheet(name); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  deleteSheet(s) { if (s instanceof HfSheet) this.hf.removeSheet(this.hf.getSheetId(s.name)); this.sheets = this.sheets.filter((x) => x !== s); }
  setNamedRange(name, range) { const [x, y] = [range.r, range.c]; const abs = (r, c) => '$' + String.fromCharCode(64 + c) + '$' + r; this.hf.addNamedExpression(name, `=${range.sheet.name}!${abs(range.r, range.c)}:${abs(range.r + range.nr - 1, range.c + range.nc - 1)}`); }
  removeNamedRange(name) { this.hf.removeNamedExpression(name); }
}

const store = new Map();
const props = {};
let budgetHits = 0;
const mock = {
  SpreadsheetApp: { create: () => { const s = new Ss('ss1'); store.set('ss1', s); return s; }, openById: (id) => store.get(id), flush() {} },
  DriveApp: { getFileById: () => ({ getBlob: () => ({ getDataAsString: () => packText }) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
  Utilities: { sleep() {} },
  Logger: { log: (m) => { if (/budget/.test(m)) budgetHits++; } },
  JSON, Date, Math, Object, Array, Number, String, RegExp, Error
};

let src = fs.readFileSync(path.join(__dirname, 'Validate.gs'), 'utf8');
const ctx = vm.createContext(mock);
vm.runInContext(src, ctx);

// First run with a tiny budget to exercise resumption, then run to completion.
ctx.BUDGET_MS = 250; // long enough to finish some workbooks, short enough to stop part-way
vm.runInContext('runValidation()', ctx);
const afterFirst = store.get('ss1').getSheetByName('__results').getLastRow() - 1;
ctx.BUDGET_MS = 5 * 60 * 1000;
vm.runInContext('runValidation()', ctx);
const res = store.get('ss1').getSheetByName('__results');
console.log(`first run (budget cut) evaluated ${afterFirst} cases; after the second run ${res.getLastRow() - 1} rows`);

const csv = res.rows.map((r) => r.map((x) => '"' + String(x === undefined ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\n');
const csvPath = path.join(__dirname, 'selftest_results.csv');
fs.writeFileSync(csvPath, csv);
const run = spawnSync('node', [path.join(__dirname, 'compare_gsheets.js'), packPath, csvPath, '--out', path.join(__dirname, 'selftest_out.json')], { encoding: 'utf8' });
console.log(run.stdout + run.stderr);
const out = JSON.parse(fs.readFileSync(path.join(__dirname, 'selftest_out.json'), 'utf8'));
// every case must agree (the mock is HyperFormula); the first run must have stopped part-way and been resumed
const ok = out.agree.bothError + out.agree.bothSameValue === out.n && out.n === JSON.parse(packText).cases.length && budgetHits > 0 && afterFirst > 0 && afterFirst < out.n;
fs.unlinkSync(csvPath); fs.unlinkSync(path.join(__dirname, 'selftest_out.json'));
console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
process.exit(ok ? 0 : 1);
