'use strict';
/**
 * Robustness analyses requested for the paper, computed from the existing result files (no new model calls):
 *
 *  1. E1 with workbook-CLUSTERED uncertainty. Benchmark instances share a workbook, so they are not independent;
 *     resampling the 72 workbooks gives intervals that respect that. Reported next to the formula-level Wilson
 *     intervals, together with the paired difference between GroundCheck and the shipped verifier.
 *  2. Holm-adjusted p-values for the repair comparisons of the end-to-end study, per model and family.
 *  3. A harm accounting of the repair policies: for every task, what finally sits in the cell. The point is
 *     whether verification reduces wrong answers that look right (silent), or only turns visible errors into them.
 *
 *   node analyze_robust.js <model>=<final-system.jsonl> ...
 *   e.g. node analyze_robust.js llama3.1-8b=results/e5_llama3.1-8b_letters.jsonl llama3.2-3b=results/e5_llama3.2-3b_letters.jsonl
 *
 * Writes results/robust_summary.json.
 */
const fs = require('fs');
const path = require('path');
const { wilson, holm, clusterBootstrap, pairedBinaryTest } = require('./lib/stats');

const RES = path.join(__dirname, 'results');
const out = {};

// ------------------------------------------------------------- 1. E1, workbook-clustered
const e1 = JSON.parse(fs.readFileSync(path.join(RES, 'e1_main.json'), 'utf8'));
const base = (wb) => wb.replace(/[@+].*$/, '');
const perWb = {};
e1.records.forEach((r) => {
  const w = (perWb[base(r.wb)] = perWb[base(r.wb)] || { faults: 0, clean: 0, tp: {}, fp: {} });
  const isFault = r.label === 'fault';
  isFault ? w.faults++ : w.clean++;
  Object.keys(r.d).forEach((det) => {
    if (isFault) w.tp[det] = (w.tp[det] || 0) + (r.d[det][0] ? 1 : 0);
    else w.fp[det] = (w.fp[det] || 0) + (r.d[det][0] ? 1 : 0);
  });
});
const clusters = Object.values(perWb);
const sum = (cs, f) => cs.reduce((a, c) => a + f(c), 0);
const recall = (det) => (cs) => sum(cs, (c) => c.tp[det] || 0) / sum(cs, (c) => c.faults);
const fpr = (det) => (cs) => sum(cs, (c) => c.fp[det] || 0) / sum(cs, (c) => c.clean);
const f1 = (det) => (cs) => { const tp = sum(cs, (c) => c.tp[det] || 0), fp = sum(cs, (c) => c.fp[det] || 0), nf = sum(cs, (c) => c.faults); const p = tp / (tp + fp || 1), r = tp / nf; return 2 * p * r / (p + r || 1); };
out.e1Cluster = { nWorkbooks: clusters.length, detectors: {} };
['syntax', 'lint', 'v1', 'v2'].forEach((det) => {
  out.e1Cluster.detectors[det] = { recall: clusterBootstrap(clusters, recall(det)), fpr: clusterBootstrap(clusters, fpr(det)), f1: clusterBootstrap(clusters, f1(det)) };
});
out.e1Cluster.diffRecall = clusterBootstrap(clusters, (cs) => recall('v2')(cs) - recall('v1')(cs));
out.e1Cluster.diffF1 = clusterBootstrap(clusters, (cs) => f1('v2')(cs) - f1('v1')(cs));
// the same for the strongest ablation: how often does v2 beat v1 in a workbook?
out.e1Cluster.workbooksWhereV2Better = clusters.filter((c) => (c.tp.v2 || 0) / c.faults > (c.tp.v1 || 0) / c.faults).length;

// ------------------------------------------------------------- 1b. real-world sets, workbook-clustered
out.realWorld = {};
['test', 'fresh', 'fresh2', 'test21', 'fresh21'].forEach((tag) => {
  const f = path.join(RES, `e1b_${tag}.rows.json`);
  if (!fs.existsSync(f)) return;
  const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows;
  const wbs = {};
  rows.forEach((r) => {
    const w = (wbs[r.wb] = wbs[r.wb] || { n: 0, v1: 0, v2: 0, v1f: 0, v2f: 0, empty: 0, v2eng: 0, v2ghostMasked: 0 });
    w.n++;
    if (r.d.v1.reject) w.v1++;
    if (r.d.v2.reject) {
      w.v2++;
      if (/formula is empty/.test((r.d.v2.errors || [])[0] || '')) w.empty++;
      if (r.hf && r.hf !== 'ok') w.v2eng++;
    }
    if (r.d.v1.flag) w.v1f++;
    if (r.d.v2.flag) w.v2f++;
  });
  const cs = Object.values(wbs);
  const S = (k) => (c) => sum(c, (x) => x[k]);
  const rate = (k) => (c) => S(k)(c) / S('n')(c);
  const R = out.realWorld[tag] = { nWorkbooks: cs.length, nFormulas: rows.length };
  R.v1Reject = clusterBootstrap(cs, rate('v1')); R.v2Reject = clusterBootstrap(cs, rate('v2'));
  R.v1Flag = clusterBootstrap(cs, rate('v1f')); R.v2Flag = clusterBootstrap(cs, rate('v2f'));
  R.diffReject = clusterBootstrap(cs, (c) => rate('v2')(c) - rate('v1')(c));
  // the dataset's PII pass blanked some formulas to "=": they are artifacts, not formulas. Rate without them.
  R.nEmpty = S('empty')(cs);
  R.v2RejectNoEmpty = clusterBootstrap(cs, (c) => (S('v2')(c) - S('empty')(c)) / (S('n')(c) - S('empty')(c)));
  R.v2Rejected = S('v2')(cs); R.v1Rejected = S('v1')(cs); R.v2EngineConfirmed = S('v2eng')(cs);
  R.workbooksWithRejection = cs.filter((c) => c.v2 - c.empty > 0).length;

  // where the two verifiers disagree
  const only1 = rows.filter((r) => r.d.v1.reject && !r.d.v2.reject);
  const only2 = rows.filter((r) => r.d.v2.reject && !r.d.v1.reject);
  const isEmpty = (r) => /formula is empty/.test((r.d.v2.errors || [])[0] || '');
  R.overlap = {
    both: rows.filter((r) => r.d.v1.reject && r.d.v2.reject).length,
    onlyV1: only1.length,
    onlyV1RefLiteral: only1.filter((r) => /#REF!/i.test(r.formula)).length,           // a deleted reference left in the formula
    onlyV1Indirect: only1.filter((r) => !/#REF!/i.test(r.formula) && /INDIRECT\s*\(/i.test(r.formula)).length, // INDIRECT whose text names a sheet, or builds the name by concatenation
    onlyV1Other: only1.filter((r) => !/#REF!/i.test(r.formula) && !/INDIRECT\s*\(/i.test(r.formula)).length,
    onlyV1EngineOk: only1.filter((r) => r.hf === 'ok').length,
    onlyV2: only2.length, onlyV2Empty: only2.filter(isEmpty).length, onlyV2Real: only2.filter((r) => !isEmpty(r)).length,
    onlyV2EngineError: only2.filter((r) => !isEmpty(r) && r.hf && r.hf !== 'ok').length,
    workbooksOfV1Only: new Set(only1.map((r) => r.wb)).size,
    refLiteralInAnyFormula: rows.filter((r) => /#REF!/i.test(r.formula)).length
  };
  // how concentrated are the real rejections?
  const perWbReal = Object.values(cs).map((c) => c.v2 - c.empty).filter((x) => x > 0).sort((a, b) => b - a);
  const totReal = perWbReal.reduce((a, b) => a + b, 0);
  R.concentration = { workbooks: perWbReal.length, top1: perWbReal[0], top5Share: perWbReal.slice(0, 5).reduce((a, b) => a + b, 0) / totReal };
});

// ------------------------------------------------------------- 2/3. E5 per model
const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const STRATS = ['resample', 'generic', 'v1fb', 'v2fb', 'v2fb+susp'];
const cat = (score) => (score.correct ? 'correct' : score.loudError ? 'loud' : 'silent');
out.e5 = {};
process.argv.slice(2).forEach((a) => {
  const [name, file] = a.split('=');
  const recs = load(file).filter((r) => r.attempt1.retr && Object.keys(r.strategies).length === STRATS.length);
  const n = recs.length;
  const M = { n, policies: {}, holm: {}, unsafe: {} };

  // what is written in the cell under each policy
  const tally = (fn) => { const t = { correct: 0, loud: 0, silent: 0, withheld: 0 }; recs.forEach((r) => { t[fn(r)]++; }); return t; };
  M.policies.write_as_is = tally((r) => cat(r.attempt1.retr.score));
  M.policies.block_only = tally((r) => (!r.attempt1.retr.v2.valid ? 'withheld' : cat(r.attempt1.retr.score)));
  STRATS.forEach((s) => { M.policies['repair_' + s] = tally((r) => cat(r.strategies[s].score)); });
  // rejected attempts that were in fact correct (false alarms) would be withheld under block_only
  M.falseWithheld = recs.filter((r) => !r.attempt1.retr.v2.valid && r.attempt1.retr.score.correct).length;

  // unsafe-repair rate: of the attempts the verifier rejected, how many end valid but wrong?
  const rejected = recs.filter((r) => !r.attempt1.retr.v2.valid);
  STRATS.forEach((s) => {
    const t = { n: rejected.length, correct: 0, silentWrong: 0, loudWrong: 0 };
    rejected.forEach((r) => {
      const sc = r.strategies[s].score;
      if (sc.correct) t.correct++; else if (sc.loudError) t.loudWrong++; else t.silentWrong++;
    });
    t.unsafeRate = rejected.length ? t.silentWrong / rejected.length : NaN;
    t.unsafe = wilson(t.silentWrong, rejected.length);
    M.unsafe[s] = t;
  });

  // Holm-adjusted p-values: family A = each feedback strategy vs plain resampling; family B = the two
  // GroundCheck strategies vs the two other feedback strategies
  const fin = (s) => recs.map((r) => r.strategies[s].score.correct);
  const test = (s, ref) => pairedBinaryTest(fin(s), fin(ref)).p;
  const famA = ['generic', 'v1fb', 'v2fb', 'v2fb+susp'];
  const adjA = holm(famA.map((s) => test(s, 'resample')));
  famA.forEach((s, i) => { M.holm['vsResample:' + s] = { p: test(s, 'resample'), adj: adjA[i] }; });
  const famB = [['v2fb', 'generic'], ['v2fb', 'v1fb'], ['v2fb+susp', 'generic'], ['v2fb+susp', 'v1fb']];
  const adjB = holm(famB.map(([s, r]) => test(s, r)));
  famB.forEach(([s, r], i) => { M.holm[`${s}:vs:${r}`] = { p: test(s, r), adj: adjB[i] }; });
  out.e5[name] = M;
});

fs.writeFileSync(path.join(RES, 'robust_summary.json'), JSON.stringify(out, null, 1));
const pc = (x) => (100 * x).toFixed(1);
console.log(`E1 clustered over ${out.e1Cluster.nWorkbooks} workbooks`);
Object.entries(out.e1Cluster.detectors).forEach(([d, v]) => console.log(`  ${d.padEnd(6)} recall ${pc(v.recall.est)} [${pc(v.recall.lo)}, ${pc(v.recall.hi)}]  FPR ${pc(v.fpr.est)} [${pc(v.fpr.lo)}, ${pc(v.fpr.hi)}]  F1 ${pc(v.f1.est)} [${pc(v.f1.lo)}, ${pc(v.f1.hi)}]`));
console.log(`  recall(v2) - recall(v1) = ${pc(out.e1Cluster.diffRecall.est)} [${pc(out.e1Cluster.diffRecall.lo)}, ${pc(out.e1Cluster.diffRecall.hi)}]; v2 better in ${out.e1Cluster.workbooksWhereV2Better}/${out.e1Cluster.nWorkbooks} workbooks`);
Object.entries(out.realWorld).forEach(([t, R]) => {
  console.log(`real-world ${t}: ${R.nFormulas} formulas / ${R.nWorkbooks} workbooks`);
  console.log(`  reject v1 ${pc(R.v1Reject.est)} [${pc(R.v1Reject.lo)}, ${pc(R.v1Reject.hi)}]  v2 ${pc(R.v2Reject.est)} [${pc(R.v2Reject.lo)}, ${pc(R.v2Reject.hi)}]  diff ${pc(R.diffReject.est)} [${pc(R.diffReject.lo)}, ${pc(R.diffReject.hi)}]`);
  console.log(`  v2 without PII-blanked formulas (${R.nEmpty}): ${pc(R.v2RejectNoEmpty.est)} [${pc(R.v2RejectNoEmpty.lo)}, ${pc(R.v2RejectNoEmpty.hi)}]; engine-confirmed rejections ${R.v2EngineConfirmed}/${R.v2Rejected}; workbooks with a real rejection ${R.workbooksWithRejection}/${R.nWorkbooks}`);
});
Object.entries(out.e5).forEach(([m, v]) => {
  console.log(`E5 ${m} n=${v.n}`);
  Object.entries(v.policies).forEach(([p, t]) => console.log(`   ${p.padEnd(18)} correct ${t.correct}  loud ${t.loud}  silent ${t.silent}  withheld ${t.withheld}`));
  console.log('   unsafe-repair rate (rejected attempts ending valid but wrong): ' + STRATS.map((s) => `${s} ${v.unsafe[s].silentWrong}/${v.unsafe[s].n}`).join('  '));
  console.log('   Holm: ' + Object.entries(v.holm).map(([k, h]) => `${k} p=${h.p.toFixed(3)} adj=${h.adj.toFixed(3)}`).join('; '));
});
