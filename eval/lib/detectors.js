'use strict';
/**
 * Detectors compared in E1. Every detector maps (formula, workbook) to
 *   { reject: bool, flag: bool }
 * where `reject` = the detector would block the formula (hard error) and
 * `flag` = it would block OR warn. Two policies are reported because a verifier
 * that only warns still lets the formula through.
 */
const { loadWorkbook, readBaseline } = require('./gas');

const envCache = new Map();
function envFor(wb, key, opts) {
  const k = key + '::' + wb.id;
  if (!envCache.has(k)) {
    const env = loadWorkbook(wb, opts);
    env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
    env.context = env.sandbox.buildDeepContext();
    envCache.set(k, env);
    if (envCache.size > 400) envCache.delete(envCache.keys().next().value);
  }
  return envCache.get(k);
}

function stripStrings(f) { return f.replace(/"(?:[^"]|"")*"/g, '""'); }

/** Baseline B1: a lexical sanity check (leading '=', balanced parentheses and quotes). */
function syntaxOnly(formula) {
  if (!formula.startsWith('=')) return true;
  if ((formula.match(/"/g) || []).length % 2 !== 0) return true;
  let d = 0;
  for (const ch of stripStrings(formula)) { if (ch === '(') d++; if (ch === ')') d--; if (d < 0) return true; }
  return d !== 0;
}

let KNOWN = null;
function knownFunctions() {
  if (!KNOWN) {
    const env = loadWorkbook(require('./workbookGen').generateWorkbook('sales', 1));
    KNOWN = new Set(env.sandbox.KNOWN_SHEET_FUNCTIONS_);
  }
  return KNOWN;
}

/** Baseline B2: B1 plus rejecting any function name outside a fixed whitelist (a typical linter). */
function lint(formula) {
  if (syntaxOnly(formula)) return true;
  const names = (stripStrings(formula).match(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g) || []).map((s) => s.replace(/\s*\($/, '').toUpperCase());
  return names.some((n) => !knownFunctions().has(n));
}

function productVerifier(key, sourceOverrides, disabledLayer) {
  return (inst) => {
    // ablations share the 'v2' sandbox (same code) and just flip one layer switch around the call
    const env = envFor(inst.wb, key.startsWith('v2') ? 'v2' : key, { sourceOverrides });
    const layers = env.sandbox.CONFIG.VERIFICATION.LAYERS;
    if (disabledLayer) layers[disabledLayer] = false;
    const t0 = process.hrtime.bigint();
    let res;
    try { res = env.sandbox.verifyFormula_(inst.formula, env.context); } finally { if (disabledLayer) layers[disabledLayer] = true; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const reject = res.valid === false;
    return { reject, flag: reject || (res.warnings && res.warnings.length > 0), ms, errors: res.errors, warnings: res.warnings };
  };
}

const DETECTORS = {
  none: () => ({ reject: false, flag: false }),
  syntax: (inst) => { const r = syntaxOnly(inst.formula); return { reject: r, flag: r }; },
  lint: (inst) => { const r = lint(inst.formula); return { reject: r, flag: r }; },
  v1: productVerifier('v1', { 'Verification.js': readBaseline('Verification.v1.js') }),
  v2: productVerifier('v2', undefined)
};

// Leave-one-layer-out ablations of the current verifier.
['structural', 'symbols', 'bounds', 'shape', 'grounding', 'circular', 'query'].forEach((layer) => {
  DETECTORS['v2-' + layer] = productVerifier('v2-' + layer, undefined, layer);
});

function clearCaches() { envCache.clear(); if (global.gc) global.gc(); }

module.exports = { DETECTORS, productVerifier, envFor, clearCaches };
