'use strict';
/**
 * Builds the blind annotation files for real-world formulas.
 *
 *   node annotation/make_sheet.js <corpus.json> <rows.json> [--n 400] [--seed 3] [--out annotation/out]
 *
 *   corpus.json  the extraction of the workbooks (realworld/extract.py output: sheets, formulas)
 *   rows.json    results/e1b_<tag>.rows.json: the verifier decisions per formula (from e1b_realworld.js)
 *
 * The sample is stratified by the verifiers' decisions so that rare cases (rejections, warnings, the shipped
 * verifier's own rejections) are well covered and accepted formulas are not ignored:
 *     A  GroundCheck rejects            (formulas blanked to "=" by the dataset's PII pass are excluded)
 *     B  GroundCheck only warns
 *     C  GroundCheck accepts, shipped verifier rejects
 *     D  both accept without warnings
 * Each annotator gets a file in which the order is shuffled and NO verifier output appears, so the annotation is
 * blind. The key (strata, population sizes, verifier decisions) is written separately and used only for scoring.
 * The files contain formula text and cell values from CC BY-SA workbooks: they are git-ignored.
 */
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../lib/rng');
const csv = require('../lib/csv');

const [corpusFile, rowsFile] = process.argv.slice(2);
if (!corpusFile || !rowsFile) { console.error('usage: node annotation/make_sheet.js corpus.json rows.json [--n 400] [--seed 3] [--out dir]'); process.exit(1); }
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 400));
const rng = makeRng(Number(arg('seed', 3)));
const OUT = arg('out', path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });

const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'));
const byFile = new Map(corpus.workbooks.map((w) => [w.file, w]));
const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')).rows;

const isBlank = (r) => /formula is empty/.test((r.d.v2.errors || [])[0] || '');
const stratum = (r) => (r.d.v2.reject ? 'A' : r.d.v2.flag ? 'B' : r.d.v1.reject ? 'C' : 'D');
const pool = { A: [], B: [], C: [], D: [] };
rows.filter((r) => !isBlank(r)).forEach((r) => pool[stratum(r)].push(r));
const share = { A: 0.25, B: 0.19, C: 0.12, D: 0.44 };
const take = {};
Object.keys(pool).forEach((s) => { take[s] = Math.min(pool[s].length, Math.round(N * share[s])); });

const colName = (c) => { let s = ''; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const clip = (v, k) => { const s = v === null || v === undefined ? '' : String(v); return s.length > k ? s.slice(0, k - 1) + '…' : s; };

function gridPreview(grid, r0, r1, c0, c1) {
  const out = [];
  for (let r = r0; r <= Math.min(r1, grid.length); r++) {
    const row = grid[r - 1] || [];
    const cells = [];
    for (let c = c0; c <= c1; c++) cells.push(clip(row[c - 1], 18));
    out.push(`${r}: ` + cells.join(' | '));
  }
  return out.join('\n');
}

function contextFor(row) {
  const wb = byFile.get(row.wb);
  if (!wb) return '(workbook not found)';
  const lines = [];
  lines.push('Sheets: ' + wb.sheetOrder.map((n) => `${n} (${(wb.sheets[n] || []).length} rows)`).join(', '));
  const target = wb.sheets[row.sheet] || [];
  const m = row.cell.match(/^([A-Z]+)(\d+)$/);
  const tc = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0), tr = parseInt(m[2], 10);
  const width = Math.max(1, ...target.slice(0, 5).map((r) => r.length));
  lines.push(`Target sheet "${row.sheet}", header rows:\n` + gridPreview(target, 1, 3, 1, Math.min(width, 10)));
  lines.push(`Around the target ${row.cell}:\n` + gridPreview(target, Math.max(1, tr - 1), tr + 1, Math.max(1, tc - 3), tc + 3).replace(/^/, `(columns ${colName(Math.max(1, tc - 3))}..${colName(tc + 3)})\n`));
  // other sheets the formula names
  const named = new Set();
  const re = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w. ]*?))!/g; let mm;
  while ((mm = re.exec(row.formula))) named.add((mm[1] || mm[2]).replace(/''/g, "'"));
  named.forEach((n) => {
    const key = wb.sheetOrder.find((s) => s.toLowerCase() === n.toLowerCase());
    if (!key) lines.push(`Sheet "${n}" named in the formula: NOT in this workbook.`);
    else if (key !== row.sheet) lines.push(`Sheet "${key}" named in the formula, header rows:\n` + gridPreview(wb.sheets[key] || [], 1, 3, 1, 8));
  });
  return lines.join('\n');
}

const items = [];
let id = 0;
Object.keys(pool).forEach((s) => {
  rng.sample(pool[s], take[s]).forEach((r) => items.push({ s, r }));
});
rng.shuffle(items).forEach((it) => { it.id = ++id; });
items.sort((a, b) => a.id - b.id);

const base = ['id', 'workbook_file', 'sheet', 'cell', 'formula', 'context'];
const ann = (X) => [`${X}_defect`, `${X}_visibility`, `${X}_category`, `${X}_note`];
['A', 'B'].forEach((X) => {
  const out = [base.concat(ann(X))];
  items.forEach((it) => out.push([it.id, it.r.wb, it.r.sheet, it.r.cell, it.r.formula, contextFor(it.r), '', '', '', '']));
  fs.writeFileSync(path.join(OUT, `annotator_${X}.csv`), csv.stringify(out));
});

const key = {
  created: new Date().toISOString(), n: items.length,
  population: Object.fromEntries(Object.keys(pool).map((s) => [s, pool[s].length])),
  sampled: take,
  items: items.map((it) => ({ id: it.id, stratum: it.s, wb: it.r.wb, v1Reject: it.r.d.v1.reject, v2Reject: it.r.d.v2.reject, v2Flag: it.r.d.v2.flag, hf: it.r.hf || null }))
};
fs.writeFileSync(path.join(OUT, 'key.json'), JSON.stringify(key, null, 1));
console.log(`annotation items: ${items.length} (strata sampled ${JSON.stringify(take)} of ${JSON.stringify(key.population)}) -> ${OUT}`);
