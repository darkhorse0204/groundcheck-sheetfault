'use strict';
/**
 * Extra cuts of the existing result files, used by the paper's additional figures. No new experiments:
 *   - E1: reject recall / FPR per domain and per workbook for the shipped verifier (v1) and GroundCheck (v2)
 *   - E5: attempt-1 accuracy per task template and per request form (exact header words vs paraphrase),
 *     for every model, with the active-sheet-only and the retrieved context
 *   - E5: how the repair strategies treat the attempts the verifier rejected
 * Writes results/extra_summary.json.
 *
 *   node analyze_extra.js
 */
const fs = require('fs');
const path = require('path');
const { wilson } = require('./lib/stats');

const RES = path.join(__dirname, 'results');
const out = {};

// ------------------------------------------------------------- E1 per domain / workbook
const e1 = JSON.parse(fs.readFileSync(path.join(RES, 'e1_main.json'), 'utf8'));
const dom = (wb) => wb.replace(/[@+].*$/, '').replace(/-\d+$/, '');
const base = (wb) => wb.replace(/[@+].*$/, '');
const acc = {};
e1.records.forEach((r) => {
  const d = dom(r.wb), w = base(r.wb);
  ['v1', 'v2'].forEach((det) => {
    const [rej] = r.d[det];
    const key = r.label === 'fault' ? 'fault' : 'clean';
    const D = ((acc[d] = acc[d] || {})[det] = acc[d][det] || { fault: [0, 0], clean: [0, 0], wb: {} });
    D[key][0] += rej ? 1 : 0; D[key][1] += 1;
    if (key === 'fault') { const W = (D.wb[w] = D.wb[w] || [0, 0]); W[0] += rej ? 1 : 0; W[1] += 1; }
  });
});
out.e1Domain = {};
Object.keys(acc).forEach((d) => {
  out.e1Domain[d] = {};
  ['v1', 'v2'].forEach((det) => {
    const D = acc[d][det];
    out.e1Domain[d][det] = {
      recall: wilson(D.fault[0], D.fault[1]), fpr: wilson(D.clean[0], D.clean[1]),
      perWorkbook: Object.keys(D.wb).sort().map((w) => D.wb[w][0] / D.wb[w][1])
    };
  });
});

// ------------------------------------------------------------- E5 per template / request form
const load = (f) => fs.readFileSync(path.join(RES, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const models = [
  { id: 'llama3.1-8b', file: 'e5_llama3.1-8b_letters.jsonl', flatFile: 'e5_llama3.1-8b.jsonl' },
  { id: 'llama3.2-3b', file: 'e5_llama3.2-3b_letters.jsonl' },
  { id: 'llama3.1-8b-heldout', file: 'e5_llama3.1-8b_heldout.jsonl' },
  { id: 'gemini-3.1-flash-lite', file: 'e5_gemini-3.1-flash-lite.jsonl' },
  { id: 'gemini-3.5-flash-lite', file: 'e5_gemini-3.5-flash-lite.jsonl' },
  { id: 'gemma-4-26b-a4b-it', file: 'e5_gemma-4-26b-a4b-it.jsonl' }
].filter((m) => fs.existsSync(path.join(RES, m.file)));
out.e5 = {};
models.forEach((m) => {
  const recs = load(m.file);
  const flatRecs = new Map((m.flatFile ? load(m.flatFile) : recs).map((r) => [r.taskId, r]));
  const rows = recs.map((r) => ({
    type: r.type, level: r.level, lookup: !!r.usesLookup,
    flat: !!(flatRecs.get(r.taskId) && flatRecs.get(r.taskId).attempt1.flat && flatRecs.get(r.taskId).attempt1.flat.score.correct),
    retr: !!(r.attempt1.retr && r.attempt1.retr.score.correct),
    loud: !!(r.attempt1.retr && r.attempt1.retr.score.loudError)
  }));
  const grp = (keyFn, valFn) => {
    const g = {};
    rows.forEach((r) => { const k = keyFn(r); const G = (g[k] = g[k] || [0, 0]); G[0] += valFn(r) ? 1 : 0; G[1] += 1; });
    return Object.fromEntries(Object.entries(g).map(([k, [c, n]]) => [k, { n, acc: c / n, ...wilson(c, n) }]));
  };
  out.e5[m.id] = {
    n: rows.length,
    byType: { retr: grp((r) => r.type, (r) => r.retr), flat: grp((r) => r.type, (r) => r.flat) },
    byLevel: { retr: grp((r) => r.level, (r) => r.retr), flat: grp((r) => r.level, (r) => r.flat) },
    byLevelNoLookup: { retr: grp((r) => (r.lookup ? 'lookup' : r.level), (r) => r.retr) }
  };
  // hosted runs: the model version the API reported in each response
  if (/^gem/.test(m.id)) {
    const vs = {};
    recs.forEach((r) => Object.entries(r.modelVersions || {}).forEach(([k, c]) => { vs[k] = (vs[k] || 0) + c; }));
    out.e5[m.id].versions = { calls: Object.values(vs).reduce((a, b) => a + b, 0), matching: vs[m.id] || 0, reported: vs, tasksWithoutVersion: recs.filter((r) => !r.modelVersions || !Object.keys(r.modelVersions).length).length };
  }
});

// ------------------------------------------------------------- E5 repair transitions (what repair does to rejected attempts)
const summ = JSON.parse(fs.readFileSync(path.join(RES, 'e5_summary.json'), 'utf8'));
out.repair = {};
summ.forEach((m) => {
  out.repair[m.model] = {};
  Object.entries(m.repair.strategies).forEach(([s, v]) => { out.repair[m.model][s] = v.transitions; });
});

fs.writeFileSync(path.join(RES, 'extra_summary.json'), JSON.stringify(out, null, 1));
console.log('wrote results/extra_summary.json');
const f = (x) => (100 * x).toFixed(1);
Object.entries(out.e1Domain).forEach(([d, v]) => console.log(`E1 ${d.padEnd(10)} v1 recall ${f(v.v1.recall.p)}  v2 recall ${f(v.v2.recall.p)}  v2 FPR ${f(v.v2.fpr.p)}  (per-workbook v2 min ${f(Math.min(...v.v2.perWorkbook))})`));
Object.entries(out.e5).forEach(([m, v]) => {
  console.log(`E5 ${m} n=${v.n}`);
  console.log('   level  ', JSON.stringify(Object.fromEntries(Object.entries(v.byLevel.retr).map(([k, x]) => [k, f(x.acc) + '% n=' + x.n]))), 'flat', JSON.stringify(Object.fromEntries(Object.entries(v.byLevel.flat).map(([k, x]) => [k, f(x.acc)]))));
  console.log('   type   ', Object.entries(v.byType.retr).map(([k, x]) => `${k}:${f(x.acc)}`).join(' '));
});
