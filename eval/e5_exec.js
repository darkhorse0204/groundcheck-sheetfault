'use strict';
/**
 * Second-stage arm of the end-to-end study: verify -> repair -> EXECUTE.
 *
 * GroundCheck accepts a formula that nevertheless evaluates to an error (a loud fault the workbook-state checks do not
 * see), and repair can leave one behind. This arm adds an execution check: after the verifier accepts a candidate, the
 * formula is evaluated in the workbook (here by the independent engine; in the add-on, in a scratch cell) and, if the
 * cell would show an error, the error is fed back to the model for another attempt. It cannot see silent faults.
 *
 *   node e5_exec.js --backend ollama:llama3.1:8b --main results/e5_llama3.1-8b_letters.jsonl --out results/e5_exec_llama3.1-8b.jsonl [--resume]
 *
 * The first attempt is regenerated with the same seed as in the main run and must reproduce the stored formula
 * exactly; tasks where it does not are recorded as diverged and left out of the comparison, so the arm is paired
 * with the stored GroundCheck-feedback result for the same tasks.
 */
const fs = require('fs');
const path = require('path');
const { generateWorkbook, DOMAIN_NAMES } = require('./lib/workbookGen');
const { makeRng, hashSeed } = require('./lib/rng');
const { genTasks } = require('./lib/tasks');
const oracle = require('./lib/oracle');
const { loadWorkbook } = require('./lib/gas');
const { makeBackend } = require('./lib/llm');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BACKEND = opt('backend', 'mock');
const MAIN = opt('main', '');
const OUT = opt('out', 'results/e5_exec_mock.jsonl');
const N_TASKS = parseInt(opt('tasks', '360'), 10);
const LIMIT = parseInt(opt('limit', '0'), 10);
const RESUME = args.includes('--resume');
const SEED_BASE = parseInt(opt('seed-base', '500'), 10);
const WORKBOOKS_PER_DOMAIN = 4;

function buildTasks() {
  const tasks = [];
  const perWb = Math.ceil(N_TASKS / (DOMAIN_NAMES.length * WORKBOOKS_PER_DOMAIN));
  for (const domain of DOMAIN_NAMES) {
    for (let k = 0; k < WORKBOOKS_PER_DOMAIN; k++) {
      const seed = SEED_BASE + k;
      const wb = generateWorkbook(domain, seed);
      const rng = makeRng(hashSeed('e5', domain, seed));
      genTasks(wb, rng, perWb).forEach((t) => tasks.push({ wb, task: t }));
    }
  }
  tasks.sort((a, b) => hashSeed(a.task.id) - hashSeed(b.task.id));
  return tasks.slice(0, N_TASKS);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const score = (wb, task, f) => { const r = oracle.evaluate(wb, f); return { correct: r.ok && oracle.valuesEqual(r.value, task.expected), loudError: r.ok ? null : r.errorType, value: r.ok ? r.value : null }; };

function main() {
  const backend = makeBackend(BACKEND, {});
  const stored = new Map();
  if (MAIN) fs.readFileSync(MAIN, 'utf8').split('\n').filter(Boolean).forEach((l) => { const r = JSON.parse(l); stored.set(r.taskId, r); });
  const tasks = buildTasks();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const done = new Set();
  if (RESUME && fs.existsSync(OUT)) fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).forEach((l) => done.add(JSON.parse(l).taskId));
  else fs.writeFileSync(OUT, '');
  const t0 = Date.now();
  let n = 0;

  for (const { wb, task } of tasks) {
    if (done.has(task.id)) continue;
    if (MAIN && !stored.has(task.id)) continue;
    if (LIMIT && n >= LIMIT) break;
    n++;
    const env = loadWorkbook(wb, { urlFetchStub: backend.fetchStub });
    env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
    const sb = env.sandbox;
    const context = sb.buildDeepContext();
    let retrievalStr = '';
    try { retrievalStr = sb.ContextRetriever.retrieve(task.nl, {}).contextString || ''; } catch (e) { /* non-fatal, as in production */ }

    backend.setBucket('attempt1:retr');
    backend.setSeed(hashSeed(task.id, 'retr', 0));
    let s = sb.FormulaAgent.plan({ prompt: task.nl, context, chatHistory: [], retrievalContext: retrievalStr });
    s.attempt = 0;
    s = sb.FormulaAgent.execute(s);
    const rec = { taskId: task.id, backend: BACKEND, attempt1: s.candidate.formula };
    const was = stored.get(task.id);
    rec.attempt1Same = was ? was.attempt1.retr && was.attempt1.retr.formula === s.candidate.formula : null;

    // verify -> repair -> execute
    const trail = [{ formula: s.candidate.formula }];
    backend.setBucket('repair:exec');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const f = s.candidate.formula;
      const v = sb.verifyFormula_(f, context);
      const ex = oracle.evaluate(wb, f);
      const execFail = v.valid && !ex.ok;
      trail[trail.length - 1].verdict = { valid: v.valid, executes: ex.ok, error: ex.ok ? null : ex.errorType };
      if (v.valid && ex.ok) break;
      s.verification = v;
      s.attempt = attempt;
      backend.setSeed(hashSeed(task.id, 'exec', attempt));
      try {
        if (execFail) {
          // the verifier accepted it but the cell would show an error: tell the model what the cell shows
          const orig = sb.buildRetryFeedback_;
          sb.buildRetryFeedback_ = () => `Your formula ${f} was accepted but evaluates to the error ${ex.errorType} in this workbook. Write a formula that evaluates without error.`;
          try { Object.assign(s, sb.FormulaAgent.retry(s)); } finally { sb.buildRetryFeedback_ = orig; }
        } else {
          Object.assign(s, sb.FormulaAgent.retry(s)); // ordinary GroundCheck feedback
        }
      } catch (e) { trail.push({ error: e.message }); break; }
      trail.push({ formula: s.candidate.formula });
    }
    const finals = trail.filter((t) => t.formula !== undefined);
    const finalFormula = finals[finals.length - 1].formula;
    rec.exec = { attempts: finals.length, formulas: finals.map((t) => t.formula), final: finalFormula, score: score(wb, task, finalFormula) };
    rec.usage = JSON.parse(JSON.stringify(backend.state.buckets)); backend.state.buckets = {};
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    if (n % 5 === 0) console.error(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${n} tasks done`);
    oracle.clearCache();
  }
  console.error('finished');
}
main();
