'use strict';
/**
 * Pre-registration for a confirmation set of real-world formulas. Run BEFORE the confirmation data is scored (and,
 * for the first set, before it was downloaded). It records the SHA-256 of the verifier sources and the analysis
 * plan; the scoring script (e1b_realworld.js, tags "fresh" and "fresh2") refuses to run if the hashes no longer
 * match, so any change to the verifier after this point is visible and the set can no longer be called untouched.
 *
 *   node freeze_verifier.js [--verifier <file>] [--out <file>] [--data <text>]   # write the freeze (once)
 *   node freeze_verifier.js --check [--verifier <file>] [--out <file>]           # verify the hashes
 *
 * Defaults: the repository's Verification.js and results/fresh_freeze.json (confirmation set 1). The second
 * confirmation set freezes the extended verifier kept in baselines/Verification.v2.1.js: --out results/fresh2_freeze.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const VERIFIER = arg('verifier', path.join(ROOT, 'Verification.js'));
const OUT = arg('out', path.join(__dirname, 'results', 'fresh_freeze.json'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const current = () => ({ 'Verification.js': sha(VERIFIER), 'FormulaParser.js': sha(path.join(ROOT, 'FormulaParser.js')), 'Config.js': sha(path.join(ROOT, 'Config.js')) });

if (process.argv.includes('--check')) {
  const frozen = JSON.parse(fs.readFileSync(OUT, 'utf8')).sha256;
  const now = current();
  const bad = Object.keys(now).filter((f) => frozen[f] !== now[f]);
  if (bad.length) { console.error('verifier changed since the freeze: ' + bad.join(', ')); process.exit(1); }
  console.log('verifier matches the freeze');
} else {
  if (fs.existsSync(OUT)) { console.error('freeze already exists: ' + OUT); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify({
    frozenAt: new Date().toISOString(),
    verifierFile: path.relative(ROOT, VERIFIER).replace(/\\/g, '/'),
    sha256: current(),
    plan: {
      data: arg('data', 'Sheetpedia workbooks from a part of the release archive disjoint from the development and held-out sets (first 500 MB), shuffled with seed 2025, first 300 loadable workbooks with formulas, up to 25 formulas each'),
      primary: 'share of formulas rejected by the shipped verifier (v1) and by GroundCheck (v2), with a workbook-clustered bootstrap interval',
      secondary: 'rejection categories, agreement of rejections with the independent engine, flag rate, where the two verifiers disagree',
      rule: 'scored once with the frozen verifier; no verifier change is made after seeing these results, and any defect found is reported as a limitation'
    }
  }, null, 1));
  console.log('froze', current());
}
