'use strict';
/**
 * Runs the worked example of the paper's Figure (anatomy of GroundCheck) through the real verifier, so the
 * messages shown in the figure are the verifier's own output, not hand-written text.
 *   node worked_example.js
 */
const { generateWorkbook } = require('./lib/workbookGen');
const { loadWorkbook } = require('./lib/gas');

const wb = generateWorkbook('sales', 1);
const env = loadWorkbook(wb);
env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
const ctx = env.sandbox.buildDeepContext();
const sheet = wb.sheets ? wb.sheets[0] : null;
const headers = (wb.main && wb.main.headers) || (sheet && sheet.values && sheet.values[0]);
console.log('sheet:', wb.mainSheet || (sheet && sheet.name), 'headers:', JSON.stringify(headers), 'lastRow', wb.lastRow);
const tries = process.argv.slice(2);
(tries.length ? tries : ['=SUMIF(C2:C80,"Flangee",Revenue)']).forEach((f) => {
  const r = env.sandbox.verifyFormula_(f, ctx);
  console.log('\n' + f);
  console.log(JSON.stringify({ valid: r.valid, errors: r.errors, warnings: r.warnings, suspicious: r.suspicious, hints: r.hints }, null, 1));
});
