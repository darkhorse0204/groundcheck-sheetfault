'use strict';
/**
 * Compares what the real Google Sheets engine answered (results.csv, from Validate.gs) with HyperFormula's answer
 * stored in the pack, and re-derives the benchmark labels under Google Sheets.
 *
 *   node gsheets/compare_gsheets.js gsheets/pack.json results.csv [--out results/gsheets_validation.json]
 *
 * Reports:
 *   - engine agreement on every case: both error, both the same value, or a disagreement (and which kind)
 *   - the benchmark label (faulty / clean) under HyperFormula and under Google Sheets, and how often they differ
 *   - recall of the shipped verifier and GroundCheck on the sampled faults, under each engine's labels
 */
const fs = require('fs');
const path = require('path');

const packFile = process.argv[2], csvFile = process.argv[3];
if (!packFile || !csvFile) { console.error('usage: node compare_gsheets.js pack.json results.csv'); process.exit(1); }
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : path.join(__dirname, '..', 'results', 'gsheets_validation.json');

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function sameValue(a, b) {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a).toLowerCase() === String(b).toLowerCase();
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

const pack = JSON.parse(fs.readFileSync(packFile, 'utf8'));
const rows = parseCsv(fs.readFileSync(csvFile, 'utf8'));
const header = rows.shift();
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const gs = new Map();
rows.filter((r) => r.length >= 4 && r[col.id] !== '').forEach((r) => {
  let v = null; try { v = JSON.parse(r[col.value]); } catch (e) { v = r[col.value]; }
  gs.set(Number(r[col.id]), { display: r[col.display], isError: r[col.isError] === '1' || r[col.isError] === 'true', value: v });
});

const agree = { bothError: 0, bothSameValue: 0, hfErrorOnly: 0, gsErrorOnly: 0, differentValues: 0, missing: 0 };
const disagreements = [];
const labelOf = (isErr, val, gold) => (isErr ? 'fault' : gold !== null && gold !== undefined && !sameValue(val, gold) ? 'fault' : 'clean');
const tab = { fault: { n: { hf: 0, gs: 0 }, v1: { hf: 0, gs: 0 }, v2: { hf: 0, gs: 0 } }, clean: { n: { hf: 0, gs: 0 }, v1: { hf: 0, gs: 0 }, v2: { hf: 0, gs: 0 } } };
const labelFlip = { hfFaultGsClean: 0, hfCleanGsFault: 0, same: 0 };
const perClass = {};

pack.cases.forEach((c) => {
  const g = gs.get(c.id);
  if (!g) { agree.missing++; return; }
  const hfErr = !c.hf.ok;
  let kind;
  if (hfErr && g.isError) kind = 'bothError';
  else if (!hfErr && !g.isError && sameValue(c.hf.value, g.value)) kind = 'bothSameValue';
  else if (hfErr) kind = 'hfErrorOnly';
  else if (g.isError) kind = 'gsErrorOnly';
  else kind = 'differentValues';
  agree[kind]++;
  const P = (perClass[c.cls] = perClass[c.cls] || { n: 0, agree: 0 });
  P.n++; if (kind === 'bothError' || kind === 'bothSameValue') P.agree++;
  if (kind !== 'bothError' && kind !== 'bothSameValue') disagreements.push({ id: c.id, cls: c.cls, formula: c.formula, hf: c.hf.ok ? c.hf.value : c.hf.errorType, gs: g.isError ? g.display : g.value, kind });

  // Labels. QUERY classes: HyperFormula cannot run QUERY, so its label is "by construction" and Google Sheets
  // supplies the first engine-based label (error = fault). Custom-function negatives are clean by construction
  // under both engines and are left out of the label comparison. All other cases: faulty if the engine returns
  // an error or a value different from the gold formula's value (for a clean variant, the value HyperFormula
  // confirmed equal to gold).
  if (c.cls === 'clean:custom_fn') return;
  const ref = c.goldValue !== null && c.goldValue !== undefined ? c.goldValue : c.hf.ok ? c.hf.value : null;
  const hfLabel = c.labelSource === 'construction' ? c.label : labelOf(hfErr, c.hf.value, ref);
  const gsLabel = c.labelSource === 'construction' ? (g.isError ? 'fault' : 'clean') : labelOf(g.isError, g.value, ref);
  if (hfLabel === gsLabel) labelFlip.same++; else if (hfLabel === 'fault') labelFlip.hfFaultGsClean++; else labelFlip.hfCleanGsFault++;
  [['hf', hfLabel], ['gs', gsLabel]].forEach(([eng, lab]) => {
    tab[lab].n[eng]++;
    ['v1', 'v2'].forEach((d) => { if (c[d + 'Reject']) tab[lab][d][eng]++; });
  });
});

const n = pack.cases.length - agree.missing;
const pct = (x, d) => (d ? (100 * x / d).toFixed(1) + '%' : 'n/a');
console.log(`cases evaluated in Google Sheets: ${n} of ${pack.cases.length}`);
console.log('engine agreement:', Object.entries(agree).map(([k, v]) => `${k} ${v}`).join(', '), `=> same answer on ${pct(agree.bothError + agree.bothSameValue, n)}`);
console.log('benchmark label (fault/clean) identical under both engines:', pct(labelFlip.same, n), JSON.stringify(labelFlip));
['fault', 'clean'].forEach((l) => {
  const t = tab[l];
  console.log(`  ${l}: ${t.n.hf} (HyperFormula labels) vs ${t.n.gs} (Google Sheets labels) cases; GroundCheck rejects ${t.v2.hf} vs ${t.v2.gs} (${pct(t.v2.hf, t.n.hf)} vs ${pct(t.v2.gs, t.n.gs)}); shipped ${t.v1.hf} vs ${t.v1.gs} (${pct(t.v1.hf, t.n.hf)} vs ${pct(t.v1.gs, t.n.gs)})`);
});
if (disagreements.length) { console.log('\nfirst disagreements:'); disagreements.slice(0, 15).forEach((d) => console.log(`  #${d.id} ${d.cls} ${d.kind}: ${d.formula}  HF=${JSON.stringify(d.hf)} GS=${JSON.stringify(d.gs)}`)); }
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ n, total: pack.cases.length, agree, labelFlip, tab, perClass, disagreements }, null, 1));
console.log('wrote', OUT);
