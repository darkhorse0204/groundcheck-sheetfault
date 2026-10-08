'use strict';
/**
 * Generates paper/generated/*.tex (tables + number macros) from eval/results/*.json.
 * Nothing in the paper's tables or prose numbers is typed by hand: re-run the
 * experiments, re-run this script, rebuild the PDF.
 *
 *   node make_paper_assets.js
 */
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, 'results');
const OUT = path.join(__dirname, '..', 'paper', 'generated');
fs.mkdirSync(OUT, { recursive: true });

const read = (f) => (fs.existsSync(path.join(RES, f)) ? JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8')) : null);
// Float placement is left to the document (main text: top of page; appendix: free), so no [t] here.
// IEEE style: table captions go ABOVE the table and table text is set smaller.
const ieeeTable = (s) => s
  .replace(/\\begin\{(table\*?)\}(?:\[t\])?([\s\S]*?)(\\caption\{[\s\S]*?\}\n\\label\{[^}]*\}\n)\\end\{\1\}/g, (m, env, body, cap) => `\\begin{${env}}${env === 'table*' ? '[!t]' : ''}\n${cap}${body}\\end{${env}}`)
  .replace(/\\centering\\small/g, '\\centering\\footnotesize')
  // single-column tables shrink to the column if they are wider (never enlarged)
  .replace(/(\\begin\{table\}[\s\S]*?)(\\begin\{tabular\}[\s\S]*?\\end\{tabular\})/g, (m, head, tab) => `${head}\\begin{adjustbox}{max width=\\columnwidth}${tab}\\end{adjustbox}`);
const write = (f, s) => fs.writeFileSync(path.join(OUT, f), ieeeTable(s));

const f1 = (x) => (100 * x).toFixed(1);
const f0 = (x) => (100 * x).toFixed(0);
const n0 = (x) => Math.round(x).toLocaleString('en-US').replace(/,/g, '{,}');
const tex = (s) => String(s).replace(/_/g, '\\_').replace(/%/g, '\\%').replace(/&/g, '\\&').replace(/#/g, '\\#');
const ci = (w) => `[${f1(w.lo)}, ${f1(w.hi)}]`;
const bold = (s, cond) => (cond ? `\\textbf{${s}}` : s);

const macros = [];
const DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
// LaTeX control-sequence names are letters only: v1 -> vone, v2 -> vtwo, e1 -> eone ...
const mac = (name, val) => macros.push(`\\newcommand{\\${String(name).replace(/\d/g, (d) => DIGIT[+d]).replace(/[^A-Za-z]/g, '')}}{${val}}`);

// =====================================================================
// E1: SheetFault benchmark
// =====================================================================
const e1 = read('e1_main.json');
if (e1) {
  const S = e1.summary;
  mac('nBenchTotal', n0(e1.nInstances));
  mac('nBenchFaults', n0(S.counts.faults));
  mac('nBenchClean', n0(S.counts.clean));
  mac('nBenchClasses', Object.keys(S.counts.perClass).length);
  // every gold formula passes the engine check at build time (e1_detection.js throws otherwise)
  mac('nBenchGold', n0(S.perClean.v2['clean:gold'].n));
  mac('nBenchWorkbooks', n0(new Set(e1.records.map((r) => r.wb.replace(/[@+].*$/, ''))).size));
  const names = { none: 'Accept all', syntax: 'Syntax only', lint: 'Linter', v1: 'Shipped (v1)', v2: 'GroundCheck' };
  const det = ['none', 'syntax', 'lint', 'v1', 'v2'];

  // ---- overall table ----
  let t = '\\begin{table*}[t]\n\\centering\\small\n\\begin{tabular}{l rrrr rrrr}\n\\toprule\n& \\multicolumn{4}{c}{\\textbf{Reject policy} (block on error)} & \\multicolumn{4}{c}{\\textbf{Flag policy} (error or warning)} \\\\\n\\cmidrule(lr){2-5}\\cmidrule(lr){6-9}\n\\textbf{Detector} & P & R & F1 & FPR & P & R & F1 & FPR \\\\\n\\midrule\n';
  const best = (pol, key) => Math.max(...det.map((d) => (S.overall[d][pol][key] || 0)));
  det.forEach((d) => {
    const o = S.overall[d];
    const cells = ['reject', 'flag'].flatMap((pol) => {
      const x = o[pol];
      const missing = (v) => v === null || v === undefined || Number.isNaN(v); // NaN is serialized as null in JSON
      const p = missing(x.precision) ? '--' : f1(x.precision);
      return [bold(p, d === 'v2' && !missing(x.precision)), bold(f1(x.recall), d === 'v2'), bold(missing(x.f1) ? '--' : f1(x.f1), d === 'v2'), f1(x.fpr.p)];
    });
    t += `${names[d]} & ${cells.join(' & ')} \\\\\n`;
  });
  t += '\\bottomrule\n\\end{tabular}\n\\caption{Fault detection on \\textsc{SheetFault} (' + n0(S.counts.faults) + ' faulty and ' + n0(S.counts.clean) + ' clean formulas, micro-averaged, \\%). \\emph{Reject} counts a formula as detected only if it is blocked; \\emph{flag} also counts warnings. FPR is the share of clean formulas that is rejected or flagged.}\n\\label{tab:e1-overall}\n\\end{table*}\n';
  write('tab_e1_overall.tex', t);
  ['v1', 'v2', 'lint', 'syntax'].forEach((d) => {
    ['reject', 'flag'].forEach((pol) => {
      mac(`e${'one'}${d}${pol}R`, f1(S.overall[d][pol].recall));
      mac(`e${'one'}${d}${pol}F`, f1(S.overall[d][pol].f1));
      mac(`e${'one'}${d}${pol}FPR`, f1(S.overall[d][pol].fpr.p));
      mac(`e${'one'}${d}${pol}P`, isNaN(S.overall[d][pol].precision) ? '--' : f1(S.overall[d][pol].precision));
    });
  });

  // ---- per-class table ----
  const pretty = {
    unbalanced_paren: 'Unbalanced parenthesis', unbalanced_quote: 'Unbalanced quote', missing_equals: 'Missing \\texttt{=}', injection: 'Injection (DDE/JS)',
    ghost_function: 'Hallucinated function', ghost_sheet: 'Non-existent sheet', ghost_column: 'Column beyond data', header_as_name: 'Header used as name', query_col_oob: 'QUERY column out of range',
    lookup_index_oob: 'VLOOKUP index too large', range_size_mismatch: 'Range size mismatch',
    ghost_value: 'Criterion absent from column', type_mismatch: 'Aggregate over text column',
    self_reference: 'Self reference', range_contains_self: 'Range contains own cell', column_contains_self: 'Whole column contains own cell', cycle_indirect_cell: 'Cycle via other cell', cycle_indirect_range: 'Cycle via other range',
    wrong_numeric_col: 'Wrong numeric column', wrong_function: 'Wrong aggregation function'
  };
  const groupNames = { structural: 'Structural', symbol: 'Symbols', shape: 'Shape', grounding: 'Grounding', circular: 'Circularity', semantic: 'Semantic (undetectable by design)' };
  // majority visibility per class
  const vis = {};
  e1.records.filter((r) => r.label === 'fault').forEach((r) => { vis[r.cls] = vis[r.cls] || { loud: 0, silent: 0 }; vis[r.cls][r.vis]++; });
  const cell = (x) => `${f0(x.reject.p)}/${f0(x.flag.p)}`;
  let c = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l c r ccc}\n\\toprule\n\\textbf{Fault class} & \\textbf{Loud} & \\textbf{n} & \\textbf{Linter} & \\textbf{Shipped} & \\textbf{\\gc} \\\\\n\\midrule\n';
  Object.keys(e1.groups).forEach((g, gi) => {
    if (gi > 0) c += '\\addlinespace[2pt]\n';
    c += `\\multicolumn{6}{l}{\\emph{${groupNames[g]}}} \\\\\n`;
    e1.groups[g].forEach((cls) => {
      if (!S.perClass.v2[cls]) return;
      const v = vis[cls] || { loud: 0, silent: 0 };
      const loudShare = v.loud / (v.loud + v.silent);
      const mark = loudShare > 0.95 ? 'yes' : loudShare < 0.05 ? 'no' : `${f0(loudShare)}\\%`;
      c += `~~${pretty[cls] || tex(cls)} & ${mark} &${n0(S.perClass.v2[cls].n)} & ${cell(S.perClass.lint[cls])} & ${cell(S.perClass.v1[cls])} & ${bold(cell(S.perClass.v2[cls]), true)} \\\\\n`;
    });
  });
  c += '\\bottomrule\n\\end{tabular}\n\\caption{Recall per fault class, as reject/flag \\%. \\emph{Loud}: the independent engine returns an error value (the user would see it); otherwise the wrong formula evaluates silently to a plausible but wrong value. The two semantic classes are valid formulas that answer the wrong question; no verifier that cannot see the user\'s intent can reject them.}\n\\label{tab:e1-classes}\n\\end{table}\n';
  write('tab_e1_classes.tex', c);

  // ---- ablation table ----
  const layers = ['structural', 'symbols', 'bounds', 'shape', 'grounding', 'circular', 'query'];
  const lname = { structural: 'structural + parse', symbols: 'symbols', bounds: 'bounds', shape: 'shape', grounding: 'grounding', circular: 'circularity', query: 'QUERY columns' };
  let a = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l rr rr}\n\\toprule\n& \\multicolumn{2}{c}{\\textbf{Reject}} & \\multicolumn{2}{c}{\\textbf{Flag}} \\\\\n\\cmidrule(lr){2-3}\\cmidrule(lr){4-5}\n\\textbf{Configuration} & R & F1 & R & F1 \\\\\n\\midrule\n';
  a += `All layers & ${f1(S.overall.v2.reject.recall)} & ${f1(S.overall.v2.reject.f1)} & ${f1(S.overall.v2.flag.recall)} & ${f1(S.overall.v2.flag.f1)} \\\\\n`;
  layers.forEach((l) => {
    const o = S.overall['v2-' + l];
    if (!o) return;
    a += `$-$ ${lname[l]} & ${f1(o.reject.recall)} & ${f1(o.reject.f1)} & ${f1(o.flag.recall)} & ${f1(o.flag.f1)} \\\\\n`;
    mac(`abl${l}RejectR`, f1(o.reject.recall)); mac(`abl${l}RejectF`, f1(o.reject.f1));
  });
  a += '\\bottomrule\n\\end{tabular}\n\\caption{Leave-one-layer-out ablation of the verifier on \\textsc{SheetFault} (\\%).}\n\\label{tab:e1-ablation}\n\\end{table}\n';
  write('tab_e1_ablation.tex', a);

  // ---- visibility ----
  ['loud', 'silent'].forEach((v) => {
    mac(`vis${v}N`, n0(S.byVisibility.v2[v].n));
    ['v1', 'v2'].forEach((d) => { mac(`vis${v}${d}Reject`, f1(S.byVisibility[d][v].reject.p)); mac(`vis${v}${d}Flag`, f1(S.byVisibility[d][v].flag.p)); });
  });
  // per-class helper macros for prose
  ['range_contains_self', 'column_contains_self', 'cycle_indirect_range', 'ghost_function', 'ghost_sheet', 'header_as_name', 'type_mismatch', 'ghost_value', 'wrong_numeric_col', 'wrong_function', 'range_size_mismatch', 'lookup_index_oob'].forEach((cls) => {
    if (!S.perClass.v1[cls]) return;
    const key = cls.replace(/_/g, '');
    ['v1', 'v2'].forEach((d) => { mac(`cls${key}${d}Reject`, f0(S.perClass[d][cls].reject.p)); mac(`cls${key}${d}Flag`, f0(S.perClass[d][cls].flag.p)); });
    mac(`cls${key}N`, n0(S.perClass.v2[cls].n));
  });
  // clean-class FPR for v1 flag
  const cleanFlag = (d, k) => (S.perClean[d][k] ? f1(S.perClean[d][k].flag.p) : '--');
  mac('cleanHeadroomVone', cleanFlag('v1', 'clean:headroom'));
  mac('cleanGoldVone', cleanFlag('v1', 'clean:gold'));
  mac('cleanExtraVone', cleanFlag('v1', 'clean:extra'));
  mac('cleanCustomVtwoFlag', cleanFlag('v2', 'clean:custom_fn'));
  mac('cleanTotalrowVone', cleanFlag('v1', 'clean:total_row'));
}

// =====================================================================
// E1b: real-world formulas
// =====================================================================
const rw = read('e1b_test.json'), rwPost = read('e1b_test_posthoc.json'), rwDev = read('e1b_dev.json');
if (rw) {
  const S = rw.summary;
  const t2 = S.categories.v2, t1 = S.categories.v1;
  mac('rwWorkbooks', n0(S.workbooks)); mac('rwFormulas', n0(S.formulas));
  ['v1', 'v2'].forEach((d) => { mac(`rw${d}Reject`, f1(S[d].reject.p)); mac(`rw${d}Flag`, f1(S[d].flag.p)); mac(`rw${d}RejectN`, n0(Object.values(S.categories[d]).reduce((x, y) => x + y.n, 0))); });
  if (rwPost) { mac('rwvtwoRejectPost', f1(rwPost.summary.v2.reject.p)); mac('rwvtwoFlagPost', f1(rwPost.summary.v2.flag.p)); }
  if (rwDev) { mac('rwDevFormulas', n0(rwDev.summary.formulas)); mac('rwDevvtwoReject', f1(rwDev.summary.v2.reject.p)); mac('rwDevvoneReject', f1(rwDev.summary.v1.reject.p)); }

  const labels = { ghost: 'Reference to a sheet absent from the workbook', circ: 'Circular reference (range contains own cell)', col: 'Range wholly beyond the used columns', empty: 'Empty formula (\\texttt{=} only)', syntax: 'Syntax error (text typed as a formula)', name: 'Unresolved bare name', fn: 'Unknown, near-miss function name', shape: 'Argument / range-size mismatch', other: 'Other' };
  const notes = { ghost: 'sheet missing from the released file; engine: \\#REF!, or masked by IFERROR', circ: 'engine: cycle', col: 'mostly COUNTA on empty cells (fixed post hoc)', empty: 'formula text blanked by the dataset\'s PII pass', syntax: 'e.g. \\texttt{=Product Y}', name: '\\texttt{=P}', fn: 'SORTBY, ACONCAT: not Sheets functions', shape: 'SUMIF with unequal ranges (spreadsheet products differ)', other: '' };
  // notes per category are in the appendix text; the table keeps the counts
  const shortLabels = { ghost: 'Sheet absent from workbook', circ: 'Circular reference', col: 'Range beyond used columns', empty: 'Empty formula (\\texttt{=})', syntax: 'Syntax error', name: 'Unresolved bare name', fn: 'Unknown function name', shape: 'Argument / range mismatch', other: 'Other' };
  let r = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r r r}\n\\toprule\n\\textbf{Rejection reason (\\gc)} & \\textbf{n} & \\textbf{Engine error} & \\textbf{Engine ok} \\\\\n\\midrule\n';
  Object.keys(labels).forEach((k) => {
    if (!t2[k]) return;
    r += `${shortLabels[k]} & ${t2[k].n} & ${t2[k].engineErr} & ${t2[k].engineOk} \\\\\n`;
  });
  const tot = Object.values(t2).reduce((a, x) => ({ n: a.n + x.n, e: a.e + x.engineErr, o: a.o + x.engineOk }), { n: 0, e: 0, o: 0 });
  r += `\\midrule\n\\textbf{Total rejected} & ${tot.n} & ${tot.e} & ${tot.o} \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{What GroundCheck rejects among ${n0(S.formulas)} real-world formulas in the held-out Sheetpedia sample (${f1(S.v2.reject.p)}\\% rejected). \\textquotedblleft{}Engine\\textquotedblright{} is HyperFormula evaluating the original formula in its workbook. No cached results exist in the release, so there are no ground-truth labels; rejections are adjudicated by category (Appendix~\\ref{app:results}).}\n\\label{tab:e1b}\n\\end{table}\n`;
  write('tab_e1b.tex', r);
  // the same breakdown for the confirmation set (scored once with the frozen verifier)
  const rwF = read('e1b_fresh.json');
  if (rwF) {
    const tF = rwF.summary.categories.v2, SF = rwF.summary;
    let rf = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r r r}\n\\toprule\n\\textbf{Rejection reason (\\gc)} & \\textbf{n} & \\textbf{Engine error} & \\textbf{Engine ok} \\\\\n\\midrule\n';
    Object.keys(labels).forEach((k) => { if (tF[k]) rf += `${shortLabels[k]} & ${tF[k].n} & ${tF[k].engineErr} & ${tF[k].engineOk} \\\\\n`; });
    const totF = Object.values(tF).reduce((a, x) => ({ n: a.n + x.n, e: a.e + x.engineErr, o: a.o + x.engineOk }), { n: 0, e: 0, o: 0 });
    rf += `\\midrule\n\\textbf{Total rejected} & ${totF.n} & ${totF.e} & ${totF.o} \\\\\n\\bottomrule\n\\end{tabular}\n\\caption{What GroundCheck rejects among ${n0(SF.formulas)} real-world formulas of the confirmation set, scored once with the frozen verifier (${f1(SF.v2.reject.p)}\\% rejected). \\textquotedblleft{}Engine\\textquotedblright{} is HyperFormula evaluating the original formula in its workbook.}\n\\label{tab:e1b-fresh}\n\\end{table}\n`;
    write('tab_e1b_fresh.tex', rf);
  }
  Object.keys(t2).forEach((k) => { mac(`rwcat${k}`, t2[k].n); mac(`rwcat${k}Err`, t2[k].engineErr); mac(`rwcat${k}Ok`, t2[k].engineOk); });
  mac('rwRejTotal', tot.n); mac('rwRejEngineErr', tot.e);
  // ghost-sheet rejections that the engine calls ok: how many are IFERROR-wrapped?
  mac('rwGhostOk', S.ghostOk); mac('rwGhostOkMasked', S.ghostOkMasked);
  // v1 comparison: share of v1 rejections that are ghost sheets
  mac('rwvoneGhost', n0(Object.values(t1).reduce((a, x) => a + x.n, 0)));
}

// =====================================================================
// E4: SSRF
// =====================================================================
const e4 = read('e4_ssrf.json');
if (e4) {
  const o = e4.overall;
  mac('ssrfBlock', e4.corpus.block); mac('ssrfAllow', e4.corpus.allow);
  ['v1', 'v2'].forEach((d) => { mac(`ssrf${d}Recall`, f1(o[d].blockRecall.p)); mac(`ssrf${d}Bypass`, o[d].bypasses); mac(`ssrf${d}FalseBlock`, f1(o[d].falseBlockRate.p)); mac(`ssrf${d}FalseN`, o[d].falseBlocks); });
  mac('ssrfvtwoCILo', f1(o.v2.blockRecall.lo));
  let t = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r rr}\n\\toprule\n\\textbf{Category} & \\textbf{n} & \\textbf{v1} & \\textbf{v2} \\\\\n\\midrule\n';
  Object.keys(e4.perCategory.v1).forEach((cat) => {
    const a = e4.perCategory.v1[cat], b = e4.perCategory.v2[cat];
    const shortCat = tex(cat.replace('public IPs whose digits contain private-looking substrings', 'public IPs with private-looking digits').replace('boundary addresses (just outside private ranges)', 'boundary public addresses').replace('benign URLs containing suspicious substrings', 'benign URLs with suspicious substrings'));
    t += `${a.want === 'block' ? '$\\ast$ ' : ''}${shortCat} & ${a.n} & ${a.correct} & ${bold(String(b.correct), true)} \\\\\n`;
  });
  t += '\\bottomrule\n\\end{tabular}\n\\caption{SSRF corpus: URLs handled correctly (blocked if $\\ast$, allowed otherwise) by the shipped substring filter (v1) and the parse-and-classify validator (v2).}\n\\label{tab:ssrf}\n\\end{table}\n';
  write('tab_ssrf.tex', t);
}

// =====================================================================
// E3: scalability
// =====================================================================
const e3 = read('e3_scalability.json');
if (e3) {
  let t = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{rrr rr rr}\n\\toprule\n& & & \\multicolumn{2}{c}{\\textbf{Analyze}} & \\multicolumn{2}{c}{\\textbf{Verify} (calls)} \\\\\n\\cmidrule(lr){4-5}\\cmidrule(lr){6-7}\n\\textbf{Rows} & \\textbf{Sheets} & \\textbf{Fml} & ms & calls & v1 & v2 \\\\\n\\midrule\n';
  e3.analyze.forEach((r) => { t += `${n0(r.rows)} & ${r.sheets} & ${n0(r.formulas)} & ${r.analyzeMs.toFixed(1)} & ${r.analyzeCalls} & ${r.v1Calls} & ${r.v2Calls} \\\\\n`; });
  t += '\\bottomrule\n\\end{tabular}\n\\caption{Cost of workbook analysis (CPU ms in Node; SpreadsheetApp calls) and SpreadsheetApp calls per formula verification, as workbooks grow.}\n\\label{tab:e3}\n\\end{table}\n';
  write('tab_e3.tex', t);
  const base = e3.analyze[0], big = e3.analyze[e3.analyze.length - 1];
  mac('eScaleVerifyV1', e3.analyze[1].v1Calls); mac('eScaleVerifyV2', e3.analyze[1].v2Calls);
  mac('eScaleMaxVerifyMs', Math.max(...e3.analyze.map((r) => r.v2Ms)).toFixed(1));
  mac('eScaleMaxAnalyzeMs', Math.max(...e3.analyze.map((r) => r.analyzeMs)).toFixed(1));
  mac('eScaleCallsPerSheet', ((big.analyzeCalls - e3.analyze[1].analyzeCalls) / (big.sheets - e3.analyze[1].sheets)).toFixed(1));
  mac('eScaleVerifyPerSheet', ((big.v2Calls - e3.analyze[1].v2Calls) / (big.sheets - e3.analyze[1].sheets)).toFixed(1));
}

// =====================================================================
// E2: retrieval
// =====================================================================
const e2 = read('e2_retrieval.json');
if (e2) {
  const S = e2.summary;
  const rows = [['ranker', 'Seven-signal ranker (shipped)'], ['bm25', 'BM25'], ['only:semanticSimilarity', 'Lexical (Jaccard) only'], ['-graph signals', 'Ranker without graph signals'], ['-semanticSimilarity', 'Ranker without lexical signal'], ['random', 'Random'], ['active-sheet-only', 'Active sheet only (as shipped to the agent)']];
  let t = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l rrr rrr}\n\\toprule\n& \\multicolumn{3}{c}{\\textbf{Budget 1500}} & \\multicolumn{3}{c}{\\textbf{Budget 500}} \\\\\n\\cmidrule(lr){2-4}\\cmidrule(lr){5-7}\n\\textbf{Method} & Complete & Recall & Tokens & Complete & Recall & Tokens \\\\\n\\midrule\n';
  const N = S.byNoise['30'];
  rows.forEach(([k, label]) => {
    const a = N.byMethod[k][1500], b = N.byMethod[k][500];
    t += `${label} & ${bold(f1(a.complete.p), k === 'ranker')} & ${f1(a.recall)} & ${n0(a.tokens)} & ${f1(b.complete.p)} & ${f1(b.recall)} & ${n0(b.tokens)} \\\\\n`;
  });
  t += `Everything (no budget) & 100.0 & 100.0 & ${n0(N.meanFullTokens)} & 100.0 & 100.0 & ${n0(N.meanFullTokens)} \\\\\n`;
  t += '\\bottomrule\n\\end{tabular}\n\\caption{Context retrieval on workbooks with 40 tables (' + N.nRequests + ' requests). \\emph{Complete}: share of requests whose prompt contains \\emph{all} gold tables (\\%); \\emph{Recall}: mean fraction of gold tables retrieved (\\%); \\emph{Tokens}: mean prompt tokens spent on context.}\n\\label{tab:e2}\n\\end{table}\n';
  write('tab_e2.tex', t);
  // by request type at 40 tables, 1500
  let u = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l rrrrr}\n\\toprule\n\\textbf{Method} & A-H & A-S & B-H & B-S & C \\\\\n\\midrule\n';
  [['ranker', 'Ranker'], ['only:semanticSimilarity', 'Lexical only'], ['only:graph signals', 'Graph signals only'], ['-graph signals', 'Ranker $-$ graph'], ['bm25', 'BM25'], ['random', 'Random']].forEach(([k, label]) => {
    const bt = N.byMethod[k].byType;
    u += `${label} & ${['A-H', 'A-S', 'B-H', 'B-S', 'C-A'].map((x) => f0(bt[x].complete.p)).join(' & ')} \\\\\n`;
  });
  u += '\\bottomrule\n\\end{tabular}\n\\caption{Gold-complete rate (\\%) by request type at 40 tables, budget 1500. A: aggregate; B: lookup; C: ``change \\emph{this} formula\\textquotedblright{}. H: names the column; S: paraphrase only.}\n\\label{tab:e2-type}\n\\end{table}\n';
  write('tab_e2_type.tex', u);
  const R = N.byMethod.ranker, B25 = N.byMethod.bm25, RND = N.byMethod.random;
  mac('eTwoTables', Math.round(N.meanTables)); mac('eTwoFull', n0(N.meanFullTokens)); mac('eTwoReq', N.nRequests);
  mac('eTwoRankerComplete', f1(R[1500].complete.p)); mac('eTwoBmComplete', f1(B25[1500].complete.p)); mac('eTwoRandComplete', f1(RND[1500].complete.p));
  mac('eTwoRankerCompleteSmall', f1(R[500].complete.p)); mac('eTwoBmCompleteSmall', f1(B25[500].complete.p));
  mac('eTwoReduction', f0(R[1500].tokenReduction));
  mac('eTwoNoGraphC', f0(N.byMethod['-graph signals'].byType['C-A'].complete.p)); mac('eTwoRankerC', f0(R.byType['C-A'].complete.p)); mac('eTwoBmC', f0(B25.byType['C-A'].complete.p));
  mac('eTwoRankerAS', f0(R.byType['A-S'].complete.p)); mac('eTwoRankerBS', f0(R.byType['B-S'].complete.p));
  mac('eTwoZeroFull', n0(S.byNoise['0'].meanFullTokens)); mac('eTwoZeroComplete', f0(S.byNoise['0'].byMethod.ranker[1500].complete.p));
  mac('eTwoTenTables', Math.round(S.byNoise['10'].meanTables)); mac('eTwoTenRanker', f1(S.byNoise['10'].byMethod.ranker[1000].complete.p));
}

// =====================================================================
// E5: end-to-end (per model)
// =====================================================================
const e5 = read('e5_summary.json');
if (e5 && e5.length) {
  const strats = [['resample', 'Resample (no feedback)'], ['generic', 'Generic feedback'], ['v1fb', 'Shipped-verifier feedback'], ['v2fb', 'GroundCheck feedback'], ['v2fb+susp', 'GroundCheck + suspicious']];
  const NAMES = { 'llama3.1-8b': 'Llama~3.1 8B', 'llama3.2-3b': 'Llama~3.2 3B', 'llama3.1-8b-heldout': 'Llama~3.1 8B, new tasks', 'gemini-3.1-flash-lite': 'Gemini~3.1 Flash-Lite', 'gemini-3.5-flash-lite': 'Gemini~3.5 Flash-Lite', 'gemma-4-26b-a4b-it': 'Gemma~4 26B-A4B' };
  const short = (m) => NAMES[m] || m;
  // two-line column heads for the narrow tables
  const STACK = { 'llama3.1-8b': 'Llama~3.1\\\\8B', 'llama3.2-3b': 'Llama~3.2\\\\3B', 'llama3.1-8b-heldout': 'Llama~3.1 8B\\\\new tasks', 'gemini-3.1-flash-lite': 'Gemini~3.1\\\\Flash-Lite', 'gemini-3.5-flash-lite': 'Gemini~3.5\\\\Flash-Lite', 'gemma-4-26b-a4b-it': 'Gemma~4\\\\26B-A4B' };
  const stack = (m) => STACK[m] || short(m);
  const KEY = ['A', 'B', 'C', 'D', 'E', 'F'];
  const rob = read('robust_summary.json');
  const seedsS = read('seeds_summary.json');
  const hasRepairs = (m) => m.repair.strategies.v2fb.transitions.n >= 10; // models whose first attempts the verifier rejects often enough to compare repair strategies
  const pfmt = (p) => (p < 0.001 ? '<.001' : p.toFixed(3).replace(/^0/, ''));

  // ---- repair table (final system) ----
  const eR = e5.filter(hasRepairs);
  const holmP = (m, k) => { const h = rob && rob.e5[m.model] && rob.e5[m.model].holm['vsResample:' + k]; return h ? pfmt(h.adj) : '--'; };
  let t = `\\begin{table*}[t]\n\\centering\\small\n\\begin{tabular}{l ${eR.map(() => 'rrr').join(' ')}}\n\\toprule\n`;
  t += '& ' + eR.map((m) => `\\multicolumn{3}{c}{\\textbf{${short(m.model)}} (n=${m.repair.n})}`).join(' & ') + ' \\\\\n';
  t += eR.map((_, i) => `\\cmidrule(lr){${2 + 3 * i}-${4 + 3 * i}}`).join('') + '\n';
  t += '\\textbf{Condition} & ' + eR.map(() => 'Acc. & $\\Delta$ & $p_{\\text{Holm}}$').join(' & ') + ' \\\\\n\\midrule\n';
  t += 'Attempt 1 (no repair) & ' + eR.map((m) => `${f1(m.repair.attempt1.p)} & -- & --`).join(' & ') + ' \\\\\n';
  strats.forEach(([k, label]) => {
    t += `${label} & ` + eR.map((m) => {
      const v = m.repair.strategies[k];
      const d = v.vsAttempt1.diffCI.est * 100;
      return `${bold(f1(v.accuracy.p), k === 'v2fb+susp' || k === 'v2fb')} & ${d >= 0 ? '+' : ''}${d.toFixed(1)} & ${v.vsResample ? holmP(m, k) : '--'}`;
    }).join(' & ') + ' \\\\\n';
  });
  t += '\\bottomrule\n\\end{tabular}\n\\caption{End-to-end execution accuracy (\\%) of the production formula agent after up to two repair attempts, by repair strategy, with retrieved context. $\\Delta$: percentage points over attempt 1; $p_{\\text{Holm}}$: exact McNemar test against plain resampling (same tasks, paired), Holm-adjusted over the four feedback strategies of each model. Models whose first attempts are almost never rejected are omitted: no strategy has anything to repair.}\n\\label{tab:e5-repair}\n\\end{table*}\n';
  write('tab_e5_repair.tex', t);

  // ---- repair table, shipped chunk format (robustness check; models that have a pass-1 file) ----
  const withShip = e5.filter((m) => m.repairShipped);
  if (withShip.length) {
    let ts = `\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l ${withShip.map(() => 'rr').join(' ')}}\n\\toprule\n`;
    ts += '& ' + withShip.map((m) => `\\multicolumn{2}{c}{\\textbf{${short(m.model)}} (n=${m.repairShipped.n})}`).join(' & ') + ' \\\\\n';
    ts += '\\textbf{Condition} & ' + withShip.map(() => 'Acc. & $p_{\\text{rs}}$').join(' & ') + ' \\\\\n\\midrule\n';
    ts += 'Attempt 1 & ' + withShip.map((m) => `${f1(m.repairShipped.attempt1.p)} & --`).join(' & ') + ' \\\\\n';
    strats.forEach(([k, label]) => {
      ts += `${label} & ` + withShip.map((m) => { const v = m.repairShipped.strategies[k]; return `${f1(v.accuracy.p)} & ${v.vsResample ? pfmt(v.vsResample.p) : '--'}`; }).join(' & ') + ' \\\\\n';
    });
    ts += '\\bottomrule\n\\end{tabular}\n\\caption{The repair comparison of Table~\\ref{tab:e5-repair} repeated with retrieved context in the chunk format the add-on shipped (no column letters), forked from that arm\'s attempt 1.}\n\\label{tab:e5-repair-shipped}\n\\end{table}\n';
    write('tab_e5_repair_shipped.tex', ts);
  }

  // ---- taxonomy table ----
  let x = `\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l ${e5.map(() => 'r').join('')}}\n\\toprule\n\\textbf{Wrong at attempt 1} & ` + e5.map((m) => `\\textbf{\\shortstack[r]{${stack(m.model)}}}`).join(' & ') + ' \\\\\n\\midrule\n';
  const row = (label, fn) => { x += `${label} & ${e5.map((m) => fn(m)).join(' & ')} \\\\\n`; };
  row('Wrong formulas', (m) => m.taxonomy.nWrong);
  row('~~loud (engine error)', (m) => m.taxonomy.loud);
  row('~~silent (wrong value)', (m) => m.taxonomy.silent);
  row('Rejected by shipped verifier', (m) => m.taxonomy.v1.reject);
  row('Rejected by GroundCheck', (m) => m.taxonomy.v2.reject);
  row('Flagged by GroundCheck', (m) => m.taxonomy.v2.flag);
  row('Correct formulas rejected', (m) => `${m.falseAlarms.v2Reject}/${m.falseAlarms.nCorrect}`);
  x += '\\bottomrule\n\\end{tabular}\n\\caption{What verification sees among the formulas the model got wrong on its first attempt (final system). Flagged = rejected or warned.}\n\\label{tab:e5-taxonomy}\n\\end{table}\n';
  write('tab_e5_taxonomy.tex', x);

  // ---- context table ----
  let cx = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l l rrr}\n\\toprule\n\\textbf{Model} & \\textbf{Context} & \\textbf{All} & \\textbf{Lookup} & \\textbf{Other} \\\\\n\\midrule\n';
  const armLabel = { flat: 'Active sheet only', shipped: 'Retrieved (shipped)', final: 'Retrieved + letters' };
  e5.forEach((m, i) => {
    const arms = ['flat', 'shipped', 'final'].filter((a) => m.context.arms[a]);
    arms.forEach((a, j) => {
      const A = m.context.arms[a];
      cx += `${j === 0 ? `\\multirow{${arms.length}}{*}{${short(m.model)}}` : ''} & ${armLabel[a]} & ${bold(f1(A.overall.p), a === 'final')} & ${f1(A.lookup.acc.p)} & ${f1(A.other.acc.p)} \\\\\n`;
    });
    if (i < e5.length - 1) cx += '\\midrule\n';
  });
  cx += '\\bottomrule\n\\end{tabular}\n\\caption{Attempt-1 execution accuracy (\\%) by context. Lookup tasks read a sheet other than the active one; ``Other\'\' tasks read the active sheet only. The only difference between the two retrieved rows is that table chunks now carry column letters and the data-row span.}\n\\label{tab:e5-context}\n\\end{table}\n';
  write('tab_e5_context.tex', cx);

  // ---- generation cost table ----
  let gc = `\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l ${e5.map(() => 'r').join('')}}\n\\toprule\n\\textbf{Per task} & ` + e5.map((m) => `\\textbf{\\shortstack[r]{${stack(m.model)}}}`).join(' & ') + ' \\\\\n\\midrule\n';
  // a repair bucket that is absent means no repair call was made (a model that never needed one)
  const cst = (m, b, k) => (m.cost[b] ? m.cost[b][k] : b.startsWith('repair') ? 0 : NaN);
  const dash = (x, fmt) => (Number.isNaN(x) ? '--' : fmt(x));
  const crow = (label, fn) => { gc += `${label} & ${e5.map((m) => fn(m)).join(' & ')} \\\\\n`; };
  crow('Prompt tokens, active sheet only', (m) => dash(cst(m, 'attempt1:flat', 'promptTokensPerTask'), n0));
  crow('Prompt tokens, retrieved context', (m) => dash(cst(m, 'attempt1:retr', 'promptTokensPerTask'), n0));
  crow('Seconds, attempt 1', (m) => dash(cst(m, 'attempt1:retr', 'secondsPerTask'), (x) => x.toFixed(1)));
  crow('Extra calls, \\gc{} feedback', (m) => dash(cst(m, 'repair:v2fb', 'callsPerTask'), (x) => x.toFixed(2)));
  crow('Extra seconds, \\gc{} feedback', (m) => dash(cst(m, 'repair:v2fb', 'secondsPerTask'), (x) => x.toFixed(1)));
  gc += '\\bottomrule\n\\end{tabular}\n\\caption{Generation cost per task by model: prompt tokens with the shipped active-sheet context and with retrieved context, wall-clock seconds for the first attempt (local models on one consumer GPU; hosted model over the network), and the extra model calls and seconds that repair with \\gc{} feedback adds (--: not recorded in that pass).}\n\\label{tab:e5-cost}\n\\end{table}\n';
  write('tab_e5_cost.tex', gc);

  // ---- harm accounting: what finally sits in the cell, by policy ----
  if (rob) {
    let hm = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l l rrrr}\n\\toprule\n\\textbf{Model} & \\textbf{Policy} & \\textbf{Right} & \\textbf{Error} & \\textbf{Silent} & \\textbf{Held} \\\\\n\\midrule\n';
    const pol = [['write_as_is', 'Write as is'], ['block_only', 'Block rejected'], ['repair_v2fb', 'Repair (\\gc)']];
    eR.forEach((m, i) => {
      const R = rob.e5[m.model]; if (!R) return;
      pol.forEach(([p, label], j) => {
        const t = R.policies[p], n = R.n;
        hm += `${j === 0 ? `\\multirow{3}{*}{${stack(m.model).replace(/\\\\/g, ' ')}}` : ''} & ${label} & ${f1(t.correct / n)} & ${f1(t.loud / n)} & ${bold(f1(t.silent / n), p === 'repair_v2fb')} & ${t.withheld ? f1(t.withheld / n) : '--'} \\\\\n`;
      });
      if (i < eR.length - 1) hm += '\\midrule\n';
    });
    hm += '\\bottomrule\n\\end{tabular}\n\\caption{What ends up in the cell, as \\% of tasks, under three policies: write the first attempt unchecked; withhold what \\gc{} rejects and write the rest (no repair); repair with \\gc{} feedback. \\emph{Right}: evaluates to the gold value. \\emph{Error}: the cell shows an error value. \\emph{Silent}: a plausible but wrong value (the failure a user cannot see). \\emph{Held}: nothing is written.}\n\\label{tab:e5-harm}\n\\end{table}\n';
    write('tab_e5_harm.tex', hm);
  }

  // ---- verify -> repair -> execute arm ----
  const exS = read('exec_summary.json');
  if (exS && Object.keys(exS).length) {
    let ext = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l l rrr}\n\\toprule\n\\textbf{Model} & \\textbf{Policy} & \\textbf{Right} & \\textbf{Error} & \\textbf{Silent} \\\\\n\\midrule\n';
    const pols = [['write_as_is', 'Write as is'], ['repair_v2fb', 'Repair (\\gc)'], ['repair_exec', 'Repair + execution']];
    const models = Object.keys(exS);
    models.forEach((model, mi) => {
      const M = exS[model], n = M.nSame, k = KEY[e5.findIndex((m) => m.model === model)];
      pols.forEach(([p, label], j) => { ext += `${j === 0 ? `\\multirow{3}{*}{${stack(model).replace(/\\\\/g, ' ')}}` : ''} & ${label} & ${f1(M[p].correct / n)} & ${f1(M[p].loud / n)} & ${bold(f1(M[p].silent / n), p === 'repair_exec')} \\\\\n`; });
      if (mi < models.length - 1) ext += '\\midrule\n';
      if (k) {
        mac(`ex${k}Total`, M.nExec); mac(`ex${k}Same`, M.nSame);
        [['write_as_is', 'AsIs'], ['repair_v2fb', 'Vtwo'], ['repair_exec', 'Exec']].forEach(([p, nm]) => ['correct', 'loud', 'silent'].forEach((c) => mac(`ex${k}${nm}${c[0].toUpperCase()}${c.slice(1)}`, M[p][c])));
        mac(`ex${k}Gained`, M.vsV2fb.gained); mac(`ex${k}Lost`, M.vsV2fb.lost); mac(`ex${k}P`, pfmt(M.vsV2fb.p));
        mac(`ex${k}LoudAfter`, M.loudAfterV2fb); mac(`ex${k}LoudFixed`, M.loudFixedByExec); mac(`ex${k}LoudStill`, M.loudStillByExec); mac(`ex${k}LoudToSilent`, M.loudToSilentByExec);
        mac(`ex${k}Attempts`, M.meanAttemptsExec.toFixed(2));
      }
    });
    ext += `\\bottomrule\n\\end{tabular}\n\\caption{What ends up in the cell (\\% of tasks) when repair is followed by an execution check: after the verifier accepts a formula, the cell is evaluated and an error is sent back to the model. Only tasks whose regenerated first attempt reproduced the stored one are included, so all three policies cover the same tasks.}\n\\label{tab:e5-exec}\n\\end{table}\n`;
    write('tab_e5_exec.tex', ext);
  }

  // ---- seeds: run-to-run variation of the local models ----
  if (seedsS) {
    const sm = Object.keys(seedsS);
    const sfmt = (st) => `${f1(st.mean)} (${(100 * st.sd).toFixed(1)})`;
    let sd = `\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l ${sm.map(() => 'r').join('')}}\n\\toprule\n\\textbf{Accuracy, mean (SD) over seeds} & ` + sm.map((m) => `\\textbf{\\shortstack[r]{${stack(m)}}}`).join(' & ') + ' \\\\\n\\midrule\n';
    const srow = (label, fn) => { sd += `${label} & ${sm.map((m) => fn(seedsS[m])).join(' & ')} \\\\\n`; };
    srow('Attempt 1, active sheet only', (S) => sfmt(S.summary.flat));
    srow('Attempt 1, retrieved context', (S) => sfmt(S.summary.retr));
    strats.forEach(([k, label]) => srow(label, (S) => sfmt(S.summary[k])));
    sd += '\\midrule\n';
    srow('\\gc{} feedback $-$ resample, points [95\\% CI]', (S) => { const d = S.clustered['v2fb-resample']; return `${(100 * d.diff).toFixed(1)} [${(100 * d.lo).toFixed(1)}, ${(100 * d.hi).toFixed(1)}]`; });
    srow('\\gc{} feedback $-$ shipped feedback, points [95\\% CI]', (S) => { const d = S.clustered['v2fb-v1fb']; return `${(100 * d.diff).toFixed(1)} [${(100 * d.lo).toFixed(1)}, ${(100 * d.hi).toFixed(1)}]`; });
    srow('Seeds in which \\gc{} beats resampling', (S) => `${S.seedsV2BeatsResample} of ${S.nSeeds}`);
    sd += `\\bottomrule\n\\end{tabular}\n\\caption{Run-to-run variation on the ${n0(seedsS[sm[0]].nTasks)} main-set tasks: the same tasks rerun with ${seedsS[sm[0]].nSeeds} independent sampling seeds. The interval for the repair effect is a paired bootstrap over tasks of each task's outcome averaged over seeds.}\n\\label{tab:e5-seeds}\n\\end{table}\n`;
    write('tab_e5_seeds.tex', sd);
  }

  // ---- macros ----
  e5.forEach((m, i) => {
    const k = KEY[i];
    mac(`ef${k}Name`, short(m.model)); mac(`ef${k}N`, m.nValid); mac(`ef${k}CtxN`, m.context.n);
    ['flat', 'shipped', 'final'].forEach((a) => {
      const A = m.context.arms[a];
      if (!A) return;
      mac(`ef${k}${a}`, f1(A.overall.p)); mac(`ef${k}${a}Lookup`, f1(A.lookup.acc.p)); mac(`ef${k}${a}Other`, f1(A.other.acc.p));
      mac(`ef${k}${a}LookupN`, A.lookup.n); mac(`ef${k}${a}OtherN`, A.other.n);
    });
    Object.entries(m.context.tests).forEach(([name, tt]) => { const nm = name.replace(/-/g, ''); mac(`ef${k}Test${nm}P`, pfmt(tt.p)); mac(`ef${k}Test${nm}A`, tt.aOnly); mac(`ef${k}Test${nm}B`, tt.bOnly); });
    const tax = m.taxonomy;
    mac(`ef${k}Wrong`, tax.nWrong); mac(`ef${k}Loud`, tax.loud); mac(`ef${k}Silent`, tax.silent);
    mac(`ef${k}LoudShare`, f0(tax.loud / Math.max(1, tax.nWrong)));
    mac(`ef${k}CaughtTwo`, tax.v2.reject); mac(`ef${k}CaughtOne`, tax.v1.reject); mac(`ef${k}FlagTwo`, tax.v2.flag); mac(`ef${k}Susp`, tax.v2.suspicious);
    mac(`ef${k}LoudCaughtTwo`, tax.loudCaught.v2); mac(`ef${k}LoudCaughtOne`, tax.loudCaught.v1);
    mac(`ef${k}SilentCaughtTwo`, tax.silentCaught.v2reject); mac(`ef${k}SilentFlagTwo`, tax.silentCaught.v2flag);
    mac(`ef${k}FalseAlarm`, m.falseAlarms.v2Reject); mac(`ef${k}NCorrect`, m.falseAlarms.nCorrect); mac(`ef${k}FalseAlarmOne`, m.falseAlarms.v1Reject);
    mac(`ef${k}GateAcc`, f1(m.gate.accuracyAccepted.p)); mac(`ef${k}GateRej`, f1(m.gate.accuracyRejected.p)); mac(`ef${k}GateRejN`, m.gate.rejected); mac(`ef${k}GateAccN`, m.gate.accepted);
    mac(`ef${k}Base`, f1(m.repair.attempt1.p)); mac(`ef${k}RepairN`, m.repair.n);
    const stratMacros = (R, prefix) => Object.keys(R.strategies).forEach((s) => {
      const nm = s.replace('+', 'plus'), v = R.strategies[s];
      mac(`${prefix}${nm}`, f1(v.accuracy.p)); mac(`${prefix}${nm}D`, (v.vsAttempt1.diffCI.est * 100).toFixed(1));
      mac(`${prefix}${nm}Lo`, (v.vsAttempt1.diffCI.lo * 100).toFixed(1)); mac(`${prefix}${nm}Hi`, (v.vsAttempt1.diffCI.hi * 100).toFixed(1));
      mac(`${prefix}${nm}P`, pfmt(v.vsAttempt1.p)); mac(`${prefix}${nm}Fixed`, v.fixed); mac(`${prefix}${nm}Broke`, v.broken); mac(`${prefix}${nm}Att`, v.meanAttempts.toFixed(2));
      mac(`${prefix}${nm}TrN`, v.transitions.n); mac(`${prefix}${nm}TrCorrect`, v.transitions.correct); mac(`${prefix}${nm}TrValidWrong`, v.transitions.validWrong); mac(`${prefix}${nm}TrInvalid`, v.transitions.stillInvalid);
      if (v.vsGeneric) { mac(`${prefix}${nm}PG`, pfmt(v.vsGeneric.p)); mac(`${prefix}${nm}GG`, v.vsGeneric.gained); mac(`${prefix}${nm}GL`, v.vsGeneric.lost); }
      if (v.vsV1) { mac(`${prefix}${nm}PV`, pfmt(v.vsV1.p)); mac(`${prefix}${nm}VG`, v.vsV1.gained); mac(`${prefix}${nm}VL`, v.vsV1.lost); }
      if (v.vsResample) { mac(`${prefix}${nm}PR`, pfmt(v.vsResample.p)); mac(`${prefix}${nm}RG`, v.vsResample.gained); mac(`${prefix}${nm}RL`, v.vsResample.lost); }
    });
    stratMacros(m.repair, `ef${k}S`);
    if (m.repairLookup) {
      mac(`ef${k}LkBase`, f1(m.repairLookup.attempt1.p)); mac(`ef${k}LkN`, m.repairLookup.n);
      Object.keys(m.repairLookup.strategies).forEach((s) => mac(`ef${k}Lk${s.replace('+', 'plus')}`, f1(m.repairLookup.strategies[s].accuracy.p)));
      mac(`ef${k}LkSheetTwo`, m.lookupSheet2.copiedSheet2);
    }
    if (m.repairShipped) { mac(`ef${k}ShipBase`, f1(m.repairShipped.attempt1.p)); stratMacros(m.repairShipped, `ef${k}ShipS`); }
    const cs = m.cost, calls = (b) => (cs[b] ? cs[b].callsPerTask : 0), secs = (b) => (cs[b] ? cs[b].secondsPerTask : 0), ptok = (b) => (cs[b] ? cs[b].promptTokensPerTask : 0);
    mac(`ef${k}CallsAttempt`, calls('attempt1:retr').toFixed(1)); mac(`ef${k}SecAttempt`, secs('attempt1:retr').toFixed(1));
    mac(`ef${k}PromptFlat`, n0(ptok('attempt1:flat'))); mac(`ef${k}PromptRetr`, n0(ptok('attempt1:retr')));
    strats.forEach(([s]) => mac(`ef${k}Extra${s.replace('+', 'plus')}`, calls('repair:' + s).toFixed(2)));
  });

  // ---- harm accounting, unsafe-repair rate and Holm-adjusted p-values ----
  if (rob) e5.forEach((m, i) => {
    const k = KEY[i], R = rob.e5[m.model];
    if (!R) return;
    const pn = { write_as_is: 'AsIs', block_only: 'Block', 'repair_resample': 'RepRes', 'repair_generic': 'RepGen', 'repair_v1fb': 'RepV1', 'repair_v2fb': 'RepV2', 'repair_v2fb+susp': 'RepSusp' };
    Object.entries(pn).forEach(([p, nm]) => ['correct', 'loud', 'silent', 'withheld'].forEach((c) => mac(`hm${k}${nm}${c[0].toUpperCase()}${c.slice(1)}`, R.policies[p][c])));
    mac(`hm${k}N`, R.n); mac(`hm${k}FalseWithheld`, R.falseWithheld);
    const un = { resample: 'Res', generic: 'Gen', v1fb: 'V1', v2fb: 'V2', 'v2fb+susp': 'Susp' };
    Object.entries(un).forEach(([s, nm]) => {
      mac(`hm${k}Unsafe${nm}`, R.unsafe[s].silentWrong); mac(`hm${k}Unsafe${nm}Rate`, f0(R.unsafe[s].unsafeRate)); mac(`hm${k}Unsafe${nm}Fixed`, R.unsafe[s].correct); mac(`hm${k}Unsafe${nm}Loud`, R.unsafe[s].loudWrong);
    });
    mac(`hm${k}UnsafeN`, R.unsafe.v2fb.n);
    const hp = (key) => (R.holm[key] ? pfmt(R.holm[key].adj) : '--');
    mac(`hm${k}HolmV2Res`, hp('vsResample:v2fb')); mac(`hm${k}HolmV1Res`, hp('vsResample:v1fb')); mac(`hm${k}HolmGenRes`, hp('vsResample:generic')); mac(`hm${k}HolmSuspRes`, hp('vsResample:v2fb+susp'));
    mac(`hm${k}HolmV2Gen`, hp('v2fb:vs:generic')); mac(`hm${k}HolmV2V1`, hp('v2fb:vs:v1fb')); mac(`hm${k}HolmSuspGen`, hp('v2fb+susp:vs:generic')); mac(`hm${k}HolmSuspV1`, hp('v2fb+susp:vs:v1fb'));
  });

  // ---- seeds ----
  if (seedsS) Object.entries(seedsS).forEach(([model, S]) => {
    const i = e5.findIndex((m) => m.model === model); if (i < 0) return;
    const k = KEY[i];
    mac(`sd${k}Seeds`, S.nSeeds); mac(`sd${k}Tasks`, S.nTasks);
    const put = (nm, st) => { mac(`sd${k}${nm}`, f1(st.mean)); mac(`sd${k}${nm}SD`, (100 * st.sd).toFixed(1)); mac(`sd${k}${nm}Min`, f1(st.min)); mac(`sd${k}${nm}Max`, f1(st.max)); };
    put('Flat', S.summary.flat); put('Retr', S.summary.retr);
    strats.forEach(([s]) => { put(s.replace('+', 'plus'), S.summary[s]); put('Unsafe' + s.replace('+', 'plus'), S.summary['unsafe:' + s]); });
    Object.entries(S.clustered).forEach(([name, d]) => { const nm = name.replace(/[-+]/g, (c) => (c === '+' ? 'plus' : '')); mac(`sd${k}D${nm}`, (100 * d.diff).toFixed(1)); mac(`sd${k}D${nm}Lo`, (100 * d.lo).toFixed(1)); mac(`sd${k}D${nm}Hi`, (100 * d.hi).toFixed(1)); });
    mac(`sd${k}SeedsBeat`, S.seedsV2BeatsResample);
    ['write_as_is', 'v2fb'].forEach((p) => ['correct', 'loud', 'silent'].forEach((c) => mac(`sd${k}Harm${p === 'v2fb' ? 'V2' : 'AsIs'}${c[0].toUpperCase()}${c.slice(1)}`, S.harm[p][c].toFixed(0))));
  });
}

// Appended to make_paper_assets.js: appendix table of false-alarm rates per clean class.
const e1c = read('e1_main.json');
if (e1c) {
  const S = e1c.summary;
  const label = {
    'clean:gold': 'Gold formula', 'clean:headroom': 'Rows of headroom', 'clean:absolute': 'Absolute references', 'clean:wholecol': 'Whole-column references',
    'clean:lowercase': 'Lowercase function names', 'clean:spacing': 'Extra spacing', 'clean:self_sheet': 'Own-sheet prefix', 'clean:iferror': '\\code{IFERROR} wrapper',
    'clean:named_range': 'Named range', 'clean:total_row': 'Ordinary totals-row formula', 'clean:query_ok': 'Valid \\code{QUERY}', 'clean:extra': 'Handwritten valid syntax', 'clean:custom_fn': 'Custom (non-Sheets) function'
  };
  let t = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r rr rr}\n\\toprule\n& & \\multicolumn{2}{c}{\\textbf{Shipped (v1)}} & \\multicolumn{2}{c}{\\textbf{\\gc}} \\\\\n\\cmidrule(lr){3-4}\\cmidrule(lr){5-6}\n\\textbf{Clean class} & n & Rej. & Flag & Rej. & Flag \\\\\n\\midrule\n';
  Object.keys(label).forEach((k) => {
    if (!S.perClean.v1[k]) return;
    const a = S.perClean.v1[k], b = S.perClean.v2[k];
    t += `${label[k]} & ${n0(a.n)} & ${f1(a.reject.p)} & ${f1(a.flag.p)} & ${f1(b.reject.p)} & ${f1(b.flag.p)} \\\\\n`;
  });
  t += '\\bottomrule\n\\end{tabular}\n\\caption{Share of clean formulas rejected or flagged, by class (\\%). Every class is valid by construction or confirmed equivalent to the gold formula by the engine; custom functions cannot be checked and are only warned about.}\n\\label{tab:e1-clean}\n\\end{table}\n';
  write('tab_e1_clean.tex', t);
}

// =====================================================================
// E6: LLM critic vs deterministic verifier
// =====================================================================
const e6path = path.join(RES, 'e6_critic.jsonl');
if (fs.existsSync(e6path) && e1) {
  const rows = fs.readFileSync(e6path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const faultsR = rows.filter((r) => r.label === 'fault'), cleanR = rows.filter((r) => r.label === 'clean');
  const groupOf = {};
  Object.keys(e1.groups).forEach((g) => e1.groups[g].forEach((c) => { groupOf[c] = g; }));
  const groupNames = { structural: 'Structural', symbol: 'Symbols', shape: 'Shape', grounding: 'Grounding', circular: 'Circularity', semantic: 'Semantic' };
  const rate = (rs, fn) => rs.length ? rs.filter(fn).length / rs.length : NaN;
  const crit = (r) => r.criticReject, ver = (r) => r.v2Reject, either = (r) => r.criticReject || r.v2Reject;
  let t = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r rrr}\n\\toprule\n\\textbf{Fault group} & n & Critic & \\gc & Either \\\\\n\\midrule\n';
  Object.keys(groupNames).forEach((g) => {
    const rs = faultsR.filter((r) => groupOf[r.cls] === g);
    if (!rs.length) return;
    t += `${groupNames[g]} & ${rs.length} & ${f0(rate(rs, crit))} & ${f0(rate(rs, ver))} & ${f0(rate(rs, either))} \\\\\n`;
  });
  t += `\\midrule\nAll faults & ${faultsR.length} & ${f1(rate(faultsR, crit))} & ${f1(rate(faultsR, ver))} & ${f1(rate(faultsR, either))} \\\\\nClean formulas rejected (FPR) & ${cleanR.length} & ${f1(rate(cleanR, crit))} & ${f1(rate(cleanR, ver))} & ${f1(rate(cleanR, either))} \\\\\n`;
  t += '\\bottomrule\n\\end{tabular}\n\\caption{A language-model critic (same model and context as the generator) versus the deterministic verifier on a stratified sample of \\sheetfault{}; recall in \\% when blocking only on rejection.}\n\\label{tab:e6}\n\\end{table}\n';
  write('tab_e6.tex', t);
  const prec = (fn) => { const tp = faultsR.filter(fn).length, fp = cleanR.filter(fn).length; return tp + fp ? tp / (tp + fp) : NaN; };
  const f1s = (fn) => { const p = prec(fn), r = rate(faultsR, fn); return 2 * p * r / (p + r); };
  mac('sixN', rows.length); mac('sixFaults', faultsR.length); mac('sixClean', cleanR.length);
  mac('sixCriticR', f1(rate(faultsR, crit))); mac('sixCriticFPR', f1(rate(cleanR, crit))); mac('sixCriticP', f1(prec(crit))); mac('sixCriticF', f1(f1s(crit)));
  mac('sixVerR', f1(rate(faultsR, ver))); mac('sixVerFPR', f1(rate(cleanR, ver))); mac('sixVerF', f1(f1s(ver)));
  mac('sixEitherR', f1(rate(faultsR, either))); mac('sixEitherFPR', f1(rate(cleanR, either))); mac('sixEitherF', f1(f1s(either)));
  mac('sixUnparsed', rows.filter((r) => !r.criticParsed).length);
  // structural group: critic misses of trivially checkable faults
  const st = faultsR.filter((r) => groupOf[r.cls] === 'structural');
  mac('sixCriticStructural', f0(rate(st, crit)));
  const circ = faultsR.filter((r) => groupOf[r.cls] === 'circular');
  mac('sixCriticCircular', f0(rate(circ, crit))); mac('sixVerCircular', f0(rate(circ, ver)));
  mac('sixCriticOnlyCaught', faultsR.filter((r) => r.criticReject && !r.v2Reject).length);
  // which classes does the critic catch that the verifier does not (by count), in words
  const only = {};
  faultsR.filter((r) => r.criticReject && !r.v2Reject).forEach((r) => { only[r.cls] = (only[r.cls] || 0) + 1; });
  const words = { ghost_value: 'criteria absent from their column', type_mismatch: 'aggregates over text', wrong_numeric_col: 'the wrong numeric column', wrong_function: 'the wrong aggregation', ghost_function: 'invented function names' };
  const top = Object.entries(only).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${words[c] || c.replace(/_/g, ' ')} (${n})`);
  mac('sixCriticOnlyWhere', top.length ? top.join(', ') : 'none');
  // and the reverse: faults only the verifier catches
  mac('sixVerOnlyCaught', faultsR.filter((r) => !r.criticReject && r.v2Reject).length);
}

// =====================================================================
// Extra cuts (analyze_extra.js): per-domain recall, per-template and per-request-form accuracy
// =====================================================================
const extra = read('extra_summary.json');
if (extra) {
  const dm = Object.values(extra.e1Domain);
  const rng = (det, pick) => f1(Math[pick](...dm.map((d) => d[det].recall.p)));
  mac('domVoneMin', rng('v1', 'min')); mac('domVoneMax', rng('v1', 'max')); mac('domVtwoMin', rng('v2', 'min')); mac('domVtwoMax', rng('v2', 'max'));
  mac('domVtwoFPRMax', f1(Math.max(...dm.map((d) => d.v2.fpr.p))));
  const wbs = dm.flatMap((d) => d.v2.perWorkbook);
  mac('domWbMin', f1(Math.min(...wbs))); mac('domWbMax', f1(Math.max(...wbs))); mac('domWbN', wbs.length);
  const wbs1 = dm.flatMap((d) => d.v1.perWorkbook);
  mac('domWbVoneMin', f1(Math.min(...wbs1))); mac('domWbVoneMax', f1(Math.max(...wbs1)));
  // request form: H = exact header words, S = paraphrase; retrieved arm, and active-sheet-only arm
  const keyOf = { 'llama3.1-8b': 'A', 'llama3.2-3b': 'B', 'llama3.1-8b-heldout': 'C', 'gemini-3.1-flash-lite': 'D', 'gemini-3.5-flash-lite': 'E', 'gemma-4-26b-a4b-it': 'F' };
  Object.entries(extra.e5).forEach(([m, v]) => {
    const k = keyOf[m]; if (!k) return;
    ['H', 'S'].forEach((l) => { mac(`ef${k}Form${l}`, f1(v.byLevel.retr[l].acc)); mac(`ef${k}FormFlat${l}`, f1(v.byLevel.flat[l].acc)); mac(`ef${k}Form${l}N`, v.byLevel.retr[l].n); });
    if (v.versions) { mac(`ef${k}VersionCalls`, n0(v.versions.calls)); mac(`ef${k}VersionMatch`, n0(v.versions.matching)); }
    const ts = Object.values(v.byType.retr).map((x) => x.acc);
    mac(`ef${k}TemplateMin`, f0(Math.min(...ts))); mac(`ef${k}TemplateHigh`,Object.values(v.byType.retr).filter((x) => x.acc >= 0.9).length);
    mac(`ef${k}TemplateZero`, Object.values(v.byType.retr).filter((x) => x.acc < 0.05).length);
  });
  mac('efNTemplates', Object.keys(extra.e5['llama3.1-8b'].byType.retr).length);
}

// =====================================================================
// Instance accounting: where the benchmark's counts come from (so no count has to be reverse-engineered)
// =====================================================================
if (e1) {
  const pc = e1.summary.perClean.v2, nf = (c) => pc[c].n;
  const variants = ['clean:headroom', 'clean:absolute', 'clean:wholecol', 'clean:lowercase', 'clean:spacing', 'clean:self_sheet', 'clean:iferror', 'clean:named_range'].reduce((a, c) => a + nf(c), 0);
  const parts = { Gold: nf('clean:gold'), Variants: variants, Totals: nf('clean:total_row'), Query: nf('clean:query_ok'), Extra: nf('clean:extra'), Custom: nf('clean:custom_fn') };
  const sumParts = Object.values(parts).reduce((a, b) => a + b, 0);
  if (sumParts !== e1.summary.counts.clean) throw new Error('clean-instance accounting does not add up: ' + sumParts + ' vs ' + e1.summary.counts.clean);
  Object.entries(parts).forEach(([k, v]) => mac('acc' + k, n0(v)));
  const wbN = new Set(e1.records.map((r) => r.wb.replace(/[@+].*$/, ''))).size;
  mac('accWorkbooks', wbN); mac('accTasksPerWb', Math.round(nf('clean:gold') / wbN)); mac('accSeeds', wbN / 6); mac('accDomains', 6);
  mac('accHandPerWb', Math.round((parts.Extra + parts.Custom) / wbN));
  mac('accCircPerWb', Math.round(e1.summary.perClass.v2.self_reference.n / wbN)); mac('accQueryPerWb', Math.round(parts.Query / wbN));
}

// =====================================================================
// What a workbook can decide: recall by level of correctness
// =====================================================================
if (e1) {
  const G = e1.summary.byGroup, cell = (d, g) => `${f0(G[d][g].reject.p)}/${f0(G[d][g].flag.p)}`;
  const levels = [
    ['Syntax: does it parse?', 'yes', 'structural'],
    ['Names and extent: do the sheets, functions, headers and ranges it uses exist, within the data?', 'yes', 'symbol'],
    ['Shape: do the arguments fit the function?', 'yes', 'shape'],
    ['Dependencies: is the target cell on a cycle?', 'yes', 'circular'],
    ['Data: do criteria and types match the column?', 'in part', 'grounding'],
    ['Intent: does it compute what was asked?', 'no', 'semantic']
  ];
  let lv = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{>{\\raggedright\\arraybackslash}p{3.7cm} c r cc}\n\\toprule\n\\textbf{Level of correctness} & \\textbf{Decidable} & \\textbf{n} & \\textbf{Shipped} & \\textbf{\\gc} \\\\\n\\midrule\n';
  levels.forEach(([q, dec, g]) => { lv += `${q} & ${dec} & ${n0(G.v2[g].reject.n)} & ${cell('v1', g)} & ${bold(cell('v2', g), true)} \\\\\n`; });
  lv += '\\bottomrule\n\\end{tabular}\n\\caption{What a workbook can decide about a candidate formula, from syntax to intent, with the share of \\sheetfault{} faults of that kind that each verifier blocks/flags (\\%). The first four levels are decidable from the workbook alone; the data level is decidable only as a suspicion; whether a valid formula answers the question is not decidable without the user\'s intent.}\n\\label{tab:levels}\n\\end{table}\n';
  write('tab_levels.tex', lv);
}

// =====================================================================
// Real-world sets with workbook-clustered intervals
// =====================================================================
const robRW = read('robust_summary.json');
if (robRW && robRW.e1Cluster) {
  const C = robRW.e1Cluster;
  const put3 = (nm, o) => { mac(`cl${nm}`, f1(o.est)); mac(`cl${nm}Lo`, f1(o.lo)); mac(`cl${nm}Hi`, f1(o.hi)); };
  put3('VoneRecall', C.detectors.v1.recall); put3('VtwoRecall', C.detectors.v2.recall); put3('VoneFone', C.detectors.v1.f1); put3('VtwoFone', C.detectors.v2.f1);
  put3('DiffRecall', C.diffRecall); put3('DiffFone', C.diffF1);
  mac('clWbBetter', C.workbooksWhereV2Better); mac('clWbN', C.nWorkbooks);
}
if (robRW && robRW.realWorld) {
  const ci = (o) => `${f1(o.est)} [${f1(o.lo)}, ${f1(o.hi)}]`;
  const sets = [['T', 'test', 'Held-out, before the change'], ['F', 'fresh', 'Confirmation 1, frozen v2'], ['G', 'fresh2', 'Confirmation 2, frozen v2.1']].filter(([, tag]) => robRW.realWorld[tag]);
  // T: held-out (first pass, v2), F: confirmation 1 (frozen v2), G: confirmation 2 (frozen v2.1);
  // TP / FP: the same two sets re-scored with v2.1 after the fix (post hoc)
  [['T', 'test'], ['F', 'fresh'], ['G', 'fresh2'], ['TP', 'test21'], ['FP', 'fresh21']].filter(([, tag]) => robRW.realWorld[tag]).forEach(([L, tag]) => {
    const S = read(`e1b_${tag}.json`), Rr = robRW.realWorld[tag];
    mac(`rwc${L}RealRejected`, Rr.v2Rejected - Rr.nEmpty); mac(`rwc${L}EngineConfirmedReal`, Rr.v2EngineConfirmed - Rr.nEmpty);
    if (S && S.summary) {
      mac(`rwc${L}GhostOk`, S.summary.ghostOk); mac(`rwc${L}GhostOkMasked`, S.summary.ghostOkMasked);
      Object.entries(S.summary.categories.v2).forEach(([c, v]) => { mac(`rwc${L}Cat${c}`, v.n); mac(`rwc${L}Cat${c}Err`, v.engineErr); });
    }
  });
  [['T', 'test'], ['F', 'fresh'], ['G', 'fresh2'], ['TP', 'test21'], ['FP', 'fresh21']].filter(([, tag]) => robRW.realWorld[tag]).forEach(([L, tag]) => {
    const R = robRW.realWorld[tag];
    mac(`rwc${L}Formulas`, n0(R.nFormulas)); mac(`rwc${L}Workbooks`, R.nWorkbooks);
    const put = (nm, o) => { mac(`rwc${L}${nm}`, f1(o.est)); mac(`rwc${L}${nm}Lo`, f1(o.lo)); mac(`rwc${L}${nm}Hi`, f1(o.hi)); };
    put('VoneReject', R.v1Reject); put('VtwoReject', R.v2Reject); put('Diff', R.diffReject); put('VtwoRejectNoEmpty', R.v2RejectNoEmpty);
    mac(`rwc${L}Empty`, R.nEmpty); mac(`rwc${L}Rejected`, R.v2Rejected); mac(`rwc${L}RejectedV1`, R.v1Rejected); mac(`rwc${L}EngineConfirmed`, R.v2EngineConfirmed); mac(`rwc${L}WbRejected`, R.workbooksWithRejection);
    Object.entries(R.overlap).forEach(([k, v]) => mac(`rwc${L}O${k[0].toUpperCase()}${k.slice(1)}`, v));
    mac(`rwc${L}Top5Share`, f0(R.concentration.top5Share)); mac(`rwc${L}Top1`, R.concentration.top1);
  });
  let rt = '\\begin{table}[t]\n\\centering\\small\n\\begin{tabular}{l r c c}\n\\toprule\n\\textbf{Set} & \\textbf{Formulas} & \\textbf{Shipped} & \\textbf{\\gc} \\\\\n\\midrule\n';
  sets.forEach(([L, tag, label]) => { const R = robRW.realWorld[tag]; rt += `${label} & ${n0(R.nFormulas)} & ${ci(R.v1Reject)} & ${ci(R.v2Reject)} \\\\\n`; });
  rt += '\\bottomrule\n\\end{tabular}\n\\caption{Share of real-world formulas (\\%) rejected, with 95\\% intervals from a bootstrap over workbooks (300 workbooks per set). Rejections are concentrated in a few workbooks, so these intervals are much wider than formula-level ones.}\n\\label{tab:rw-sets}\n\\end{table}\n';
  write('tab_rw_sets.tex', rt);
}

const eqv = read('v21_equivalence.json');
if (eqv) { mac('eqInstances', n0(eqv.instances)); mac('eqDiff', eqv.verdictsDiffering); mac('eqFormulas', n0(eqv.generatedFormulas)); mac('eqHits', eqv.formulasTriggeringNewRules); }

// =====================================================================
// Optional human-run checks: they enrich the appendices when their result files exist
// =====================================================================
const packPath = path.join(__dirname, 'gsheets', 'pack.json');
if (fs.existsSync(packPath)) { const P = JSON.parse(fs.readFileSync(packPath, 'utf8')).meta; mac('gsPackCases', P.nCases); mac('gsPackWorkbooks', P.nWorkbooks); mac('gsPackPerFault', P.perFaultClass); mac('gsPackPerClean', P.perCleanClass); }
const gsv = read('gsheets_validation.json');
if (gsv) {
  const n = gsv.n;
  mac('gsN', n);
  mac('gsSame', f1((gsv.agree.bothError + gsv.agree.bothSameValue) / n));
  mac('gsHfErrOnly', gsv.agree.hfErrorOnly); mac('gsGsErrOnly', gsv.agree.gsErrorOnly); mac('gsDiffValues', gsv.agree.differentValues);
  const lf = gsv.labelFlip, ln = lf.same + lf.hfFaultGsClean + lf.hfCleanGsFault;
  mac('gsLabelSame', f1(lf.same / ln)); mac('gsFlipFault', lf.hfFaultGsClean); mac('gsFlipClean', lf.hfCleanGsFault);
  ['v1', 'v2'].forEach((d) => { const T = gsv.tab.fault; mac(`gs${d}RecallHF`, f1(T[d].hf / T.n.hf)); mac(`gs${d}RecallGS`, f1(T[d].gs / T.n.gs)); });
  mac('gsvtwoFPRGS', f1(gsv.tab.clean.v2.gs / Math.max(1, gsv.tab.clean.n.gs)));
}
const ann = read('annotation_summary.json');
if (ann) {
  const A = ann.agreement;
  mac('annN', ann.nScored); mac('annOf', A.of); mac('annKappa', A.kappa3.toFixed(2)); mac('annKappaYN', A.kappaYN.toFixed(2)); mac('annAgree', f1(A.rawAgreement3)); mac('annDisagree', A.disagreements);
  mac('annPrevalence', f1(ann.scores.groundcheck.reject.prevalence.est));
  const put = (nm, o) => { mac(`ann${nm}`, f1(o.est)); mac(`ann${nm}Lo`, f1(o.lo)); mac(`ann${nm}Hi`, f1(o.hi)); };
  put('VoneP', ann.scores.shipped.reject.precision); put('VoneR', ann.scores.shipped.reject.recall); put('VoneF', ann.scores.shipped.reject.fpr);
  put('VtwoP', ann.scores.groundcheck.reject.precision); put('VtwoR', ann.scores.groundcheck.reject.recall); put('VtwoF', ann.scores.groundcheck.reject.fpr);
}

write('numbers.tex', '% generated by eval/make_paper_assets.js -- do not edit\n' + macros.join('\n') + '\n');
console.log(`wrote ${macros.length} macros and tables to ${OUT}`);
