'use strict';
/**
 * Task templates: (natural-language request, gold formula, natively computed
 * expected value) for a generated workbook.
 *
 * Mention level controls how the request refers to columns:
 *   'H' (header)  — uses the exact header text ("total Revenue where Region is East")
 *   'S' (synonym) — uses a paraphrase that shares no tokens with the header
 *                   ("total sales for the East territory")
 * The expected value is computed directly from the generated data in JS, then
 * cross-checked against the HyperFormula oracle in validateTasks().
 */
const { rangeOf } = require('./workbookGen');
const oracle = require('./oracle');

const num = (c) => c.kind === 'int' || c.kind === 'money';
const dataCol = (wb, col) => wb.sheets[wb.main].slice(1).map((r) => r[col.index - 1]);

function present(wb, col, rng) { return rng.pick(Array.from(new Set(dataCol(wb, col)))); }

const FRAMES = [
  (x) => `What is the ${x}?`,
  (x) => `Calculate the ${x}.`,
  (x) => `Give me the ${x}.`,
  (x) => `Find the ${x}.`
];
const ORD = { 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' };

function mention(c, level, rng) { return level === 'S' && c.syn && c.syn.length ? rng.pick(c.syn) : c.h.toLowerCase(); }
const mentionExact = (c) => c.h; // exact header casing for the H surface form

function pickCols(wb, rng) {
  const cats = wb.columns.filter((c) => c.kind === 'cat');
  const nums = wb.columns.filter(num);
  return { cats, nums, id: wb.columns.find((c) => c.kind === 'id') };
}

const sumBy = (vals, keep, nums) => nums.reduce((a, v, i) => (keep(vals[i]) ? a + v : a), 0);

const TEMPLATES = {
  agg(wb, rng, L) {
    const { nums } = pickCols(wb, rng);
    const n = rng.pick(nums);
    const fn = rng.pick(['SUM', 'AVERAGE', 'MAX', 'MIN']);
    const words = { SUM: ['total', 'combined'], AVERAGE: ['average', 'mean'], MAX: ['highest', 'largest'], MIN: ['lowest', 'smallest'] }[fn];
    const nm = L === 'H' ? mentionExact(n) : mention(n, L, rng);
    const v = dataCol(wb, n);
    const expected = { SUM: v.reduce((a, b) => a + b, 0), AVERAGE: v.reduce((a, b) => a + b, 0) / v.length, MAX: Math.max(...v), MIN: Math.min(...v) }[fn];
    return { nl: rng.pick(FRAMES)(`${rng.pick(words)} ${nm}`), gold: `=${fn}(${rangeOf(n, wb)})`, expected };
  },
  count_rows(wb, rng, L) {
    const { id } = pickCols(wb, rng);
    return { nl: 'How many records are in the table?', gold: `=COUNTA(${rangeOf(id, wb)})`, expected: wb.nRows };
  },
  cond_sum(wb, rng, L) {
    const { cats, nums } = pickCols(wb, rng);
    const c = rng.pick(cats), n = rng.pick(nums), val = present(wb, c, rng);
    const nl = L === 'H' ? `Sum ${mentionExact(n)} where ${mentionExact(c)} is ${val}.`
      : `What is the total ${mention(n, L, rng)} for the ${val} ${mention(c, L, rng)}?`;
    const cv = dataCol(wb, c), nv = dataCol(wb, n);
    return { nl, gold: `=SUMIF(${rangeOf(c, wb)},"${val}",${rangeOf(n, wb)})`, expected: sumBy(cv, (x) => x === val, nv) };
  },
  cond_count(wb, rng, L) {
    const { cats } = pickCols(wb, rng);
    const c = rng.pick(cats), val = present(wb, c, rng);
    const nl = L === 'H' ? `Count rows where ${mentionExact(c)} is ${val}.` : `How many entries belong to the ${val} ${mention(c, L, rng)}?`;
    return { nl, gold: `=COUNTIF(${rangeOf(c, wb)},"${val}")`, expected: dataCol(wb, c).filter((x) => x === val).length };
  },
  cond_avg(wb, rng, L) {
    const { cats, nums } = pickCols(wb, rng);
    const c = rng.pick(cats), n = rng.pick(nums), val = present(wb, c, rng);
    const nl = L === 'H' ? `Average ${mentionExact(n)} where ${mentionExact(c)} is ${val}.` : `What is the mean ${mention(n, L, rng)} for the ${val} ${mention(c, L, rng)}?`;
    const cv = dataCol(wb, c), nv = dataCol(wb, n);
    const sel = nv.filter((_, i) => cv[i] === val);
    return { nl, gold: `=AVERAGEIF(${rangeOf(c, wb)},"${val}",${rangeOf(n, wb)})`, expected: sel.reduce((a, b) => a + b, 0) / sel.length };
  },
  two_cond(wb, rng, L) {
    const { cats, nums } = pickCols(wb, rng);
    const [c1, c2] = rng.sample(cats, 2);
    const n = rng.pick(nums);
    const v1 = present(wb, c1, rng), v2 = present(wb, c2, rng);
    const cv1 = dataCol(wb, c1), cv2 = dataCol(wb, c2), nv = dataCol(wb, n);
    const asCount = rng.chance(0.4);
    const keep = (i) => cv1[i] === v1 && cv2[i] === v2;
    if (asCount) {
      const nl = L === 'H' ? `Count rows where ${mentionExact(c1)} is ${v1} and ${mentionExact(c2)} is ${v2}.`
        : `How many entries are for the ${v1} ${mention(c1, L, rng)} and the ${v2} ${mention(c2, L, rng)}?`;
      return { nl, gold: `=COUNTIFS(${rangeOf(c1, wb)},"${v1}",${rangeOf(c2, wb)},"${v2}")`, expected: cv1.filter((_, i) => keep(i)).length };
    }
    const nl = L === 'H' ? `Sum ${mentionExact(n)} where ${mentionExact(c1)} is ${v1} and ${mentionExact(c2)} is ${v2}.`
      : `Total ${mention(n, L, rng)} for the ${v1} ${mention(c1, L, rng)} and the ${v2} ${mention(c2, L, rng)}?`;
    return { nl, gold: `=SUMIFS(${rangeOf(n, wb)},${rangeOf(c1, wb)},"${v1}",${rangeOf(c2, wb)},"${v2}")`, expected: nv.reduce((a, v, i) => (keep(i) ? a + v : a), 0) };
  },
  lookup(wb, rng, L) {
    const key = rng.pick(wb.lookup.keys), vc = rng.pick(wb.lookup.cols);
    const row = wb.sheets[wb.lookup.sheet].find((r, i) => i > 0 && r[0] === key);
    const nm = L === 'H' ? vc.h : mention(vc, L, rng);
    const nl = L === 'H' ? `Look up the ${nm} for ${key} in the ${wb.lookup.sheet} sheet.` : `What is the ${nm} of ${key}? It is on the ${wb.lookup.sheet} sheet.`;
    const lastLetter = wb.lookup.cols[wb.lookup.cols.length - 1].letter;
    return { nl, gold: `=VLOOKUP("${key}",${wb.lookup.sheet}!A:${lastLetter},${vc.index},FALSE)`, expected: row[vc.index - 1], usesLookup: true };
  },
  pct_of_total(wb, rng, L) {
    const { cats, nums } = pickCols(wb, rng);
    const c = rng.pick(cats), n = rng.pick(nums), val = present(wb, c, rng);
    const cv = dataCol(wb, c), nv = dataCol(wb, n);
    const nl = L === 'H' ? `What fraction of total ${mentionExact(n)} comes from ${mentionExact(c)} ${val}? Give a decimal between 0 and 1.`
      : `What share of all ${mention(n, L, rng)} is from the ${val} ${mention(c, L, rng)}? Answer as a decimal between 0 and 1.`;
    return { nl, gold: `=SUMIF(${rangeOf(c, wb)},"${val}",${rangeOf(n, wb)})/SUM(${rangeOf(n, wb)})`, expected: sumBy(cv, (x) => x === val, nv) / nv.reduce((a, b) => a + b, 0) };
  },
  count_gt(wb, rng, L) {
    const { nums } = pickCols(wb, rng);
    const n = rng.pick(nums);
    const v = dataCol(wb, n).slice().sort((a, b) => a - b);
    const t = Math.round(v[Math.floor(v.length / 2)]);
    const nm = L === 'H' ? mentionExact(n) : mention(n, L, rng);
    return { nl: `How many rows have ${nm} greater than ${t}?`, gold: `=COUNTIF(${rangeOf(n, wb)},">${t}")`, expected: v.filter((x) => x > t).length };
  },
  max_if(wb, rng, L) {
    const { cats, nums } = pickCols(wb, rng);
    const c = rng.pick(cats), n = rng.pick(nums), val = present(wb, c, rng);
    const cv = dataCol(wb, c), nv = dataCol(wb, n);
    const nl = L === 'H' ? `What is the maximum ${mentionExact(n)} where ${mentionExact(c)} is ${val}?` : `What is the largest ${mention(n, L, rng)} among the ${val} ${mention(c, L, rng)} rows?`;
    return { nl, gold: `=MAXIFS(${rangeOf(n, wb)},${rangeOf(c, wb)},"${val}")`, expected: Math.max(...nv.filter((_, i) => cv[i] === val)) };
  },
  sumproduct(wb, rng, L) {
    const { nums } = pickCols(wb, rng);
    const [a, b] = rng.sample(nums, 2);
    const av = dataCol(wb, a), bv = dataCol(wb, b);
    const nl = L === 'H' ? `Sum of ${mentionExact(a)} multiplied by ${mentionExact(b)} across all rows.` : `Add up ${mention(a, L, rng)} times ${mention(b, L, rng)} for every row.`;
    return { nl, gold: `=SUMPRODUCT(${rangeOf(a, wb)},${rangeOf(b, wb)})`, expected: av.reduce((s, x, i) => s + x * bv[i], 0) };
  },
  round_avg(wb, rng, L) {
    const { nums } = pickCols(wb, rng);
    const n = rng.pick(nums);
    const v = dataCol(wb, n);
    const nm = L === 'H' ? mentionExact(n) : mention(n, L, rng);
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    return { nl: `Average ${nm}, rounded to 1 decimal place.`, gold: `=ROUND(AVERAGE(${rangeOf(n, wb)}),1)`, expected: Math.round(avg * 10 + 1e-9) / 10 };
  },
  large_k(wb, rng, L) {
    const { nums } = pickCols(wb, rng);
    const n = rng.pick(nums), k = rng.int(2, 5);
    const v = dataCol(wb, n).slice().sort((a, b) => b - a);
    const nm = L === 'H' ? mentionExact(n) : mention(n, L, rng);
    return { nl: `What is the ${ORD[k]} highest ${nm}?`, gold: `=LARGE(${rangeOf(n, wb)},${k})`, expected: v[k - 1] };
  },
  top_cat(wb, rng, L) {
    const { cats } = pickCols(wb, rng);
    const money = wb.columns.filter((c) => c.kind === 'money');
    if (!money.length) return null;
    const c = rng.pick(cats), n = rng.pick(money);
    const nv = dataCol(wb, n), cv = dataCol(wb, c);
    const mx = Math.max(...nv);
    const nl = L === 'H' ? `Which ${mentionExact(c)} has the highest single ${mentionExact(n)}?` : `Which ${mention(c, L, rng)} is behind the single largest ${mention(n, L, rng)}?`;
    return { nl, gold: `=INDEX(${rangeOf(c, wb)},MATCH(MAX(${rangeOf(n, wb)}),${rangeOf(n, wb)},0))`, expected: cv[nv.indexOf(mx)] };
  }
};

const WEIGHTS = { agg: 2, count_rows: 1, cond_sum: 3, cond_count: 2, cond_avg: 2, two_cond: 2, lookup: 2, pct_of_total: 1, count_gt: 1, max_if: 1, sumproduct: 1, round_avg: 1, large_k: 1, top_cat: 1 };

function genTasks(wb, rng, n, opts) {
  opts = opts || {};
  const bag = [];
  Object.keys(WEIGHTS).forEach((k) => { for (let i = 0; i < WEIGHTS[k]; i++) bag.push(k); });
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 20) {
    const type = rng.pick(bag);
    if (opts.types && !opts.types.includes(type)) continue;
    const level = opts.level || (rng.chance(0.5) ? 'H' : 'S');
    const t = TEMPLATES[type](wb, rng, level);
    if (!t) continue;
    out.push(Object.assign({ id: `${wb.id}#${out.length}`, wbId: wb.id, type, level }, t));
  }
  return out;
}

/** Cross-check native expected values against the independent oracle. Returns mismatches. */
function validateTasks(wb, tasks) {
  const bad = [];
  tasks.forEach((t) => {
    const r = oracle.evaluate(wb, t.gold);
    if (!r.ok || !oracle.valuesEqual(r.value, t.expected)) bad.push({ task: t, oracle: r });
  });
  return bad;
}

module.exports = { genTasks, validateTasks, TEMPLATES, WEIGHTS };
