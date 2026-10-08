'use strict';
/**
 * Fault-injection operators for the formula-fault benchmark.
 *
 * Each operator turns a gold (correct) formula into a faulty one. Ground-truth
 * labels come from an independent engine (oracle.js), never from the verifier
 * under test:
 *   - the candidate is FAULTY iff the oracle returns an error or a value that
 *     differs from the gold value ("equivalent mutants" are therefore removed
 *     from the fault set and reused as benign negatives);
 *   - VISIBILITY is 'loud' if the engine returns an error value (the user would
 *     see #REF!/#NAME?/...) and 'silent' if it evaluates to a wrong number/text
 *     (the dangerous case: a plausible wrong answer is written into the sheet).
 * The QUERY class is labelled by construction (the oracle has no QUERY).
 */
const { rangeOf, colLetter } = require('./workbookGen');
const oracle = require('./oracle');

const RANGE_RE = /(?:('?[A-Za-z_][A-Za-z0-9_ ]*'?)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/g;
const COLRANGE_RE = /(?:([A-Za-z_][A-Za-z0-9_]*)!)?\b([A-Z]{1,3}):([A-Z]{1,3})\b/g;

function findRanges(f) {
  const out = [];
  let m;
  RANGE_RE.lastIndex = 0;
  while ((m = RANGE_RE.exec(f)) !== null) {
    // skip matches that are actually function names like LOG10( — none occur in gold formulas
    const a = m[2].replace(/\$/g, ''), b = m[3] ? m[3].replace(/\$/g, '') : null;
    out.push({ text: m[0], index: m.index, sheet: m[1] || null, a, b });
  }
  return out;
}

function splice(f, r, replacement) { return f.slice(0, r.index) + replacement + f.slice(r.index + r.text.length); }

function colOf(a) { return a.match(/^[A-Z]+/)[0]; }
function rowOf(a) { return parseInt(a.match(/\d+$/)[0], 10); }

const HALLUCINATED = {
  SUM: ['SUMALL', 'TOTAL'], SUMIF: ['SUMIFF', 'SUMIF_BY'], COUNTIF: ['COUNTIFF', 'COUNTWHERE'],
  AVERAGEIF: ['AVGIF', 'AVERAGEIFF'], VLOOKUP: ['VLOOKUPS', 'LOOKUPV'], MAX: ['MAXIMUM'], MIN: ['MINIMUM'],
  AVERAGE: ['AVG', 'MEAN'], LARGE: ['NTHLARGEST'], ROUND: ['ROUNDTO'], COUNTIFS: ['COUNTIFSS'],
  SUMIFS: ['SUMIFSS', 'SUMSIFS'], MAXIFS: ['MAXIF'], COUNTA: ['COUNTALL'], SUMPRODUCT: ['SUMPRODUCTS'], INDEX: ['INDEXOF']
};
const SWAP_FN = { SUM: 'AVERAGE', AVERAGE: 'SUM', MAX: 'MIN', MIN: 'MAX', SUMIF: 'AVERAGEIF', AVERAGEIF: 'SUMIF', SUMIFS: 'AVERAGEIF', LARGE: 'SMALL', COUNTIF: 'COUNTIFS' };

function firstFunction(f) { const m = f.match(/\b([A-Z][A-Z0-9_]*)\s*\(/); return m ? m[1] : null; }

function dataRanges(f, wb) {
  // ranges on the main sheet, with >=2 rows (i.e. data ranges rather than whole-column lookups)
  return findRanges(f).filter((r) => !r.sheet && r.b && rowOf(r.a) === 2 && colOf(r.a) === colOf(r.b));
}

const kindOfLetter = (wb, letter) => (wb.columns.find((c) => c.letter === letter) || {}).kind;

const OPS = {
  // ---- structural ----
  unbalanced_paren: { fn: (g) => (g.endsWith(')') ? g.slice(0, -1) : null) },
  unbalanced_quote: { fn: (g) => { const i = g.indexOf('"'); return i < 0 ? null : g.slice(0, i) + g.slice(i + 1); } },
  missing_equals: { fn: (g) => g.slice(1) },
  injection: { fn: (g, wb, rng) => (rng.chance(0.5) ? g + '+DDE("cmd|\' /C calc\'!A0")' : '=HYPERLINK("javascript:alert(1)","' + g.slice(1, 12) + '")') },

  // ---- hallucinated symbols ----
  ghost_function: {
    fn: (g, wb, rng) => { const fnName = firstFunction(g); const alts = HALLUCINATED[fnName]; return alts ? g.replace(fnName + '(', rng.pick(alts) + '(') : null; }
  },
  ghost_sheet: {
    fn: (g, wb, rng) => {
      const m = g.match(/\b([A-Za-z_][A-Za-z0-9_]*)!/);
      if (m) return g.replace(m[1] + '!', rng.pick([m[1].replace(/s$/, ''), 'Sheet2', 'Data', m[1] + '_old']) + '!');
      const rs = dataRanges(g, wb);
      return rs.length ? splice(g, rs[0], 'Data!' + rs[0].text) : null;
    }
  },
  ghost_column: {
    fn: (g, wb, rng) => {
      const rs = dataRanges(g, wb);
      if (!rs.length) return null;
      const r = rs[rs.length - 1];
      const L = colLetter(wb.lastCol + rng.int(1, 6)); // beyond the used range (and not the active column)
      return splice(g, r, `${L}${rowOf(r.a)}:${L}${rowOf(r.b)}`);
    }
  },
  header_as_name: {
    fn: (g, wb, rng) => {
      const rs = dataRanges(g, wb);
      if (!rs.length) return null;
      const r = rng.pick(rs);
      const col = wb.columns.find((c) => c.letter === colOf(r.a));
      return col ? splice(g, r, col.h.replace(/\s+/g, '')) : null;
    }
  },

  // ---- arity / shape ----
  lookup_index_oob: {
    fn: (g, wb) => (/VLOOKUP\(/.test(g) ? g.replace(/,(\d+),FALSE\)/, `,${wb.lookup.cols.length + 1 + 2},FALSE)`) : null)
  },
  range_size_mismatch: {
    fn: (g, wb, rng) => {
      if (!/(SUMIF|COUNTIF|AVERAGEIF|MAXIFS|SUMIFS|COUNTIFS|SUMPRODUCT)/.test(g)) return null;
      if (/\)\/[A-Z]+\(/.test(g)) return null; // two separate calls: shortening one range is a truncation error, not a size mismatch
      const rs = dataRanges(g, wb);
      if (rs.length < 2 || wb.lastRow < 25) return null;
      const r = rs[rs.length - 1];
      return splice(g, r, `${r.a}:${colOf(r.b)}${rowOf(r.b) - rng.int(5, 15)}`);
    }
  },

  // ---- value / type grounding ----
  ghost_value: {
    fn: (g, wb, rng) => {
      const m = g.match(/"([A-Za-z][A-Za-z0-9 ]*)"/);
      if (!m || /^[<>=]/.test(m[1])) return null;
      const v = m[1];
      return g.replace(`"${v}"`, `"${rng.pick([v + 's', 'North' + v.toLowerCase(), v.slice(0, -1) + 'x', 'All ' + v])}"`);
    }
  },
  type_mismatch: {
    fn: (g, wb, rng) => {
      if (!/^=(SUM|AVERAGE|MAX|MIN|LARGE|SUMIF|SUMIFS|AVERAGEIF|MAXIFS)\(/.test(g)) return null;
      const rs = dataRanges(g, wb).filter((r) => kindOfLetter(wb, colOf(r.a)) === 'int' || kindOfLetter(wb, colOf(r.a)) === 'money');
      if (!rs.length) return null;
      const r = rs[0];
      const text = rng.pick(wb.columns.filter((c) => c.kind === 'cat'));
      return splice(g, r, `${text.letter}${rowOf(r.a)}:${text.letter}${rowOf(r.b)}`);
    }
  },

  // ---- semantic swaps the verifier cannot know are wrong (ceiling analysis) ----
  wrong_numeric_col: {
    fn: (g, wb, rng) => {
      const nums = wb.columns.filter((c) => c.kind === 'int' || c.kind === 'money');
      const rs = dataRanges(g, wb).filter((r) => nums.some((c) => c.letter === colOf(r.a)));
      if (!rs.length) return null;
      const r = rs[rs.length - 1];
      const others = nums.filter((c) => c.letter !== colOf(r.a));
      if (!others.length) return null;
      const o = rng.pick(others);
      return splice(g, r, `${o.letter}${rowOf(r.a)}:${o.letter}${rowOf(r.b)}`);
    }
  },
  wrong_function: {
    fn: (g) => { const f = firstFunction(g); return SWAP_FN[f] ? g.replace(f + '(', SWAP_FN[f] + '(') : null; }
  }
};

/** Benign (semantics-preserving) variants — used as negatives; oracle confirms equivalence. */
const BENIGN = {
  headroom: (g, wb, rng) => { const rs = dataRanges(g, wb); if (!rs.length) return null; const r = rs[rs.length - 1]; return splice(g, r, `${r.a}:${colOf(r.b)}${wb.lastRow + rng.int(50, 900)}`); },
  absolute: (g, wb) => { const rs = dataRanges(g, wb); if (!rs.length) return null; return rs.slice().reverse().reduce((f, r) => splice(f, r, `$${colOf(r.a)}$${rowOf(r.a)}:$${colOf(r.b)}$${rowOf(r.b)}`), g); },
  wholecol: (g, wb) => { const rs = dataRanges(g, wb); if (!rs.length) return null; const r = rs[0]; return splice(g, r, `${colOf(r.a)}:${colOf(r.b)}`); },
  lowercase: (g) => g.replace(/\b([A-Z][A-Z0-9_]*)\s*\(/g, (m, fn) => fn.toLowerCase() + '('),
  spacing: (g) => g.replace(/,/g, ', ').replace(/([<>]=?)/g, ' $1 ').replace(/^=/, '= ').replace(/^= /, '='),
  self_sheet: (g, wb) => { const rs = dataRanges(g, wb); if (!rs.length) return null; return rs.slice().reverse().reduce((f, r) => splice(f, r, `${wb.main}!${r.text}`), g); },
  iferror: (g) => `=IFERROR(${g.slice(1)},0)`,
  named_range: (g, wb) => {
    if (!wb.namedRanges.length) return null;
    const nr = wb.namedRanges[0];
    return g.includes(nr.a1) ? g.replace(nr.a1, nr.name) : null;
  }
};

/** Hand-written, valid formulas that exercise syntax the verifier must not reject. */
function extraCleanFormulas(wb) {
  const c = (kind, i) => wb.columns.filter((x) => x.kind === kind)[i || 0];
  const n1 = wb.columns.filter((x) => x.kind === 'int' || x.kind === 'money')[0];
  const n2 = wb.columns.filter((x) => x.kind === 'int' || x.kind === 'money')[1];
  const k1 = c('cat', 0), k2 = c('cat', 1);
  const R = (col) => rangeOf(col, wb);
  const last = wb.lastRow;
  return [
    { f: `=IF(SUM(${R(n1)})>1000,"high","low")`, v: true },
    { f: `=IFERROR(VLOOKUP("${wb.lookup.keys[0]}",${wb.lookup.sheet}!A:${wb.lookup.cols[0].letter},2,0),"n/a")`, v: true },
    { f: `=SUMPRODUCT((${R(k1)}="${wb.columns.find((x) => x === k1).vals[0]}")*(${R(n1)}))`, v: true },
    { f: `=TEXT(SUM(${R(n1)}),"#,##0.00")`, v: true },
    { f: `="Total: "&SUM(${R(n1)})`, v: true },
    { f: `=MEDIAN(${R(n1)})`, v: true },
    { f: `=ROUND(SUM(${R(n1)})/COUNTA(${R(k1)}),2)`, v: true },
    { f: `=COUNTA(UNIQUE(${R(k1)}))`, v: false },
    { f: `=COUNTUNIQUE(${R(k1)})`, v: true },
    { f: `=AVERAGEIFS(${R(n1)},${R(k1)},"${k1.vals[0]}",${R(k2)},"${k2.vals[0]}")`, v: false },
    { f: `=MINIFS(${R(n1)},${R(k1)},"${k1.vals[0]}")`, v: true },
    { f: `=SUMIF(${R(n1)},">="&AVERAGE(${R(n1)}))`, v: true },
    { f: `=LOG10(SUM(${R(n1)}))`, v: true },
    { f: `=SUM(${R(n1)})*1E-3`, v: false },
    { f: `=SUM(${R(n1)})*5%`, v: true },
    { f: `=MAX(${R(n1)})-MIN(${R(n1)})`, v: true },
    { f: `=COUNTIF(${R(n1)},"<>")`, v: true },
    { f: `=IF(ISNUMBER(${n1.letter}2),${n1.letter}2*2,0)`, v: true },
    { f: `=ARRAYFORMULA(${R(n1)}*2)`, v: false },
    { f: `=TEXTJOIN(", ",TRUE,${R(k1)})`, v: false },
    { f: `=INDEX(${R(k1)},MATCH(MAX(${R(n1)}),${R(n1)},0))`, v: true },
    { f: `=RANK(${n1.letter}2,${R(n1)})`, v: false },
    { f: `=IF(${k1.letter}2="A1","x","y")`, v: true },       // string literal that looks like a cell ref
    { f: `=COUNTIF(${R(k1)},"*e*")`, v: true },              // wildcard criterion
    { f: `=${n1.letter}2+${n2 ? n2.letter : n1.letter}2`, v: true },
    { f: `=SUM(${n1.letter}2:${n1.letter}${last})/SUM(${n1.letter}2:${n1.letter}${last})`, v: true },
    { f: `=IF(AND(${n1.letter}2>0,${n1.letter}2<1E9),TRUE,FALSE)`, v: false },
    { f: `=MAXIFS(${R(n1)},${R(k1)},"${k1.vals[0]}",${R(k2)},"${k2.vals[0]}")`, v: true },
    { f: `=ABS(SUM(${R(n1)}))`, v: true },
    { f: `=${wb.lookup.sheet}!B2*2`, v: true },
    { f: `=SUM('${wb.lookup.sheet}'!B2:B${wb.lookup.lastRow})`, v: true },
    { f: `=VLOOKUP(${wb.lookup.keyCol.letter}2,${wb.lookup.sheet}!A:C,2,FALSE)`, v: true },
    { f: `=XLOOKUP("${wb.lookup.keys[0]}",${wb.lookup.sheet}!A2:A${wb.lookup.lastRow},${wb.lookup.sheet}!B2:B${wb.lookup.lastRow})`, v: false },
    { f: `=SUMIFS(${R(n1)},${R(k1)},"<>"&"${k1.vals[0]}")`, v: true },
    { f: `=IFS(SUM(${R(n1)})>100,"a",TRUE,"b")`, v: true },
    { f: `=LEN("${k1.vals[0]}")*2+LEN("A1")`, v: true },
    { f: `=QUERY(A1:${colLetter(wb.lastCol)}${last},"select ${k1.letter}, sum(${n1.letter}) group by ${k1.letter}",1)`, v: false },
    { f: `=LET(x,SUM(${R(n1)}),x*2)`, v: false },
    { f: `=MAP(${R(n1)},LAMBDA(v,v*2))`, v: false },
    { f: `=SUMPRODUCT(--(${R(k1)}="${k1.vals[0]}"),${R(n1)})`, v: false },
    { f: `=IF(${k1.letter}2="","",${k1.letter}2)`, v: true },
    { f: `={1,2,3;4,5,6}`, v: false },
    { f: `=ARRAYFORMULA(IF(${n1.letter}2:${n1.letter}<>"",${n1.letter}2:${n1.letter}*2,""))`, v: false },
    { f: `=SORT(UNIQUE(${R(k1)}))`, v: false },
    { f: `=FILTER(${R(n1)},${R(n1)}>5)`, v: false },
    { f: `=TEXT(TODAY(),"yyyy-mm-dd")`, v: false },
    { f: `=HYPERLINK("https://example.com/a?b=(1)","link (x)")`, v: false },
    { f: `=INDIRECT("${k1.letter}"&ROW())`, v: false },
    { f: `=REGEXMATCH(${k1.letter}2,"^[A-Z]+\(.*\)$")`, v: false },
    { f: `=IFERROR(1/0,"err")`, v: true },
    { f: `=SWITCH(${k1.letter}2,"${k1.vals[0]}",1,"${k1.vals[1]}",2,0)`, v: true },
    { f: `=MAX(0,SUM(${R(n1)})-100)`, v: true },
    { f: `=-SUM(${R(n1)})+(${n1.letter}2+1)^2`, v: true },
    { f: `=COUNTIF(${R(k1)},"<>"&"")`, v: true },
    { f: `=SUM(${n1.letter}2:${n1.letter}${last},${(n2 || n1).letter}2:${(n2 || n1).letter}${last})`, v: true },
    { f: `=AVERAGE(${n1.letter}2:${n1.letter}${last})*AVERAGE(${(n2 || n1).letter}2:${(n2 || n1).letter}${last})`, v: true },
    { f: `=MYTAX(${n1.letter}2)`, v: false, custom: true },
    { f: `=IF(${n1.letter}2>0,CUSTOM_MARGIN(${n1.letter}2),0)`, v: false, custom: true }
  ];
}

/**
 * Build the benchmark. For each workbook and gold task, generate every
 * applicable fault; label with the oracle; keep non-equivalent mutants as
 * faults and equivalent ones as benign negatives.
 */
function buildInstances(wb, tasks, rng) {
  const instances = [];
  const push = (inst) => instances.push(Object.assign({ wbId: wb.id }, inst));

  tasks.forEach((t) => {
    // gold itself is a clean negative
    push({ cls: 'clean:gold', label: 'clean', formula: t.gold, taskId: t.id, wb });

    // benign variants (oracle-confirmed equivalent)
    Object.keys(BENIGN).forEach((name) => {
      const f = BENIGN[name](t.gold, wb, rng);
      if (!f || f === t.gold) return;
      const r = oracle.evaluate(wb, f);
      if (r.ok && oracle.valuesEqual(r.value, t.expected)) push({ cls: 'clean:' + name, label: 'clean', formula: f, taskId: t.id, wb });
    });

    // faults
    Object.keys(OPS).forEach((name) => {
      const op = OPS[name];
      if (op.trap) return; // handled below
      const f = op.fn(t.gold, wb, rng);
      if (!f || f === t.gold) return;
      const r = oracle.evaluate(wb, f);
      const correct = r.ok && oracle.valuesEqual(r.value, t.expected);
      if (correct) return; // coincidental equivalent mutant (same value by chance): neither a fault nor a semantics-preserving variant -> discard
      push({ cls: name, label: 'fault', visibility: r.ok ? 'silent' : 'loud', oracle: r, formula: f, taskId: t.id, gold: t.gold, wb });
    });
  });

  return instances;
}

/**
 * Circular-reference faults, placed where users actually create them: the
 * totals row directly under a numeric column (target cell INSIDE the used
 * column span). Classes:
 *   self_reference        =SUM(F2:F80)+F81          (direct)
 *   range_contains_self   =SUM(F2:F81)              (range spans the target)
 *   column_contains_self  =SUM(F:F)                 (whole-column ref in the same column)
 *   cycle_indirect_cell   =Summary!E1+1  where Summary!E1 = Orders!F81*1.1
 *   cycle_indirect_range  =Summary!E1*2  where Summary!E1 = SUM(Orders!F2:F81)
 * plus benign negatives: the ordinary totals-row formula =SUM(F2:F80).
 */
function buildCircularInstances(wb, rng, n) {
  const out = [];
  const nums = wb.columns.filter((c) => c.kind === 'int' || c.kind === 'money');
  for (let i = 0; i < n; i++) {
    const L = rng.pick(nums);
    const targetRow = wb.lastRow + 1;
    const mk = (suffix) => {
      const v = JSON.parse(JSON.stringify(wb));
      v.id = `${wb.id}@total${L.letter}${i}${suffix}`;
      v.activeCell = `${L.letter}${targetRow}`;
      v.activeCol = L.index;
      return v;
    };
    const add = (cls, formula, variant, expectFault) => {
      const r = oracle.evaluate(variant, formula);
      if (r.ok) return; // the engine saw no cycle, so this is not a circular fault: discard
      out.push({ cls, label: 'fault', visibility: 'loud', oracle: r, formula, wbId: variant.id, wb: variant, taskId: null });
    };
    const fn = rng.pick(['SUM', 'AVERAGE', 'MAX']);
    let v = mk('a');
    add('self_reference', `=${fn}(${L.letter}2:${L.letter}${wb.lastRow})+${L.letter}${targetRow}`, v);
    v = mk('b');
    add('range_contains_self', `=${fn}(${L.letter}2:${L.letter}${targetRow})`, v);
    v = mk('c');
    add('column_contains_self', `=${fn}(${L.letter}:${L.letter})`, v);

    ['cycle_indirect_cell', 'cycle_indirect_range'].forEach((name, k) => {
      const variant = mk('d' + k);
      const trapFormula = name === 'cycle_indirect_cell'
        ? `=${wb.main}!${variant.activeCell}*1.1`
        : `=SUM(${wb.main}!${L.letter}2:${L.letter}${targetRow})`;
      const sheet = variant.sheets.Summary;
      while (sheet.length < 1) sheet.push([]);
      while (sheet[0].length < 5) sheet[0].push('');
      sheet[0][4] = trapFormula; // Summary!E1
      add(name, name === 'cycle_indirect_cell' ? '=Summary!E1+1' : '=Summary!E1*2', variant);
    });

    // benign: the ordinary totals-row formula (valid, not circular)
    v = mk('e');
    const g = `=${fn}(${L.letter}2:${L.letter}${wb.lastRow})`;
    const r = oracle.evaluate(v, g);
    out.push({ cls: 'clean:total_row', label: 'clean', oracle: r, formula: g, wbId: v.id, wb: v, taskId: null });
  }
  return out;
}

/** QUERY column-letter faults, labelled by construction (no QUERY in the oracle). */
function buildQueryInstances(wb, rng, n) {
  const out = [];
  const nums = wb.columns.filter((c) => c.kind === 'int' || c.kind === 'money');
  const cats = wb.columns.filter((c) => c.kind === 'cat');
  const width = wb.lastCol;
  for (let i = 0; i < n; i++) {
    const n1 = rng.pick(nums), k1 = rng.pick(cats);
    const range = `A1:${colLetter(width)}${wb.lastRow}`;
    const bad = colLetter(width + rng.int(1, 5));
    out.push({ cls: 'query_col_oob', label: 'fault', visibility: 'loud', labelSource: 'construction', wbId: wb.id, wb, taskId: null,
      formula: `=QUERY(${range},"select ${k1.letter}, sum(${bad}) group by ${k1.letter}",1)` });
    out.push({ cls: 'clean:query_ok', label: 'clean', labelSource: 'construction', wbId: wb.id, wb, taskId: null,
      formula: `=QUERY(${range},"select ${k1.letter}, sum(${n1.letter}) where ${n1.letter} > 10 group by ${k1.letter}",1)` });
  }
  return out;
}

module.exports = { OPS, BENIGN, buildInstances, buildCircularInstances, buildQueryInstances, extraCleanFormulas, findRanges };
