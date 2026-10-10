'use strict';
/**
 * Tests the annotation tooling on SYNTHETIC annotations (no human judgement is involved and the output means
 * nothing about the verifiers): the sample is built from a real corpus, two simulated annotators label every item
 * from the engine's verdict with random disagreements, and the scorer must run end to end.
 *
 *   node annotation/selftest.js <corpus.json> <rows.json>
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const csv = require('../lib/csv');
const { makeRng } = require('../lib/rng');

const [corpus, rows] = process.argv.slice(2);
const dir = path.join(__dirname, 'selftest_out');
fs.rmSync(dir, { recursive: true, force: true });
let r = spawnSync('node', [path.join(__dirname, 'make_sheet.js'), corpus, rows, '--n', '120', '--out', dir], { encoding: 'utf8' });
console.log(r.stdout + r.stderr);
const key = JSON.parse(fs.readFileSync(path.join(dir, 'key.json'), 'utf8'));
const rng = makeRng(99);
const truth = new Map(key.items.map((i) => [i.id, i.hf && i.hf !== 'ok' ? 'Y' : 'N']));
['A', 'B'].forEach((X) => {
  const f = path.join(dir, `annotator_${X}.csv`);
  const table = csv.parse(fs.readFileSync(f, 'utf8'));
  const head = table[0];
  const col = (n) => head.indexOf(`${X}_${n}`);
  for (let i = 1; i < table.length; i++) {
    const id = Number(table[i][0]);
    let y = truth.get(id);
    if (rng.next() < 0.08) y = y === 'Y' ? 'N' : 'Y';
    if (rng.next() < 0.03) y = 'U';
    table[i][col('defect')] = y; table[i][col('visibility')] = y === 'Y' ? 'loud' : ''; table[i][col('category')] = y === 'Y' ? 'broken-reference' : '';
  }
  fs.writeFileSync(f, csv.stringify(table));
});
r = spawnSync('node', [path.join(__dirname, 'score_annotation.js'), dir], { encoding: 'utf8' });
console.log(r.stdout + r.stderr);
const ok = r.status === 0 && /annotated 120\/120|annotated \d+\/\d+/.test(r.stdout);
fs.rmSync(dir, { recursive: true, force: true });
try { fs.unlinkSync(path.join(__dirname, '..', 'results', 'annotation_summary.json')); } catch (e) { /* none */ }
console.log(ok ? 'SELFTEST PASS (synthetic labels; nothing here is a result)' : 'SELFTEST FAIL');
process.exit(ok ? 0 : 1);
