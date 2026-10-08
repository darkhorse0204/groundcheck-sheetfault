'use strict';
/**
 * E6 — Why not just ask the model to check the formula?
 *
 *   node e6_llm_critic.js --backend ollama:llama3.1:8b [--per-class 20] [--clean 400]
 *
 * A language-model critic is given the same context the formula agent sees
 * (active sheet + retrieved cross-sheet context) and the candidate formula, and
 * must answer VALID or INVALID. It is run on a stratified sample of the SheetFault
 * benchmark and compared, instance by instance, with the deterministic verifier.
 */
const fs = require('fs');
const path = require('path');
const { buildBenchmark, GROUPS } = require('./e1_detection');
const { makeRng } = require('./lib/rng');
const { loadWorkbook } = require('./lib/gas');
const { makeBackend } = require('./lib/llm');
const { wilson } = require('./lib/stats');
const oracle = require('./lib/oracle');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BACKEND = opt('backend', 'ollama:llama3.1:8b');
const PER_CLASS = parseInt(opt('per-class', '20'), 10);
const N_CLEAN = parseInt(opt('clean', '400'), 10);
const OUT = opt('out', 'results/e6_critic.jsonl');

const SYSTEM = [
  'You are a strict spreadsheet formula checker.',
  'You are given the context of a Google Sheets workbook and a formula that is about to be written into the active cell.',
  'Answer VALID if the formula will evaluate without an error and refers only to sheets, columns, functions and values that actually exist in the workbook.',
  'Answer INVALID if it has a syntax error, refers to something that does not exist, creates a circular reference, or applies a function to data it cannot work on.',
  'Reply with the single word VALID or INVALID on the first line, then one short sentence of reasoning.'
].join('\n');

function sample(instances) {
  const rng = makeRng(2026);
  const faults = instances.filter((i) => i.label === 'fault');
  const clean = instances.filter((i) => i.label === 'clean');
  const out = [];
  const classes = Array.from(new Set(faults.map((i) => i.cls)));
  classes.forEach((c) => out.push(...rng.sample(faults.filter((i) => i.cls === c), PER_CLASS)));
  out.push(...rng.sample(clean, N_CLEAN));
  return rng.shuffle(out);
}

function main() {
  const { instances } = buildBenchmark();
  oracle.clearCache();
  const chosen = sample(instances);
  console.error(`sampled ${chosen.length} instances (${chosen.filter((i) => i.label === 'fault').length} faulty)`);
  const backend = makeBackend(BACKEND, { numPredict: 60 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '');
  const t0 = Date.now();
  let n = 0;
  for (const inst of chosen) {
    const env = loadWorkbook(inst.wb, { urlFetchStub: backend.fetchStub });
    env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
    const sb = env.sandbox;
    const ctx = sb.buildDeepContext();
    let retrieval = '';
    try { retrieval = sb.ContextRetriever.retrieve(inst.formula, {}).contextString || ''; } catch (e) { /* non-fatal */ }
    const user = sb.formatContextForPrompt_(ctx) + (retrieval ? '\n\n' + retrieval : '') + `\n\nFormula to check (target cell ${ctx.activeCell}):\n${inst.formula}`;

    backend.setSeed(1);
    let reply = '';
    try {
      const resp = sb.callGemini_({ systemInstruction: SYSTEM, contents: [{ role: 'user', parts: [{ text: user }] }], temperature: 0, agent: 'Critic' });
      reply = sb.extractTextResponse_(resp);
    } catch (e) { reply = 'ERROR ' + e.message; }
    const head = reply.trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, '').toUpperCase();
    const criticReject = head === 'INVALID';
    const v2 = sb.verifyFormula_(inst.formula, ctx);
    fs.appendFileSync(OUT, JSON.stringify({ cls: inst.cls, label: inst.label, vis: inst.visibility || null, formula: inst.formula, criticReject, criticParsed: head === 'VALID' || head === 'INVALID', reply: reply.slice(0, 160), v2Reject: !v2.valid, v2Flag: !v2.valid || v2.warnings.length > 0 }) + '\n');
    n++;
    if (n % 25 === 0) console.error(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${n}/${chosen.length}`);
  }
  console.error('finished');
}

main();
