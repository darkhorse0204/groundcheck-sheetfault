'use strict';
/**
 * Builds the validation pack for the real Google Sheets engine.
 *
 * The benchmark's labels come from HyperFormula, an Excel-flavoured engine. To check that they carry over to
 * Google Sheets, a stratified sample of benchmark instances is evaluated in an actual Google Sheet by the
 * Apps Script in Validate.gs, and the two engines' answers are compared by compare_gsheets.js.
 *
 *   node gsheets/make_pack.js [--per-fault-class 12] [--per-clean-class 6] [--seed 5]
 *
 * Writes gsheets/pack.json (upload it to Google Drive; Validate.gs reads it by file id).
 * The pack holds, per case: the formula, the workbook it runs in, HyperFormula's answer, the answer of the gold
 * formula, and the verdicts of the shipped verifier and GroundCheck, so that the comparison needs nothing else.
 */
const fs = require('fs');
const path = require('path');
const { buildBenchmark } = require('../e1_detection');
const oracle = require('../lib/oracle');
const { DETECTORS } = require('../lib/detectors');
const { makeRng } = require('../lib/rng');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const PER_FAULT = arg('per-fault-class', 12);
const PER_CLEAN = arg('per-clean-class', 6);
const rng = makeRng(arg('seed', 5));

const { instances } = buildBenchmark();
const byClass = {};
instances.forEach((i) => { (byClass[i.cls] = byClass[i.cls] || []).push(i); });

const workbooks = {};
const cases = [];
let id = 0;
Object.keys(byClass).sort().forEach((cls) => {
  const isClean = cls.startsWith('clean:');
  const pick = rng.sample(byClass[cls], isClean ? PER_CLEAN : PER_FAULT);
  pick.forEach((inst) => {
    const wb = inst.wb;
    if (!workbooks[wb.id]) {
      workbooks[wb.id] = { sheetOrder: wb.sheetOrder, main: wb.main, activeCell: wb.activeCell, sheets: wb.sheets, namedRanges: wb.namedRanges };
    }
    const hf = oracle.evaluate(wb, inst.formula);
    const gold = inst.gold ? oracle.evaluate(wb, inst.gold) : null;
    const v1 = DETECTORS.v1(inst), v2 = DETECTORS.v2(inst);
    cases.push({
      id: ++id, cls, label: inst.label, visibility: inst.visibility || null, labelSource: inst.labelSource || 'engine',
      wbId: wb.id, formula: inst.formula, goldFormula: inst.gold || null,
      hf: { ok: hf.ok, value: hf.ok ? hf.value : null, errorType: hf.errorType },
      goldValue: gold && gold.ok ? gold.value : null,
      v1Reject: v1.reject, v2Reject: v2.reject, v2Flag: v2.flag
    });
  });
});
oracle.clearCache();

// consecutive cases of one workbook share it, so Validate.gs builds each workbook once
cases.sort((a, b) => (a.wbId < b.wbId ? -1 : a.wbId > b.wbId ? 1 : a.id - b.id));
const pack = { meta: { created: new Date().toISOString(), perFaultClass: PER_FAULT, perCleanClass: PER_CLEAN, nCases: cases.length, nWorkbooks: Object.keys(workbooks).length }, workbooks, cases };
const out = path.join(__dirname, 'pack.json');
fs.writeFileSync(out, JSON.stringify(pack));
console.log(`pack: ${cases.length} cases over ${Object.keys(workbooks).length} workbooks, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB -> ${out}`);
