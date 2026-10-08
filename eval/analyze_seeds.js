'use strict';
/**
 * Run-to-run variation of the end-to-end study. The main result files hold one sampled trajectory per task and
 * condition (--traj-seed 0); further seeds rerun the same tasks with fresh sampling. This reports, per model,
 *   - attempt-1 accuracy (active-sheet context and retrieved context) per seed, with mean and standard deviation
 *   - accuracy after each repair strategy per seed, with mean and standard deviation
 *   - the repair effect with task-clustered uncertainty: for every task the outcome is averaged over the seeds,
 *     and the paired difference between two strategies is bootstrapped over tasks
 *   - the harm accounting (correct / visible error / silent wrong) averaged over seeds
 *
 *   node analyze_seeds.js <model>=<seed0.jsonl>[+<seed0-flat.jsonl>],<seed1.jsonl>,<seed2.jsonl> ...
 *
 * Writes results/seeds_summary.json.
 */
const fs = require('fs');
const path = require('path');
const { mean, sd, pairedBootstrapDiff } = require('./lib/stats');

const STRATS = ['resample', 'generic', 'v1fb', 'v2fb', 'v2fb+susp'];
const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cat = (s) => (s.correct ? 'correct' : s.loudError ? 'loud' : 'silent');
const out = {};

process.argv.slice(2).forEach((arg) => {
  const [name, files] = arg.split('=');
  const specs = files.split(',').map((s) => { const [f, flat] = s.split('+'); return { f, flat }; });
  const runs = specs.map((s) => {
    const m = new Map(load(s.f).filter((r) => r.attempt1.retr && Object.keys(r.strategies).length === STRATS.length).map((r) => [r.taskId, r]));
    const flat = new Map((s.flat ? load(s.flat) : load(s.f)).filter((r) => r.attempt1.flat && r.attempt1.flat.score).map((r) => [r.taskId, r.attempt1.flat.score.correct]));
    return { m, flat };
  });
  // tasks present in every seed
  const ids = [...runs[0].m.keys()].filter((id) => runs.every((r) => r.m.has(id)));
  const M = { nSeeds: runs.length, nTasks: ids.length, perSeed: [], summary: {}, clustered: {}, harm: {} };

  runs.forEach((r, k) => {
    const rec = ids.map((id) => r.m.get(id));
    const acc = (fn) => rec.filter(fn).length / rec.length;
    const S = {
      seed: k,
      flat: ids.filter((id) => r.flat.get(id)).length / ids.length,
      retr: acc((x) => x.attempt1.retr.score.correct),
      strategies: Object.fromEntries(STRATS.map((s) => [s, acc((x) => x.strategies[s].score.correct)])),
      harm: {}
    };
    ['write_as_is', ...STRATS].forEach((p) => {
      const t = { correct: 0, loud: 0, silent: 0 };
      rec.forEach((x) => { t[cat(p === 'write_as_is' ? x.attempt1.retr.score : x.strategies[p].score)]++; });
      S.harm[p] = t;
    });
    const rej = rec.filter((x) => !x.attempt1.retr.v2.valid);
    S.rejected = rej.length;
    S.unsafe = Object.fromEntries(STRATS.map((s) => [s, rej.length ? rej.filter((x) => cat(x.strategies[s].score) === 'silent').length / rej.length : NaN]));
    M.perSeed.push(S);
  });

  const stat = (get) => { const v = M.perSeed.map(get); return { mean: mean(v), sd: sd(v), min: Math.min(...v), max: Math.max(...v) }; };
  M.summary.flat = stat((s) => s.flat);
  M.summary.retr = stat((s) => s.retr);
  STRATS.forEach((s) => { M.summary[s] = stat((x) => x.strategies[s]); M.summary['unsafe:' + s] = stat((x) => x.unsafe[s]); });
  ['write_as_is', ...STRATS].forEach((p) => { M.harm[p] = Object.fromEntries(['correct', 'loud', 'silent'].map((c) => [c, mean(M.perSeed.map((s) => s.harm[p][c]))])); });

  // task-level outcome averaged over seeds, then paired bootstrap over tasks
  const avg = (s) => ids.map((id) => mean(runs.map((r) => (r.m.get(id).strategies[s].score.correct ? 1 : 0))));
  const vs = (a, b) => { const x = avg(a), y = avg(b); const d = pairedBootstrapDiff(x, y); return { diff: d.est, lo: d.lo, hi: d.hi }; };
  M.clustered['v2fb-resample'] = vs('v2fb', 'resample');
  M.clustered['v2fb-generic'] = vs('v2fb', 'generic');
  M.clustered['v2fb-v1fb'] = vs('v2fb', 'v1fb');
  M.clustered['v1fb-resample'] = vs('v1fb', 'resample');
  M.clustered['v2fb+susp-resample'] = vs('v2fb+susp', 'resample');
  // seeds in which GroundCheck feedback beats plain resampling
  M.seedsV2BeatsResample = M.perSeed.filter((s) => s.strategies.v2fb > s.strategies.resample).length;
  out[name] = M;
});

fs.writeFileSync(path.join(__dirname, 'results', 'seeds_summary.json'), JSON.stringify(out, null, 1));
const pc = (x) => (100 * x).toFixed(1);
Object.entries(out).forEach(([m, v]) => {
  console.log(`${m}: ${v.nSeeds} seeds x ${v.nTasks} tasks`);
  console.log('  attempt 1 flat ' + v.perSeed.map((s) => pc(s.flat)).join(' / ') + `  (mean ${pc(v.summary.flat.mean)} sd ${pc(v.summary.flat.sd)})   retrieved ` + v.perSeed.map((s) => pc(s.retr)).join(' / ') + `  (mean ${pc(v.summary.retr.mean)} sd ${pc(v.summary.retr.sd)})`);
  STRATS.forEach((s) => console.log(`  ${s.padEnd(10)} ` + v.perSeed.map((x) => pc(x.strategies[s])).join(' / ') + `   mean ${pc(v.summary[s].mean)} sd ${pc(v.summary[s].sd)}   unsafe ${pc(v.summary['unsafe:' + s].mean)}`));
  Object.entries(v.clustered).forEach(([k, d]) => console.log(`  ${k}: ${pc(d.diff)} [${pc(d.lo)}, ${pc(d.hi)}]`));
  console.log('  GroundCheck feedback beats resampling in ' + v.seedsV2BeatsResample + '/' + v.nSeeds + ' seeds');
});
