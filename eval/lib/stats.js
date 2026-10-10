'use strict';
// Small statistics toolkit: Wilson intervals for proportions, percentile
// bootstrap for means/differences, exact McNemar test for paired binary outcomes.
const { makeRng } = require('./rng');

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function median(xs) { return quantile(xs.slice().sort((a, b) => a - b), 0.5); }

/** Wilson score interval for k successes out of n (95% by default). */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN, n };
  const p = k / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), n };
}

/** Percentile bootstrap CI for a statistic of one sample. */
function bootstrapCI(xs, stat = mean, iters = 2000, seed = 1) {
  const rng = makeRng(seed);
  const n = xs.length;
  const vals = [];
  for (let i = 0; i < iters; i++) {
    const s = new Array(n);
    for (let j = 0; j < n; j++) s[j] = xs[Math.floor(rng.next() * n)];
    vals.push(stat(s));
  }
  vals.sort((a, b) => a - b);
  return { est: stat(xs), lo: quantile(vals, 0.025), hi: quantile(vals, 0.975) };
}

/** Paired bootstrap CI for mean(a_i - b_i). */
function pairedBootstrapDiff(a, b, iters = 5000, seed = 7) {
  const d = a.map((x, i) => x - b[i]);
  return bootstrapCI(d, mean, iters, seed);
}

function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact two-sided McNemar test (binomial) on discordant counts b (A-only) and c (B-only). */
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** Compare two paired boolean vectors: returns discordant counts + exact p. */
function pairedBinaryTest(a, b) {
  let onlyA = 0, onlyB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) onlyA++;
    else if (!a[i] && b[i]) onlyB++;
  }
  return { onlyA, onlyB, p: mcnemarExact(onlyA, onlyB) };
}

/**
 * Holm-Bonferroni step-down adjustment of a family of p-values (controls the family-wise error rate).
 * Returns the adjusted p-values in the input order.
 */
function holm(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adj = new Array(m);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adj[i] = running;
  });
  return adj;
}

/**
 * Cluster (two-stage) bootstrap: resample CLUSTERS with replacement, keep each cluster's observations together.
 * `clusters` is an array of per-cluster summaries; `stat` maps a resampled array of summaries to a number.
 * Observations within a workbook share data and templates, so they are not independent; resampling workbooks
 * gives intervals that respect that.
 */
function clusterBootstrap(clusters, stat, iters = 2000, seed = 11) {
  const rng = makeRng(seed);
  const n = clusters.length;
  const vals = [];
  for (let i = 0; i < iters; i++) {
    const s = new Array(n);
    for (let j = 0; j < n; j++) s[j] = clusters[Math.floor(rng.next() * n)];
    vals.push(stat(s));
  }
  vals.sort((a, b) => a - b);
  return { est: stat(clusters), lo: quantile(vals, 0.025), hi: quantile(vals, 0.975) };
}

module.exports = { mean, sd, median, quantile, wilson, bootstrapCI, pairedBootstrapDiff, mcnemarExact, pairedBinaryTest, holm, clusterBootstrap };
