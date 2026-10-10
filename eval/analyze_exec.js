'use strict';
/**
 * Compares the verify -> repair -> execute arm (e5_exec.js) with the stored GroundCheck-feedback repair on the SAME
 * tasks (those where the regenerated first attempt reproduced the stored one), as what ends up in the cell.
 *
 *   node analyze_exec.js <model>=<main.jsonl>,<exec.jsonl> ...
 *   e.g. node analyze_exec.js llama3.1-8b=results/e5_llama3.1-8b_letters.jsonl,results/e5_exec_llama3.1-8b.jsonl
 *
 * Writes results/exec_summary.json.
 */
const fs = require('fs');
const path = require('path');
const { pairedBinaryTest } = require('./lib/stats');

const load = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cat = (s) => (s.correct ? 'correct' : s.loudError ? 'loud' : 'silent');
const out = {};
process.argv.slice(2).forEach((arg) => {
  const [name, files] = arg.split('=');
  const [mainF, execF] = files.split(',');
  if (!fs.existsSync(execF)) return;
  const main = new Map(load(mainF).map((r) => [r.taskId, r]));
  const ex = load(execF).filter((r) => r.exec);
  const same = ex.filter((r) => r.attempt1Same && main.has(r.taskId) && main.get(r.taskId).strategies && main.get(r.taskId).strategies.v2fb);
  const tally = (fn) => { const t = { correct: 0, loud: 0, silent: 0 }; same.forEach((r) => { t[fn(r)]++; }); return t; };
  const M = {
    nExec: ex.length, nSame: same.length, shareSame: ex.length ? same.length / ex.length : NaN,
    write_as_is: tally((r) => cat(main.get(r.taskId).attempt1.retr.score)),
    repair_v2fb: tally((r) => cat(main.get(r.taskId).strategies.v2fb.score)),
    repair_exec: tally((r) => cat(r.exec.score)),
    meanAttemptsExec: same.reduce((a, r) => a + r.exec.attempts, 0) / Math.max(1, same.length)
  };
  const a = same.map((r) => r.exec.score.correct), b = same.map((r) => main.get(r.taskId).strategies.v2fb.score.correct);
  const t = pairedBinaryTest(a, b);
  M.vsV2fb = { gained: t.onlyA, lost: t.onlyB, p: t.p };
  // of the attempts that evaluate to an error after GroundCheck repair, how many does the execution check fix?
  const loudAfter = same.filter((r) => cat(main.get(r.taskId).strategies.v2fb.score) === 'loud');
  M.loudAfterV2fb = loudAfter.length;
  M.loudFixedByExec = loudAfter.filter((r) => r.exec.score.correct).length;
  M.loudStillByExec = loudAfter.filter((r) => cat(r.exec.score) === 'loud').length;
  M.loudToSilentByExec = loudAfter.filter((r) => cat(r.exec.score) === 'silent').length;
  out[name] = M;
});
fs.writeFileSync(path.join(__dirname, 'results', 'exec_summary.json'), JSON.stringify(out, null, 1));
Object.entries(out).forEach(([m, v]) => {
  console.log(`${m}: ${v.nSame}/${v.nExec} tasks with a reproduced first attempt; mean attempts ${v.meanAttemptsExec.toFixed(2)}`);
  ['write_as_is', 'repair_v2fb', 'repair_exec'].forEach((p) => console.log(`  ${p.padEnd(12)} correct ${v[p].correct}  error shown ${v[p].loud}  silent ${v[p].silent}`));
  console.log(`  exec vs GroundCheck feedback: +${v.vsV2fb.gained}/-${v.vsV2fb.lost}, p=${v.vsV2fb.p.toFixed(3)}; of ${v.loudAfterV2fb} cells still showing an error after GroundCheck repair, exec fixes ${v.loudFixedByExec}, leaves ${v.loudStillByExec}, turns ${v.loudToSilentByExec} silent`);
});
