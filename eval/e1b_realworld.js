'use strict';
/**
 * E1b — Real-world formulas.
 *
 *   node e1b_realworld.js <corpus.json> [--tag real]
 *
 * Runs the baselines and both verifier versions over formulas that real people
 * wrote (Sheetpedia: Enron / FUSE / Excel-forum workbooks), each verified
 * inside its own workbook with the target cell emptied. The release carries no
 * cached results, so there are no labels: we report reject/flag rates, group the
 * rejection messages, and use HyperFormula's evaluation of the original formula
 * as supporting evidence when adjudicating (see adjudicate.js).
 */
const fs = require('fs');
const path = require('path');
const { loadWorkbook, readBaseline } = require('./lib/gas');
const { wilson } = require('./lib/stats');
const { HyperFormula } = require('hyperformula');

const corpusPath = process.argv[2];
const TAG = (process.argv.indexOf('--tag') > 0 && process.argv[process.argv.indexOf('--tag') + 1]) || 'real';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
// The confirmation set ("fresh") may only be scored with the verifier frozen before the data was fetched.
// --verifier-file: score with a verifier other than the repository's (e.g. baselines/Verification.v2.1.js);
// --freeze: the freeze record to check it against (the tags "fresh" and "fresh2" require one).
const VERIFIER_FILE = arg('verifier-file', '');
const FREEZE = arg('freeze', TAG === 'fresh' ? path.join(__dirname, 'results', 'fresh_freeze.json') : TAG === 'fresh2' ? path.join(__dirname, 'results', 'fresh2_freeze.json') : '');
if (TAG === 'fresh' || TAG === 'fresh2') {
  const a = [path.join(__dirname, 'freeze_verifier.js'), '--check', '--out', FREEZE];
  if (VERIFIER_FILE) a.push('--verifier', VERIFIER_FILE);
  const chk = require('child_process').spawnSync('node', a, { encoding: 'utf8' });
  if (chk.status !== 0) { console.error(chk.stderr || chk.stdout); process.exit(1); }
}
const V2_OVERRIDE = VERIFIER_FILE ? { 'Verification.js': fs.readFileSync(VERIFIER_FILE, 'utf8') } : undefined;
const SPLIT = arg('split', 'all');          // dev = first 300 workbooks (used while fixing the verifier), test = the rest (scored once)
const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
const DEV_N = 300;
if (SPLIT === 'dev') corpus.workbooks = corpus.workbooks.slice(0, DEV_N);
if (SPLIT === 'test') corpus.workbooks = corpus.workbooks.slice(DEV_N);

function colNum(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

const A1_RE = /^[A-Z]+\d+(:[A-Z]+\d+)?$/;
function mockNames(wbj, main) {
  return (wbj.namedRanges || []).map((n) => ({
    name: n.name,
    sheet: wbj.sheetOrder.includes(n.sheet) ? n.sheet : main,
    a1: A1_RE.test(n.a1 || '') ? n.a1 : 'A1'
  }));
}

function hfValues(wbj) {
  // evaluate every sheet once; returns Map "sheet!A1" -> error type | 'ok'
  try {
    const sheets = {};
    wbj.sheetOrder.forEach((n) => { sheets[n] = wbj.sheets[n].map((r) => r.map((c) => (typeof c === 'string' && c.startsWith('=') ? c.replace(/\b(TRUE|FALSE)\b(?!\s*\()/gi, (m) => m.toUpperCase() + '()') : c))); });
    const hf = HyperFormula.buildFromSheets(sheets, { licenseKey: 'gpl-v3' });
    (wbj.namedRanges || []).forEach((n) => {
      if (!n.sheet || !A1_RE.test(n.a1 || '')) return;
      try {
        const [a, b] = n.a1.split(':');
        const abs = (x) => x.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
        hf.addNamedExpression(n.name, `='${n.sheet.replace(/'/g, "''")}'!${abs(a)}${b ? ':' + abs(b) : ''}`);
      } catch (e) { /* ignore unparseable names */ }
    });
    return { hf, ok: true };
  } catch (e) { return { ok: false }; }
}

const v1Src = readBaseline('Verification.v1.js');
const rows = [];
let wbCount = 0;

for (const wbj of corpus.workbooks) {
  wbCount++;
  const byMain = new Map();
  const hfState = hfValues(wbj);

  for (const f of wbj.formulas) {
    const main = f.sheet;
    const fakeWb = { id: wbj.file + '#' + main, main, sheets: wbj.sheets, sheetOrder: [main].concat(wbj.sheetOrder.filter((n) => n !== main)), namedRanges: mockNames(wbj, main), activeCell: f.cell, activeCol: colNum(f.cell.match(/^[A-Z]+/)[0]) };
    let envs = byMain.get(main);
    if (!envs) {
      try {
        const mk = (overrides) => { const e = loadWorkbook(fakeWb, { sourceOverrides: overrides }); e.sandbox.console = { log() {}, warn() {}, error() {}, info() {} }; return e; };
        envs = { v2: mk(V2_OVERRIDE), v1: mk({ 'Verification.js': v1Src }) };
        byMain.set(main, envs);
      } catch (e) { continue; }
    }
    const m = f.cell.match(/^([A-Z]+)(\d+)$/);
    const row = parseInt(m[2], 10), col = colNum(m[1]);
    const rec = { wb: wbj.file, sheet: main, cell: f.cell, formula: f.formula, d: {} };
    for (const key of ['v1', 'v2']) {
      const env = envs[key];
      const sheet = env.spreadsheet.getSheetByName(main);
      const range = sheet.getRange(row, col, 1, 1);
      range.setValue(''); // empty the target: we are asking "would this formula be accepted here?"
      sheet.setActiveCellPosition(row, col);
      try {
        const ctx = env.sandbox.buildDeepContext();
        const res = env.sandbox.verifyFormula_(f.formula, ctx);
        rec.d[key] = { reject: !res.valid, flag: !res.valid || res.warnings.length > 0, errors: res.errors, warnings: res.warnings };
      } catch (e) { rec.d[key] = { reject: false, flag: false, crashed: e.message, errors: [], warnings: [] }; }
      range.setFormula(f.formula); // restore
    }
    // supporting evidence: what an independent engine says about the original formula in place
    if (hfState.ok) {
      try {
        const sid = hfState.hf.getSheetId(main);
        const v = hfState.hf.getCellValue({ sheet: sid, row: row - 1, col: col - 1 });
        rec.hf = v && typeof v === 'object' && v.type ? v.type : 'ok';
      } catch (e) { rec.hf = 'n/a'; }
    }
    rows.push(rec);
  }
  if (wbCount % 25 === 0) console.error(`  ${wbCount}/${corpus.workbooks.length} workbooks, ${rows.length} formulas`);
}

// ---- aggregate ----
const n = rows.length;
const summary = { split: SPLIT, workbooks: corpus.workbooks.length, formulas: n, corpusStats: corpus.stats };
['v1', 'v2'].forEach((k) => {
  const rej = rows.filter((r) => r.d[k].reject).length;
  const flg = rows.filter((r) => r.d[k].flag).length;
  summary[k] = { reject: wilson(rej, n), flag: wilson(flg, n) };
});

function normalize(msg) {
  return msg.replace(/"[^"]*"/g, '"…"').replace(/\b[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?\b/g, 'REF').replace(/\d+/g, 'N').slice(0, 80);
}
['v1', 'v2'].forEach((k) => {
  const tally = {};
  rows.filter((r) => r.d[k].reject).forEach((r) => { const key = normalize(r.d[k].errors[0] || '?'); tally[key] = (tally[key] || 0) + 1; });
  summary[k].rejectReasons = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 25);
  const wtally = {};
  rows.filter((r) => !r.d[k].reject && r.d[k].flag).forEach((r) => { const key = normalize(r.d[k].warnings[0] || '?'); wtally[key] = (wtally[key] || 0) + 1; });
  summary[k].warnReasons = Object.entries(wtally).sort((a, b) => b[1] - a[1]).slice(0, 25);
});
// agreement of v2 rejections with the independent engine
const v2rej = rows.filter((r) => r.d.v2.reject);
summary.v2RejectVsHF = v2rej.reduce((a, r) => { a[r.hf] = (a[r.hf] || 0) + 1; return a; }, {});
summary.hfAll = rows.reduce((a, r) => { a[r.hf] = (a[r.hf] || 0) + 1; return a; }, {});

// ---- rejection categories with engine agreement (summary only: no formula text) ----
const catOf = (m) => (/does not exist/.test(m) ? 'ghost' : /circular/.test(m) ? 'circ' : /beyond the used/.test(m) ? 'col' : /is empty/.test(m) ? 'empty' : /Syntax/.test(m) ? 'syntax' : /not a function/.test(m) ? 'name' : /Unknown function/.test(m) ? 'fn' : /expects|outside|different sizes/.test(m) ? 'shape' : 'other');
summary.categories = {};
['v1', 'v2'].forEach((k) => {
  const t = {};
  rows.filter((r) => r.d[k].reject).forEach((r) => {
    const c = catOf(r.d[k].errors[0] || '');
    t[c] = t[c] || { n: 0, engineErr: 0, engineOk: 0 };
    t[c].n++; if (r.hf === 'ok') t[c].engineOk++; else t[c].engineErr++;
  });
  summary.categories[k] = t;
});
const ghostOk = rows.filter((r) => r.d.v2.reject && catOf(r.d.v2.errors[0] || '') === 'ghost' && r.hf === 'ok');
summary.ghostOk = ghostOk.length;
summary.ghostOkMasked = ghostOk.filter((r) => /IFERROR|IFNA|ISERROR|ISNA/i.test(r.formula)).length;

// The rows file embeds formula text from CC BY-SA workbooks: it is git-ignored. The summary has no formula text.
fs.writeFileSync(path.join(__dirname, 'results', `e1b_${TAG}.rows.json`), JSON.stringify({ rows }));
fs.writeFileSync(path.join(__dirname, 'results', `e1b_${TAG}.json`), JSON.stringify({ summary }));
console.log(JSON.stringify({ split: summary.split, formulas: summary.formulas, v1: { reject: summary.v1.reject.p, flag: summary.v1.flag.p }, v2: { reject: summary.v2.reject.p, flag: summary.v2.flag.p }, categories: summary.categories.v2 }, null, 1));
