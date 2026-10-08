'use strict';
/**
 * E1 — Fault detection on the formula-fault benchmark.
 *
 *   node e1_detection.js [--tag name] [--detectors none,syntax,lint,v1,v2] [--seeds 12]
 *
 * Builds the benchmark deterministically (6 domains x N seeds), runs each
 * detector over every instance, writes results/e1_<tag>.json.
 */
const fs = require('fs');
const path = require('path');
const { generateWorkbook, DOMAIN_NAMES } = require('./lib/workbookGen');
const { makeRng } = require('./lib/rng');
const { genTasks, validateTasks } = require('./lib/tasks');
const faults = require('./lib/faults');
const oracle = require('./lib/oracle');
const { DETECTORS, clearCaches } = require('./lib/detectors');
const { wilson } = require('./lib/stats');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const TAG = opt('tag', 'main');
const SEEDS = parseInt(opt('seeds', '12'), 10);
const DET = opt('detectors', 'none,syntax,lint,v1,v2').split(',');
const TASKS_PER_WB = parseInt(opt('tasks', '12'), 10);

const GROUPS = {
  structural: ['unbalanced_paren', 'unbalanced_quote', 'missing_equals', 'injection'],
  symbol: ['ghost_function', 'ghost_sheet', 'ghost_column', 'header_as_name', 'query_col_oob'],
  shape: ['lookup_index_oob', 'range_size_mismatch'],
  grounding: ['ghost_value', 'type_mismatch'],
  circular: ['self_reference', 'range_contains_self', 'column_contains_self', 'cycle_indirect_cell', 'cycle_indirect_range'],
  semantic: ['wrong_numeric_col', 'wrong_function']
};

function buildBenchmark() {
  const instances = [];
  let extraDropped = 0;
  for (const domain of DOMAIN_NAMES) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const wb = generateWorkbook(domain, seed);
      const rng = makeRng(seed * 977 + domain.length * 31);
      const tasks = genTasks(wb, rng, TASKS_PER_WB);
      const bad = validateTasks(wb, tasks);
      if (bad.length) throw new Error(`oracle/native mismatch in ${wb.id}`);

      instances.push(...faults.buildInstances(wb, tasks, rng));
      instances.push(...faults.buildCircularInstances(wb, rng, 12));
      instances.push(...faults.buildQueryInstances(wb, rng, 2));

      faults.extraCleanFormulas(wb).forEach((e) => {
        if (e.v) {
          const r = oracle.evaluate(wb, e.f);
          if (!r.ok) { extraDropped++; return; } // my own handwritten formula was invalid for this workbook -> don't use as a negative
        }
        instances.push({ cls: e.custom ? 'clean:custom_fn' : 'clean:extra', label: 'clean', formula: e.f, wbId: wb.id, wb, taskId: null, oracleChecked: e.v });
      });
      oracle.clearCache(); // labels are final once the workbook's instances are built; free the engines
    }
  }
  return { instances, extraDropped };
}

function main() {
  const t0 = Date.now();
  const { instances, extraDropped } = buildBenchmark();
  console.error(`benchmark: ${instances.length} instances (${instances.filter((i) => i.label === 'fault').length} faults, ${instances.filter((i) => i.label === 'clean').length} clean); handwritten-invalid dropped: ${extraDropped}; ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const records = [];
  instances.forEach((inst, idx) => {
    const rec = { id: idx, cls: inst.cls, label: inst.label, visibility: inst.visibility || null, wbId: inst.wbId, formula: inst.formula, d: {} };
    DET.forEach((name) => {
      try { rec.d[name] = DETECTORS[name](inst); } catch (e) { rec.d[name] = { reject: false, flag: false, crashed: e.message }; }
    });
    records.push(rec);
    if (idx % 2000 === 0) { console.error(`  ${idx}/${instances.length}`); }
    if (idx % 150 === 0) clearCaches();
  });

  const summary = summarize(records);
  const out = { tag: TAG, seeds: SEEDS, tasksPerWorkbook: TASKS_PER_WB, nInstances: records.length, extraDropped, groups: GROUPS, summary, records: records.map(slim) };
  const dir = path.join(__dirname, 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `e1_${TAG}.json`), JSON.stringify(out));
  console.error(`wrote results/e1_${TAG}.json  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  printSummary(summary);
}

function slim(r) {
  const d = {};
  Object.keys(r.d).forEach((k) => { d[k] = [r.d[k].reject ? 1 : 0, r.d[k].flag ? 1 : 0]; });
  return { id: r.id, cls: r.cls, label: r.label, vis: r.visibility, wb: r.wbId, f: r.formula, d };
}

function rate(recs, det, which) {
  const k = recs.filter((r) => r.d[det][which]).length;
  return wilson(k, recs.length);
}

function summarize(records) {
  const faultsR = records.filter((r) => r.label === 'fault');
  const cleanR = records.filter((r) => r.label === 'clean');
  const classes = Array.from(new Set(faultsR.map((r) => r.cls)));
  const cleanClasses = Array.from(new Set(cleanR.map((r) => r.cls)));
  const s = { perClass: {}, perClean: {}, overall: {}, byVisibility: {}, byGroup: {} };

  DET.forEach((det) => {
    s.perClass[det] = {};
    classes.forEach((c) => {
      const rs = faultsR.filter((r) => r.cls === c);
      s.perClass[det][c] = { n: rs.length, reject: rate(rs, det, 'reject'), flag: rate(rs, det, 'flag') };
    });
    s.perClean[det] = {};
    cleanClasses.forEach((c) => {
      const rs = cleanR.filter((r) => r.cls === c);
      s.perClean[det][c] = { n: rs.length, reject: rate(rs, det, 'reject'), flag: rate(rs, det, 'flag') };
    });
    ['reject', 'flag'].forEach((pol) => {
      const tp = faultsR.filter((r) => r.d[det][pol]).length;
      const fp = cleanR.filter((r) => r.d[det][pol]).length;
      const fn = faultsR.length - tp;
      const precision = tp + fp ? tp / (tp + fp) : NaN;
      const recall = tp / faultsR.length;
      s.overall[det] = s.overall[det] || {};
      s.overall[det][pol] = { tp, fp, fn, precision, recall, f1: 2 * precision * recall / (precision + recall), fpr: wilson(fp, cleanR.length), recallCI: wilson(tp, faultsR.length) };
    });
    s.byVisibility[det] = {};
    ['loud', 'silent'].forEach((v) => {
      const rs = faultsR.filter((r) => r.visibility === v);
      s.byVisibility[det][v] = { n: rs.length, reject: rate(rs, det, 'reject'), flag: rate(rs, det, 'flag') };
    });
    s.byGroup[det] = {};
    Object.keys(GROUPS).forEach((g) => {
      const rs = faultsR.filter((r) => GROUPS[g].includes(r.cls));
      s.byGroup[det][g] = { n: rs.length, reject: rate(rs, det, 'reject'), flag: rate(rs, det, 'flag') };
    });
  });
  s.counts = { faults: faultsR.length, clean: cleanR.length, perClass: Object.fromEntries(classes.map((c) => [c, faultsR.filter((r) => r.cls === c).length])), perCleanClass: Object.fromEntries(cleanClasses.map((c) => [c, cleanR.filter((r) => r.cls === c).length])) };
  return s;
}

function pct(x) { return (100 * x).toFixed(1).padStart(5); }

function printSummary(s) {
  console.log(`\nfaults=${s.counts.faults} clean=${s.counts.clean}`);
  console.log('\nOVERALL (policy: reject | flag)');
  DET.forEach((d) => {
    const o = s.overall[d];
    console.log(d.padEnd(8), `reject: P=${pct(o.reject.precision)} R=${pct(o.reject.recall)} F1=${pct(o.reject.f1)} FPR=${pct(o.reject.fpr.p)} | flag: P=${pct(o.flag.precision)} R=${pct(o.flag.recall)} F1=${pct(o.flag.f1)} FPR=${pct(o.flag.fpr.p)}`);
  });
  console.log('\nPER-CLASS recall (reject/flag %):  ' + DET.join('  '));
  Object.keys(s.counts.perClass).forEach((c) => {
    console.log(c.padEnd(22), String(s.counts.perClass[c]).padStart(4), DET.map((d) => `${pct(s.perClass[d][c].reject.p)}/${pct(s.perClass[d][c].flag.p)}`).join('  '));
  });
  console.log('\nCLEAN FPR (reject/flag %)');
  Object.keys(s.counts.perCleanClass).forEach((c) => {
    console.log(c.padEnd(22), String(s.counts.perCleanClass[c]).padStart(4), DET.map((d) => `${pct(s.perClean[d][c].reject.p)}/${pct(s.perClean[d][c].flag.p)}`).join('  '));
  });
  console.log('\nBY VISIBILITY (reject/flag %)');
  ['loud', 'silent'].forEach((v) => console.log(v.padEnd(8), DET.map((d) => `${pct(s.byVisibility[d][v].reject.p)}/${pct(s.byVisibility[d][v].flag.p)}`).join('  ')));
}

if (require.main === module) main();
module.exports = { buildBenchmark, GROUPS };
