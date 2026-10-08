'use strict';
/**
 * Analysis of the end-to-end study.
 *
 *   node analyze_e5.js <model>=<pass2.jsonl>[+<pass1.jsonl>] ...
 *   e.g. llama3.1-8b=results/e5_llama3.1-8b_letters.jsonl+results/e5_llama3.1-8b.jsonl llama3.2-3b=results/e5_llama3.2-3b_letters.jsonl
 *
 * Pass 2 is the FINAL system (retrieved context with column letters and the data-row
 * span in every table chunk). Pass 1, when present, ran the same tasks with the chunk
 * format shipped before that fix, and also holds the flat (active-sheet-only) arm.
 * Writes results/e5_summary.json:
 *   - attempt-1 accuracy for the three context arms (paired McNemar)
 *   - what verification can and cannot see among the final system's wrong formulas
 *   - repair strategies vs the no-repair baseline and vs plain resampling
 *   - selective prediction (accuracy when the verifier says valid / invalid)
 *   - cost: LLM calls and tokens per task by strategy
 */
const fs = require('fs');
const path = require('path');
const { wilson, mean, pairedBinaryTest, pairedBootstrapDiff } = require('./lib/stats');

const STRATS = ['resample', 'generic', 'v1fb', 'v2fb', 'v2fb+susp'];
const pct = (x) => (100 * x).toFixed(1);

function load(f) { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
function byId(recs) { const m = new Map(); recs.forEach((r) => m.set(r.taskId, r)); return m; }

function repairBlock(recs) {
  const withStrat = recs.filter((r) => Object.keys(r.strategies).length === STRATS.length);
  const base = withStrat.map((r) => r.attempt1.retr.score.correct);
  const out = { n: withStrat.length, attempt1: wilson(base.filter(Boolean).length, base.length), strategies: {} };
  const resample = withStrat.map((r) => r.strategies.resample.score.correct);
  const generic = withStrat.map((r) => r.strategies.generic.score.correct);
  const v1fb = withStrat.map((r) => r.strategies.v1fb.score.correct);
  STRATS.forEach((s) => {
    const fin = withStrat.map((r) => r.strategies[s].score.correct);
    const vsBase = pairedBinaryTest(fin, base), vsRes = pairedBinaryTest(fin, resample);
    const vsGen = pairedBinaryTest(fin, generic), vsV1 = pairedBinaryTest(fin, v1fb);
    out.strategies[s] = {
      accuracy: wilson(fin.filter(Boolean).length, fin.length),
      fixed: fin.filter((v, i) => v && !base[i]).length, broken: fin.filter((v, i) => !v && base[i]).length,
      stillInvalidV2: withStrat.filter((r) => !r.strategies[s].finalValidV2).length,
      vsAttempt1: { gained: vsBase.onlyA, lost: vsBase.onlyB, p: vsBase.p, diffCI: pairedBootstrapDiff(fin.map(Number), base.map(Number)) },
      vsResample: s === 'resample' ? null : { gained: vsRes.onlyA, lost: vsRes.onlyB, p: vsRes.p },
      vsGeneric: ['resample', 'generic'].includes(s) ? null : { gained: vsGen.onlyA, lost: vsGen.onlyB, p: vsGen.p },
      vsV1: ['resample', 'generic', 'v1fb'].includes(s) ? null : { gained: vsV1.onlyA, lost: vsV1.onlyB, p: vsV1.p },
      meanAttempts: mean(withStrat.map((r) => r.strategies[s].attempts)),
      repairedShare: withStrat.filter((r) => r.strategies[s].attempts > 1).length / withStrat.length,
      // what happens to attempts the verifier rejected: made correct, made valid-but-wrong (a loud error turned silent), or still invalid
      transitions: (() => {
        const inv = withStrat.filter((r) => !r.attempt1.retr.v2.valid);
        return {
          n: inv.length,
          correct: inv.filter((r) => r.strategies[s].score.correct).length,
          validWrong: inv.filter((r) => !r.strategies[s].score.correct && r.strategies[s].finalValidV2).length,
          stillInvalid: inv.filter((r) => !r.strategies[s].score.correct && !r.strategies[s].finalValidV2).length
        };
      })()
    };
  });
  return out;
}

function analyze(name, p2, p1) {
  const out = { model: name, nPass2: p2.length, nPass1: p1 ? p1.length : 0 };
  const okRec = (r, arm) => r.attempt1[arm] && !r.attempt1[arm].error;
  const final = p2.filter((r) => okRec(r, 'retr'));
  out.nValid = final.length;

  // ---- context arms (attempt 1), on the tasks all available arms share ----
  const p1m = p1 ? byId(p1) : null, p2m = byId(final);
  const flatSrc = (id) => { const a = p1m && p1m.get(id); if (a && okRec(a, 'flat')) return a.attempt1.flat; const b = p2m.get(id); return b && okRec(b, 'flat') ? b.attempt1.flat : null; };
  const shippedSrc = (id) => { const a = p1m && p1m.get(id); return a && okRec(a, 'retr') ? a.attempt1.retr : null; };
  const ids = final.map((r) => r.taskId).filter((id) => flatSrc(id) && (!p1m || shippedSrc(id)));
  const meta = (id) => p2m.get(id);
  const arms = { flat: ids.map((id) => flatSrc(id)), final: ids.map((id) => p2m.get(id).attempt1.retr) };
  if (p1m) arms.shipped = ids.map((id) => shippedSrc(id));
  const acc = (list) => wilson(list.filter((a) => a.score.correct).length, list.length);
  const sub = (flag) => ids.map((id, i) => i).filter((i) => !!meta(ids[i]).usesLookup === flag);
  out.context = { n: ids.length, arms: {}, tests: {} };
  Object.keys(arms).forEach((k) => {
    out.context.arms[k] = { overall: acc(arms[k]) };
    [[true, 'lookup'], [false, 'other']].forEach(([flag, label]) => { const ix = sub(flag); out.context.arms[k][label] = { n: ix.length, acc: acc(ix.map((i) => arms[k][i])) }; });
  });
  const cmp = (a, b) => { const t = pairedBinaryTest(arms[a].map((x) => x.score.correct), arms[b].map((x) => x.score.correct)); return { aOnly: t.onlyA, bOnly: t.onlyB, p: t.p }; };
  out.context.tests['final-vs-flat'] = cmp('final', 'flat');
  if (arms.shipped) { out.context.tests['final-vs-shipped'] = cmp('final', 'shipped'); out.context.tests['shipped-vs-flat'] = cmp('shipped', 'flat'); }

  // ---- failure taxonomy of the final system's attempt 1 ----
  const wrong = final.filter((r) => !r.attempt1.retr.score.correct);
  const detect = (r, key) => ({ reject: !r.attempt1.retr[key].valid, flag: !r.attempt1.retr[key].valid || r.attempt1.retr[key].warnings.length > 0 });
  const tax = { nWrong: wrong.length, loud: 0, silent: 0, byErrorType: {}, v1: { reject: 0, flag: 0 }, v2: { reject: 0, flag: 0, suspicious: 0 }, loudCaught: { v1: 0, v2: 0 }, silentCaught: { v1reject: 0, v2reject: 0, v2flag: 0, v1flag: 0 }, v2Reasons: {} };
  wrong.forEach((r) => {
    const loud = r.attempt1.retr.score.loudError !== null;
    tax[loud ? 'loud' : 'silent']++;
    if (loud) tax.byErrorType[r.attempt1.retr.score.loudError] = (tax.byErrorType[r.attempt1.retr.score.loudError] || 0) + 1;
    const d1 = detect(r, 'v1'), d2 = detect(r, 'v2');
    if (d1.reject) tax.v1.reject++; if (d1.flag) tax.v1.flag++;
    if (d2.reject) tax.v2.reject++; if (d2.flag) tax.v2.flag++;
    if (r.attempt1.retr.v2.suspicious.length) tax.v2.suspicious++;
    if (loud) { if (d1.reject) tax.loudCaught.v1++; if (d2.reject) tax.loudCaught.v2++; }
    else { if (d1.reject) tax.silentCaught.v1reject++; if (d2.reject) tax.silentCaught.v2reject++; if (d2.flag) tax.silentCaught.v2flag++; if (d1.flag) tax.silentCaught.v1flag++; }
    (r.attempt1.retr.v2.errors.concat(r.attempt1.retr.v2.suspicious)).slice(0, 1).forEach((m) => {
      const k = m.replace(/"[^"]*"/g, '"…"').replace(/\b[A-Z]{1,3}\d+(:[A-Z]{1,3}\d+)?\b/g, 'REF').replace(/\d+/g, 'N').slice(0, 60);
      tax.v2Reasons[k] = (tax.v2Reasons[k] || 0) + 1;
    });
  });
  out.taxonomy = tax;
  const right = final.filter((r) => r.attempt1.retr.score.correct);
  out.falseAlarms = { nCorrect: right.length, v1Reject: right.filter((r) => !r.attempt1.retr.v1.valid).length, v2Reject: right.filter((r) => !r.attempt1.retr.v2.valid).length, v2Suspicious: right.filter((r) => r.attempt1.retr.v2.suspicious.length > 0).length };

  // ---- selective prediction ----
  const validRs = final.filter((r) => r.attempt1.retr.v2.valid), invalidRs = final.filter((r) => !r.attempt1.retr.v2.valid);
  out.gate = { accepted: validRs.length, rejected: invalidRs.length, accuracyAccepted: wilson(validRs.filter((r) => r.attempt1.retr.score.correct).length, validRs.length), accuracyRejected: wilson(invalidRs.filter((r) => r.attempt1.retr.score.correct).length, invalidRs.length), accuracyAll: wilson(right.length, final.length) };

  // ---- repair: final system, plus (when available) the same strategies under the shipped chunk format ----
  out.repair = repairBlock(final);
  // lookup tasks separately: the flat context cannot answer them, and the agent's few-shot example names "Sheet2"
  out.repairLookup = repairBlock(final.filter((r) => r.usesLookup));
  const lk = final.filter((r) => r.usesLookup);
  out.lookupSheet2 = { n: lk.length, copiedSheet2: lk.filter((r) => /Sheet2!/i.test(r.attempt1.retr.formula)).length };
  if (p1) out.repairShipped = repairBlock(p1.filter((r) => okRec(r, 'retr')));

  // ---- cost (final system) ----
  const cost = {}, bucketNames = new Set();
  final.forEach((r) => Object.keys(r.usage).forEach((b) => bucketNames.add(b)));
  bucketNames.forEach((b) => {
    cost[b] = { callsPerTask: mean(final.map((r) => (r.usage[b] ? r.usage[b].calls : 0))), promptTokensPerTask: mean(final.map((r) => (r.usage[b] ? r.usage[b].promptTokens : 0))), completionTokensPerTask: mean(final.map((r) => (r.usage[b] ? r.usage[b].completionTokens : 0))), secondsPerTask: mean(final.map((r) => (r.usage[b] ? r.usage[b].ms / 1000 : 0))) };
  });
  out.cost = cost;
  return out;
}

function main() {
  const specs = process.argv.slice(2).map((a) => { const [name, rest] = a.split('='); const [f2, f1] = rest.split('+'); return { name, f2, f1 }; });
  const summary = specs.map((s) => analyze(s.name, load(s.f2), s.f1 ? load(s.f1) : null));
  fs.writeFileSync(path.join(__dirname, 'results', 'e5_summary.json'), JSON.stringify(summary, null, 1));
  summary.forEach((s) => {
    console.log(`\n==== ${s.model}: ${s.nValid} final-system tasks (context comparison on ${s.context.n}) ====`);
    Object.keys(s.context.arms).forEach((k) => { const a = s.context.arms[k]; console.log(`  attempt-1 ${k.padEnd(8)} ${pct(a.overall.p)}%   lookup ${pct(a.lookup.acc.p)}% (n=${a.lookup.n})  other ${pct(a.other.acc.p)}% (n=${a.other.n})`); });
    Object.entries(s.context.tests).forEach(([k, t]) => console.log(`    ${k}: ${t.aOnly} vs ${t.bOnly}, p=${t.p.toFixed(4)}`));
    const t = s.taxonomy;
    console.log(`wrong attempt-1 formulas: ${t.nWrong} (loud ${t.loud}, silent ${t.silent}); v1 rejects ${t.v1.reject} | v2 rejects ${t.v2.reject} flags ${t.v2.flag} (suspicious ${t.v2.suspicious}); silent caught: v2 reject ${t.silentCaught.v2reject}, flag ${t.silentCaught.v2flag}`);
    console.log(`false alarms on ${s.falseAlarms.nCorrect} correct formulas: v1 ${s.falseAlarms.v1Reject}, v2 ${s.falseAlarms.v2Reject}, suspicious ${s.falseAlarms.v2Suspicious}`);
    console.log(`gate: accepted ${s.gate.accepted} (acc ${pct(s.gate.accuracyAccepted.p)}%), rejected ${s.gate.rejected} (acc ${pct(s.gate.accuracyRejected.p)}%)`);
    const show = (label, R) => { console.log(`repair ${label} (n=${R.n}) attempt-1 ${pct(R.attempt1.p)}%`); STRATS.forEach((k) => { const v = R.strategies[k]; console.log(`   ${k.padEnd(10)} ${pct(v.accuracy.p).padStart(5)}% fixed ${String(v.fixed).padStart(3)} broke ${v.broken}  vs attempt1 p=${v.vsAttempt1.p.toFixed(4)}${v.vsResample ? `  vs resample +${v.vsResample.gained}/-${v.vsResample.lost} p=${v.vsResample.p.toFixed(4)}` : ''}  attempts ${v.meanAttempts.toFixed(2)}`); }); };
    show('(final)', s.repair);
    if (s.repairShipped) show('(shipped chunk format)', s.repairShipped);
  });
}

main();
