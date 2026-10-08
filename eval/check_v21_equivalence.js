'use strict';
/**
 * Does the extended verifier (baselines/Verification.v2.1.js: two added rules) change any SheetFault verdict?
 * The benchmark has no error literals and no INDIRECT, so it should not. This reruns the extended verifier on every
 * benchmark instance and compares reject/flag with the verdicts stored for the original GroundCheck in
 * results/e1_main.json. Also scans every end-to-end trajectory for formulas that the new rules could touch.
 *
 *   node --expose-gc --max-old-space-size=6144 check_v21_equivalence.js
 */
const fs = require('fs');
const path = require('path');
const { buildBenchmark } = require('./e1_detection');
const { productVerifier, clearCaches } = require('./lib/detectors');

const src = fs.readFileSync(path.join(__dirname, 'baselines', 'Verification.v2.1.js'), 'utf8');
const det = productVerifier('v2.1', { 'Verification.js': src });
const e1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'e1_main.json'), 'utf8'));

const { instances } = buildBenchmark();
if (instances.length !== e1.records.length) throw new Error(`instance count differs: ${instances.length} vs ${e1.records.length}`);
let diff = 0, n = 0;
const examples = [];
instances.forEach((inst, i) => {
  const rec = e1.records[i];
  if (rec.f !== inst.formula) throw new Error('instance order differs at ' + i);
  const r = det(inst);
  const [rej, flg] = rec.d.v2;
  if ((r.reject ? 1 : 0) !== rej || (r.flag ? 1 : 0) !== flg) { diff++; if (examples.length < 5) examples.push({ cls: inst.cls, formula: inst.formula, was: [rej, flg], now: [r.reject, r.flag] }); }
  n++;
  if (n % 4000 === 0) { clearCaches(); console.error(`  ${n}/${instances.length}`); }
});
console.log(`SheetFault: ${n} instances, ${diff} verdicts differ between GroundCheck and the extended verifier`);
if (examples.length) console.log(JSON.stringify(examples, null, 1));

// end-to-end trajectories: formulas the new rules could touch
// formulas the rules can fire on: an error literal, or INDIRECT whose text starts with a sheet part ("Sheet!...")
const touch = /#REF!|#NAME\?|INDIRECT\s*\(\s*["'][^"']*!/i;
let total = 0, hit = 0;
fs.readdirSync(path.join(__dirname, 'results')).filter((f) => /^e5_.*\.jsonl$/.test(f)).forEach((f) => {
  fs.readFileSync(path.join(__dirname, 'results', f), 'utf8').split('\n').filter(Boolean).forEach((l) => {
    const r = JSON.parse(l);
    const fs_ = [];
    ['flat', 'retr'].forEach((k) => { if (r.attempt1[k] && r.attempt1[k].formula) fs_.push(r.attempt1[k].formula); });
    Object.values(r.strategies || {}).forEach((s) => (s.formulas || []).forEach((x) => x && fs_.push(x)));
    fs_.forEach((x) => { total++; if (touch.test(x)) hit++; });
  });
});
console.log(`end-to-end: ${total} generated formulas scanned, ${hit} contain #REF!, #NAME? or INDIRECT`);
fs.writeFileSync(path.join(__dirname, 'results', 'v21_equivalence.json'), JSON.stringify({ instances: n, verdictsDiffering: diff, generatedFormulas: total, formulasTriggeringNewRules: hit }, null, 1));
process.exit(diff === 0 && hit === 0 ? 0 : 2);
