'use strict';
/**
 * Scores the verifiers against independent human annotation of real-world formulas.
 *
 *   node annotation/score_annotation.js <dir> [--adjudicated adjudicated.csv] [--decisions rows.json ...]
 *
 *   <dir>  holds annotator_A.csv and annotator_B.csv (filled in independently) and key.json (from make_sheet.js)
 *
 * Annotation labels (see GUIDELINES.md): defect Y / N / U (cannot tell); visibility loud / silent; category.
 *   1. Agreement between the two annotators: raw agreement and Cohen's kappa (three classes, and Y vs N).
 *   2. Disagreements are listed; they enter the scores only through an adjudicated file (id,defect,visibility,category).
 *   3. Detector scores with sampling weights (population / sample size of each stratum): precision, recall and false
 *      positive rate of reject and flag decisions of the shipped verifier and GroundCheck (and of any further
 *      decisions file, matched on workbook+sheet+cell), with a bootstrap over WORKBOOKS (95% intervals).
 *   Items labelled U are excluded and counted. The population excludes formulas that the dataset's PII pass blanked.
 *
 * Writes results/annotation_summary.json.
 */
const fs = require('fs');
const path = require('path');
const csv = require('../lib/csv');
const { makeRng } = require('../lib/rng');
const { quantile } = require('../lib/stats');

const dir = process.argv[2];
if (!dir) { console.error('usage: node annotation/score_annotation.js <dir> [--adjudicated file.csv]'); process.exit(1); }
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : null; };
const key = JSON.parse(fs.readFileSync(path.join(dir, 'key.json'), 'utf8'));
const read = (f) => csv.parseObjects(fs.readFileSync(path.join(dir, f), 'utf8'));
const A = read('annotator_A.csv'), B = read('annotator_B.csv');
const norm = (x) => { const s = String(x || '').trim().toUpperCase(); return s === 'Y' || s === 'N' || s === 'U' ? s : ''; };
const byId = (rows, X) => new Map(rows.map((r) => [Number(r.id), { defect: norm(r[`${X}_defect`]), vis: String(r[`${X}_visibility`] || '').trim().toLowerCase(), cat: String(r[`${X}_category`] || '').trim().toLowerCase() }]));
const a = byId(A, 'A'), b = byId(B, 'B');

// ---- 1. agreement
const kappa = (pairs, classes) => {
  const n = pairs.length; if (!n) return NaN;
  const po = pairs.filter(([x, y]) => x === y).length / n;
  const pe = classes.reduce((s, c) => s + (pairs.filter(([x]) => x === c).length / n) * (pairs.filter(([, y]) => y === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
};
const both = key.items.filter((i) => a.get(i.id) && b.get(i.id) && a.get(i.id).defect && b.get(i.id).defect);
const pairs3 = both.map((i) => [a.get(i.id).defect, b.get(i.id).defect]);
const pairs2 = pairs3.filter(([x, y]) => x !== 'U' && y !== 'U');
const agreement = {
  annotated: both.length, of: key.items.length,
  rawAgreement3: pairs3.filter(([x, y]) => x === y).length / (pairs3.length || 1), kappa3: kappa(pairs3, ['Y', 'N', 'U']),
  rawAgreementYN: pairs2.filter(([x, y]) => x === y).length / (pairs2.length || 1), kappaYN: kappa(pairs2, ['Y', 'N'])
};
const disagree = both.filter((i) => a.get(i.id).defect !== b.get(i.id).defect).map((i) => i.id);
agreement.disagreements = disagree.length;

// ---- 2. final labels
const adjFile = arg('adjudicated');
const adj = new Map();
if (adjFile) csv.parseObjects(fs.readFileSync(adjFile, 'utf8')).forEach((r) => adj.set(Number(r.id), { defect: norm(r.defect), vis: String(r.visibility || '').toLowerCase(), cat: String(r.category || '').toLowerCase() }));
const label = new Map();
key.items.forEach((i) => {
  const x = a.get(i.id), y = b.get(i.id);
  if (!x || !y || !x.defect || !y.defect) return;
  if (x.defect === y.defect) label.set(i.id, { defect: x.defect, vis: x.vis === y.vis ? x.vis : (adj.get(i.id) || {}).vis || '', cat: x.cat === y.cat ? x.cat : (adj.get(i.id) || {}).cat || '' });
  else if (adj.get(i.id) && adj.get(i.id).defect) label.set(i.id, adj.get(i.id));
});
const unresolved = disagree.filter((id) => !label.has(id));

// ---- 3. weighted detector scores
const weight = (s) => key.population[s] / Math.max(1, key.sampled[s]);
const items = key.items.filter((i) => label.has(i.id) && label.get(i.id).defect !== 'U').map((i) => Object.assign({}, i, { w: weight(i.stratum), y: label.get(i.id).defect === 'Y' }));
const excludedU = key.items.filter((i) => label.has(i.id) && label.get(i.id).defect === 'U').length;

// further decisions (e.g. the extended verifier), matched on workbook + sheet + cell
const extra = {};
process.argv.forEach((x, i) => { if (x === '--decisions') { const f = process.argv[i + 1]; const name = path.basename(f).replace(/^e1b_|\.rows\.json$/g, ''); extra[name] = new Map(JSON.parse(fs.readFileSync(f, 'utf8')).rows.map((r) => [`${r.wb}|${r.sheet}|${r.cell}`, r.d.v2])); } });
const itemRows = new Map(); // id -> {sheet, cell} from the annotator file
A.forEach((r) => itemRows.set(Number(r.id), `${r.workbook_file}|${r.sheet}|${r.cell}`));

const detectors = { shipped: (i) => ({ reject: i.v1Reject, flag: i.v1Reject }), groundcheck: (i) => ({ reject: i.v2Reject, flag: i.v2Flag }) };
Object.keys(extra).forEach((n) => { detectors[n] = (i) => { const d = extra[n].get(itemRows.get(i.id)); return d ? { reject: d.reject, flag: d.flag } : { reject: false, flag: false }; }; });

function metrics(sample, det, policy) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  sample.forEach((i) => { const hit = det(i)[policy]; if (hit && i.y) tp += i.w; else if (hit) fp += i.w; else if (i.y) fn += i.w; else tn += i.w; });
  return { precision: tp / (tp + fp), recall: tp / (tp + fn), fpr: fp / (fp + tn), prevalence: (tp + fn) / (tp + fp + fn + tn) };
}
const rng = makeRng(17);
const wbs = [...new Set(items.map((i) => i.wb))];
const members = new Map(wbs.map((w) => [w, items.filter((i) => i.wb === w)]));
function boot(det, policy, iters = 1000) {
  const out = { precision: [], recall: [], fpr: [], prevalence: [] };
  for (let t = 0; t < iters; t++) {
    const s = [];
    for (let k = 0; k < wbs.length; k++) s.push(...members.get(wbs[Math.floor(rng.next() * wbs.length)]));
    const m = metrics(s, det, policy);
    Object.keys(out).forEach((k) => { if (!Number.isNaN(m[k])) out[k].push(m[k]); });
  }
  return Object.fromEntries(Object.keys(out).map((k) => { const v = out[k].sort((x, y) => x - y); return [k, { lo: quantile(v, 0.025), hi: quantile(v, 0.975) }]; }));
}
const scores = {};
Object.keys(detectors).forEach((n) => {
  scores[n] = {};
  ['reject', 'flag'].forEach((p) => { const m = metrics(items, detectors[n], p); const ci = boot(detectors[n], p); scores[n][p] = Object.fromEntries(Object.keys(m).map((k) => [k, { est: m[k], lo: ci[k].lo, hi: ci[k].hi }])); });
});
const cats = {};
items.filter((i) => i.y).forEach((i) => { const c = label.get(i.id).cat || 'unspecified'; cats[c] = (cats[c] || 0) + 1; });
const summary = { dir, agreement, unresolved, excludedU, nScored: items.length, categories: cats, scores, population: key.population, sampled: key.sampled };
fs.mkdirSync(path.join(__dirname, '..', 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'results', 'annotation_summary.json'), JSON.stringify(summary, null, 1));

const pc = (x) => (Number.isNaN(x) ? 'n/a' : (100 * x).toFixed(1));
console.log(`annotated ${agreement.annotated}/${agreement.of}; agreement ${pc(agreement.rawAgreement3)}% (kappa ${agreement.kappa3.toFixed(2)}; Y vs N: ${pc(agreement.rawAgreementYN)}%, kappa ${agreement.kappaYN.toFixed(2)}); ${disagree.length} disagreements, ${unresolved.length} unresolved, ${excludedU} labelled U`);
console.log(`scored ${items.length} items; defect prevalence among the population (weighted): ${pc(scores.groundcheck.reject.prevalence.est)}%`);
Object.keys(scores).forEach((n) => ['reject', 'flag'].forEach((p) => {
  const s = scores[n][p];
  console.log(`  ${n.padEnd(12)} ${p.padEnd(6)} precision ${pc(s.precision.est)} [${pc(s.precision.lo)}, ${pc(s.precision.hi)}]  recall ${pc(s.recall.est)} [${pc(s.recall.lo)}, ${pc(s.recall.hi)}]  FPR ${pc(s.fpr.est)} [${pc(s.fpr.lo)}, ${pc(s.fpr.hi)}]`);
}));
if (unresolved.length) console.log('unresolved disagreements (provide --adjudicated): ' + unresolved.join(', '));
