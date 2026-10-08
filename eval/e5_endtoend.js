'use strict';
/**
 * E5 — End-to-end study with real LLMs.
 *
 *   node e5_endtoend.js --backend ollama:llama3.1:8b --out results/e5_llama31_8b.jsonl [--tasks 240] [--limit N] [--resume]
 *
 * For every natural-language task the PRODUCTION FormulaAgent (Agents.js) is run
 * unmodified inside the GAS sandbox, with Api.js's UrlFetchApp call redirected to
 * the chosen LLM backend. One trajectory per task is recorded:
 *
 *   attempt 1, flat context     (active-sheet context only: how the add-on shipped)
 *   attempt 1, retrieved ctx    (flat + ContextRetriever's ranked cross-sheet context)
 *   then, forking from attempt 1 with retrieved context, up to 2 repair attempts under:
 *     resample   no feedback, just ask again            (controls for "more samples")
 *     generic    "your formula was invalid, try again"  (feedback without diagnostics)
 *     v1fb       diagnostics from the shipped verifier  (commit 44a3f4f)
 *     v2fb       diagnostics from the grounded verifier (this work), repair on errors
 *     v2fb+susp  as v2fb, but "suspicious" findings also trigger repair
 *
 * Every candidate is scored by execution against the independent oracle
 * (HyperFormula): correct = evaluates without error to the gold value.
 * Raw trajectories go to the .jsonl file; analysis is done in analyze_e5.js.
 */
const fs = require('fs');
const path = require('path');
const { generateWorkbook, DOMAIN_NAMES } = require('./lib/workbookGen');
const { makeRng, hashSeed } = require('./lib/rng');
const { genTasks } = require('./lib/tasks');
const oracle = require('./lib/oracle');
const { loadWorkbook, readBaseline } = require('./lib/gas');
const { makeBackend } = require('./lib/llm');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BACKEND = opt('backend', 'mock');
const OUT = opt('out', 'results/e5_mock.jsonl');
const N_TASKS = parseInt(opt('tasks', '240'), 10);
const LIMIT = parseInt(opt('limit', '0'), 10);
const RESUME = args.includes('--resume');
// --engine-file: run with an alternative SpreadsheetEngine.js (e.g. eval/baselines/SpreadsheetEngine.v1.js,
//   the chunk format shipped before column letters were added); --skip-flat: only the retrieved-context arm.
const ENGINE_FILE = opt('engine-file', '');
const SKIP_FLAT = args.includes('--skip-flat');
const ENGINE_OVERRIDES = ENGINE_FILE ? { 'SpreadsheetEngine.js': fs.readFileSync(ENGINE_FILE, 'utf8') } : undefined;
const WORKBOOKS_PER_DOMAIN = 4;
// --seed-base: workbook seeds are SEED_BASE..SEED_BASE+3 per domain. 500 is the main task set; a different
// base gives a fresh held-out task set (used to confirm results after the chunk format was fixed).
const SEED_BASE = parseInt(opt('seed-base', '500'), 10);
// --traj-seed: sampling seed of the model trajectories (0 = the runs of the main study). A different value
// reruns the same tasks with fresh sampling, to measure run-to-run variation.
const TRAJ = parseInt(opt('traj-seed', '0'), 10);
const tseed = (...parts) => (TRAJ ? hashSeed(...parts, 'traj' + TRAJ) : hashSeed(...parts));

const STRATEGIES = ['resample', 'generic', 'v1fb', 'v2fb', 'v2fb+susp'];

// ---- task set (deterministic) ----
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
  // interleave domains so a partial run is still representative
  tasks.sort((a, b) => hashSeed(a.task.id) - hashSeed(b.task.id));
  return tasks.slice(0, N_TASKS);
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function score(wb, task, formula) {
  const r = oracle.evaluate(wb, formula);
  return { correct: r.ok && oracle.valuesEqual(r.value, task.expected), loudError: r.ok ? null : r.errorType, value: r.ok ? r.value : null };
}

function verdict(env, formula, ctx, withSuspicious) {
  const v = env.sandbox.verifyFormula_(formula, ctx);
  const needsRepair = withSuspicious ? (!v.valid || v.suspicious.length > 0) : !v.valid;
  return { valid: v.valid, errors: v.errors, warnings: v.warnings, suspicious: v.suspicious || [], needsRepair, raw: v };
}

function main() {
  const backend = makeBackend(BACKEND, {});
  const tasks = buildTasks();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const done = new Set();
  if (RESUME && fs.existsSync(OUT)) fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).forEach((l) => done.add(JSON.parse(l).taskId));
  else fs.writeFileSync(OUT, '');

  const v1Src = readBaseline('Verification.v1.js');
  const t0 = Date.now();
  let n = 0;

  for (const { wb, task } of tasks) {
    if (done.has(task.id)) continue;
    if (LIMIT && n >= LIMIT) break;
    n++;

    const env2 = loadWorkbook(wb, { urlFetchStub: backend.fetchStub, sourceOverrides: ENGINE_OVERRIDES });
    const env1 = loadWorkbook(wb, { urlFetchStub: backend.fetchStub, sourceOverrides: { 'Verification.js': v1Src } });
    [env1, env2].forEach((e) => { e.sandbox.console = { log() {}, warn() {}, error() {}, info() {} }; });
    const sb = env2.sandbox;
    const context = sb.buildDeepContext();
    let retrievalStr = '';
    try { retrievalStr = sb.ContextRetriever.retrieve(task.nl, {}).contextString || ''; } catch (e) { /* non-fatal, as in production */ }

    const rec = { taskId: task.id, domain: wb.domain, type: task.type, level: task.level, nl: task.nl, gold: task.gold, usesLookup: !!task.usesLookup, backend: BACKEND, attempt1: {}, strategies: {}, usage: {} };

    function generate(ctxMode) {
      backend.setBucket('attempt1:' + ctxMode);
      backend.setSeed(tseed(task.id, ctxMode, 0));
      let s = sb.FormulaAgent.plan({ prompt: task.nl, context, chatHistory: [], retrievalContext: ctxMode === 'retr' ? retrievalStr : '' });
      s.attempt = 0;
      s = sb.FormulaAgent.execute(s);
      return s;
    }

    // ---- attempt 1 under both context modes ----
    const sessions = {};
    for (const ctxMode of SKIP_FLAT ? ['retr'] : ['flat', 'retr']) {
      let s;
      try { s = generate(ctxMode); } catch (e) { rec.attempt1[ctxMode] = { error: e.message }; continue; }
      sessions[ctxMode] = s;
      const f = s.candidate.formula;
      rec.attempt1[ctxMode] = {
        formula: f, score: score(wb, task, f),
        v1: slimVerdict(verdict(env1, f, context, false)),
        v2: slimVerdict(verdict(env2, f, context, true)),
        promptChars: s.systemPrompt.length
      };
    }

    // ---- repair strategies, forked from attempt 1 with retrieved context ----
    const base = sessions.retr;
    if (base) {
      for (const strat of STRATEGIES) {
        const s = clone({ prompt: base.prompt, context: base.context, chatHistory: base.chatHistory, contextStr: base.contextStr, memoryHints: base.memoryHints, systemPrompt: base.systemPrompt, contents: base.contents, candidate: base.candidate, maxRetries: base.maxRetries });
        s.attempt = 0;
        const trail = [{ formula: s.candidate.formula }];
        backend.setBucket('repair:' + strat);
        for (let attempt = 1; attempt <= 2; attempt++) {
          const useV1 = strat === 'v1fb';
          const vv = verdict(useV1 ? env1 : env2, s.candidate.formula, context, strat === 'v2fb+susp');
          trail[trail.length - 1].verdict = { valid: vv.valid, needsRepair: vv.needsRepair, nErrors: vv.errors.length, nSusp: vv.suspicious.length };
          if (!vv.needsRepair) break;
          s.verification = vv.raw;
          s.attempt = attempt;
          backend.setSeed(tseed(task.id, strat, attempt));
          try {
            if (strat === 'resample') {
              s.contents = s.contents; // identical prompt, no feedback
              Object.assign(s, sb.FormulaAgent.execute(s));
            } else if (strat === 'generic') {
              const orig = sb.buildRetryFeedback_;
              sb.buildRetryFeedback_ = () => 'Your formula was invalid. Please try again.';
              try { Object.assign(s, sb.FormulaAgent.retry(s)); } finally { sb.buildRetryFeedback_ = orig; }
            } else if (strat === 'v1fb') {
              const orig = sb.buildRetryFeedback_;
              sb.buildRetryFeedback_ = env1.sandbox.buildRetryFeedback_;
              try { Object.assign(s, sb.FormulaAgent.retry(s)); } finally { sb.buildRetryFeedback_ = orig; }
            } else {
              Object.assign(s, sb.FormulaAgent.retry(s));
            }
          } catch (e) { trail.push({ error: e.message }); break; }
          trail.push({ formula: s.candidate.formula });
        }
        const last = trail[trail.length - 1];
        const finalFormula = last.formula !== undefined ? last.formula : trail.filter((t) => t.formula).pop().formula;
        const fv2 = verdict(env2, finalFormula, context, false);
        rec.strategies[strat] = { attempts: trail.filter((t) => t.formula !== undefined).length, formulas: trail.map((t) => t.formula), final: finalFormula, score: score(wb, task, finalFormula), finalValidV2: fv2.valid };
      }
    }

    rec.usage = JSON.parse(JSON.stringify(backend.state.buckets));
    backend.state.buckets = {};
    rec.trajSeed = TRAJ;
    rec.modelVersions = backend.state.modelVersions; // what the API says answered (hosted backends)
    backend.state.modelVersions = {};
    rec.elapsedMs = Date.now() - t0;
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
    if (n % 5 === 0) console.error(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${n} tasks done (${done.size + n}/${tasks.length})`);
    oracle.clearCache();
  }
  console.error('finished');
}

function slimVerdict(v) { return { valid: v.valid, errors: v.errors, warnings: v.warnings, suspicious: v.suspicious }; }

main();
