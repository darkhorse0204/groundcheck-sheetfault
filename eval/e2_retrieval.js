'use strict';
/**
 * E2 — Budgeted context retrieval.
 *
 *   node e2_retrieval.js [--workbooks 10]
 *
 * Multi-sheet workbooks (the user's own "Report" sheet plus 4-5 data sheets from
 * different domains and their lookup sheets, 10-16 tables in all). Each request
 * has a gold set of table chunks that a correct formula must read. We measure how
 * many gold chunks each retrieval method puts into the prompt at a given token
 * budget, and how many tokens that costs compared with sending everything.
 *
 * Request types:
 *   A  aggregate over a table on another sheet            (gold: that table)
 *   B  lookup from a lookup sheet                         (gold: the lookup table)
 *   C  "turn this formula into ..." with the active cell holding a formula that
 *      already reads a table, and no domain words in the request (anaphoric)
 * Mention levels for A/B: H = exact header words, S = paraphrase with no shared words.
 */
const fs = require('fs');
const path = require('path');
const { generateWorkbook, DOMAIN_NAMES, DOMAINS, colLetter } = require('./lib/workbookGen');
const { makeRng, hashSeed } = require('./lib/rng');
const { loadWorkbook } = require('./lib/gas');
const { wilson, mean } = require('./lib/stats');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const N_WB = parseInt(opt('workbooks', '10'), 10);
const BUDGETS = [250, 500, 1000, 1500, 3000];
const NOISE_LEVELS = [0, 10, 30];   // extra distractor tables appended to every workbook

const mention = (c, level, rng) => (level === 'S' && c.syn && c.syn.length ? rng.pick(c.syn) : c.h.toLowerCase());

// ---- distractor tables: generic business headers that overlap with real ones ----
const NOISE_HEADERS = ['Amount', 'Total', 'Name', 'ID', 'Status', 'Category', 'Notes', 'Date', 'Owner', 'Count', 'Value', 'Type', 'Region', 'Code', 'Score', 'Rate', 'Price', 'Priority'];
const NOISE_NAMES = ['Sheet', 'Archive', 'Tmp', 'Scratch', 'Backup', 'Old', 'Q1', 'Q2', 'Q3', 'Q4', 'Draft', 'Copy', 'Calc', 'Lists', 'Input', 'Output', 'Pivot', 'Work', 'Misc', 'Data'];
function noiseSheet(rng, k) {
  const n = rng.int(4, 7), rows = rng.int(8, 40);
  const heads = rng.sample(NOISE_HEADERS, n);
  const data = [heads];
  for (let r = 0; r < rows; r++) data.push(heads.map((h, i) => (i % 2 === 0 ? rng.int(1, 999) : rng.pick(['A', 'B', 'C', 'north', 'open', 'x1', 'misc']))));
  return { name: `${rng.pick(NOISE_NAMES)}${k}`, data };
}

// ---- workbook + request generation ----
function buildScenario(mainDomain, seed, noise) {
  const rng = makeRng(hashSeed('e2', mainDomain, seed));
  const others = rng.sample(DOMAIN_NAMES.filter((d) => d !== mainDomain), rng.int(3, 4));
  const parts = [generateWorkbook(mainDomain, seed)].concat(others.map((d, i) => generateWorkbook(d, seed * 10 + i + 1)));

  const sheets = {};
  const order = ['Report'];
  const tableIds = {};   // per part: { main: id, lookup: id }
  parts.forEach((p) => {
    sheets[p.main] = p.sheets[p.main];
    sheets[p.lookup.sheet] = p.sheets[p.lookup.sheet];
    order.push(p.main, p.lookup.sheet);
    tableIds[p.id] = {
      main: `${p.main}!A1:${colLetter(p.lastCol)}${p.lastRow}`,
      lookup: `${p.lookup.sheet}!A1:${colLetter(p.lookup.cols.length + 1)}${p.lookup.lastRow}`
    };
  });
  for (let k = 0; k < noise; k++) { const ns = noiseSheet(rng, k + 1); sheets[ns.name] = ns.data; order.push(ns.name); }
  rng.shuffle(order.slice(1)).forEach((n, i) => { order[i + 1] = n; });

  const target = parts[0];
  const numCols = target.columns.filter((c) => c.kind === 'int' || c.kind === 'money');
  const catCols = target.columns.filter((c) => c.kind === 'cat');
  const n = rng.pick(numCols), c = rng.pick(catCols);
  const val = rng.pick(Array.from(new Set(target.sheets[target.main].slice(1).map((r) => r[c.index - 1]))));
  const key = rng.pick(target.lookup.keys), vc = rng.pick(target.lookup.cols);

  // Report sheet: a small working table + (for type C) a live formula reading the target table.
  const sumRef = `=SUM(${target.main}!${n.letter}2:${n.letter}${target.lastRow})`;
  const report = [['Item', 'Value'], ['Total', sumRef], ['Note', 'draft'], ['', '']];
  sheets.Report = report;

  const reqs = [];
  ['H', 'S'].forEach((level) => {
    const nm = level === 'H' ? n.h : mention(n, level, rng), cm = level === 'H' ? c.h : mention(c, level, rng);
    reqs.push({ type: 'A', level, active: 'D3', nl: level === 'H' ? `Sum ${nm} where ${cm} is ${val}.` : `What is the total ${nm} for the ${val} ${cm}?`, gold: [tableIds[target.id].main] });
    const vn = level === 'H' ? vc.h : mention(vc, level, rng);
    reqs.push({ type: 'B', level, active: 'D3', nl: level === 'H' ? `Look up the ${vn} for ${key} in the ${target.lookup.sheet} sheet.` : `What is the ${vn} of ${key}?`, gold: [tableIds[target.id].lookup] });
  });
  reqs.push({ type: 'C', level: 'A', active: 'B2', nl: 'Change this to an average instead.', gold: [tableIds[target.id].main] });
  return { wb: { id: `e2-${mainDomain}-${seed}-n${noise}`, main: 'Report', sheets, sheetOrder: order, namedRanges: [], activeCell: 'D3', activeCol: 4 }, reqs, allTableIds: Object.values(tableIds).flatMap((t) => [t.main, t.lookup]) };
}

// ---- retrieval methods ----
function bm25Rank(chunks, query, k1 = 1.5, b = 0.75) {
  const tok = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);
  const docs = chunks.map((c) => tok(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  const df = {};
  docs.forEach((d) => new Set(d).forEach((t) => { df[t] = (df[t] || 0) + 1; }));
  const q = tok(query);
  return chunks.map((c, i) => {
    const tf = {}; docs[i].forEach((t) => { tf[t] = (tf[t] || 0) + 1; });
    let s = 0;
    q.forEach((t) => { if (!tf[t]) return; const idf = Math.log(1 + (chunks.length - df[t] + 0.5) / (df[t] + 0.5)); s += idf * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * docs[i].length / avg)); });
    return { chunk: c, score: s };
  }).sort((a, b2) => b2.score - a.score);
}

function fillBudget(ranked, budget) {
  const sel = []; let used = 0;
  ranked.forEach((e) => { if (used + e.chunk.tokenEstimate <= budget) { sel.push(e.chunk); used += e.chunk.tokenEstimate; } });
  return { chunks: sel, tokens: used };
}

const SIGNALS = ['activeSheet', 'referencedFormulas', 'semanticSimilarity', 'sharedHeaders', 'neighboringTables', 'dependencyGraph', 'previousConversation'];

function main() {
  const t0 = Date.now();
  const rows = [];
  for (const domain of DOMAIN_NAMES) {
   for (const noise of NOISE_LEVELS) {
    for (let seed = 1; seed <= N_WB; seed++) {
      const sc = buildScenario(domain, seed, noise);
      sc.reqs.forEach((req) => {
        const env = loadWorkbook(sc.wb, { activeCell: req.active });
        env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
        const sb = env.sandbox;
        sb.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Report').getRange('B2').setFormula(sc.wb.sheets.Report[1][1]);
        const model = sb.SpreadsheetEngine.analyze();
        const chunks = model.embeddingChunks;
        const tableChunks = chunks.filter((c) => c.type === 'table');
        const fullTokens = chunks.reduce((a, c) => a + c.tokenEstimate, 0);
        const rngR = makeRng(hashSeed('rand', sc.wb.id, req.nl));

        const evalSel = (selIds, tokens) => {
          const got = req.gold.filter((g) => selIds.includes(g)).length;
          return { recall: got / req.gold.length, complete: got === req.gold.length ? 1 : 0, tokens };
        };

        BUDGETS.forEach((B) => {
          const methods = {};
          // shipped 7-signal ranker, plus leave-one-signal-out
          const run = (weightsOff) => {
            const W = sb.CONTEXT_RETRIEVER_CONFIG_.WEIGHTS;
            const saved = {};
            (weightsOff || []).forEach((s) => { saved[s] = W[s]; W[s] = 0; });
            try {
              const sel = sb.ContextRetriever.selectContext(model, { prompt: req.nl, activeSheetName: 'Report', activeCellRef: req.active, conversationText: '', maxTokens: B });
              return evalSel(sel.selected.map((e) => e.chunk.id), sel.totalTokens);
            } finally { (weightsOff || []).forEach((s) => { W[s] = saved[s]; }); }
          };
          methods['ranker'] = run();
          SIGNALS.forEach((s) => { methods['-' + s] = run([s]); });
          // only-lexical (Jaccard) and only-active-sheet variants of the same scorer
          const only = (keep) => run(SIGNALS.filter((s) => s !== keep));
          // group ablations: the two graph signals (and the three structural ones) are redundant with each other
          methods['-graph signals'] = run(['referencedFormulas', 'dependencyGraph']);
          methods['-structural signals'] = run(['activeSheet', 'sharedHeaders', 'neighboringTables']);
          methods['only:graph signals'] = run(SIGNALS.filter((x) => x !== 'referencedFormulas' && x !== 'dependencyGraph'));
          methods['only:semanticSimilarity'] = only('semanticSimilarity');
          methods['only:activeSheet'] = only('activeSheet');
          // BM25 baseline
          const bm = fillBudget(bm25Rank(chunks, req.nl), B);
          methods['bm25'] = evalSel(bm.chunks.map((c) => c.id), bm.tokens);
          // random under the same budget
          const rnd = fillBudget(rngR.shuffle(chunks).map((c) => ({ chunk: c, score: 0 })), B);
          methods['random'] = evalSel(rnd.chunks.map((c) => c.id), rnd.tokens);
          // active sheet only (what the shipped flat context shows): no other-sheet tables
          const act = chunks.filter((c) => c.sheet === 'Report');
          methods['active-sheet-only'] = evalSel(act.map((c) => c.id), act.reduce((a, c) => a + c.tokenEstimate, 0));
          // everything
          methods['full-dump'] = evalSel(chunks.map((c) => c.id), fullTokens);
          rows.push({ wb: sc.wb.id, domain, noise, type: req.type, level: req.level, budget: B, nChunks: chunks.length, nTables: tableChunks.length, fullTokens, methods });
        });
      });
    }
   }
    console.error(`  ${domain} done (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // ---- aggregate ----
  const methodNames = Object.keys(rows[0].methods);
  const summary = { budgets: BUDGETS, noiseLevels: NOISE_LEVELS, byNoise: {} };
  NOISE_LEVELS.forEach((nz) => {
    const sub = rows.filter((r) => r.noise === nz);
    const first = sub.filter((r) => r.budget === BUDGETS[0]);
    const S = { nRequests: first.length, meanChunks: mean(first.map((r) => r.nChunks)), meanTables: mean(first.map((r) => r.nTables)), meanFullTokens: mean(first.map((r) => r.fullTokens)), byMethod: {} };
    methodNames.forEach((m) => {
      S.byMethod[m] = {};
      BUDGETS.forEach((B) => {
        const rs = sub.filter((r) => r.budget === B);
        S.byMethod[m][B] = { complete: wilson(rs.filter((r) => r.methods[m].complete === 1).length, rs.length), recall: mean(rs.map((r) => r.methods[m].recall)), tokens: mean(rs.map((r) => r.methods[m].tokens)), tokenReduction: 1 - mean(rs.map((r) => r.methods[m].tokens / r.fullTokens)) };
      });
      S.byMethod[m].byType = {};
      ['A', 'B', 'C'].forEach((t) => ['H', 'S', 'A'].forEach((lv) => {
        const rs = sub.filter((r) => r.budget === 1500 && r.type === t && r.level === lv);
        if (rs.length) S.byMethod[m].byType[`${t}-${lv}`] = { n: rs.length, complete: wilson(rs.filter((r) => r.methods[m].complete === 1).length, rs.length) };
      }));
    });
    summary.byNoise[nz] = S;
  });

  fs.writeFileSync(path.join(__dirname, 'results', 'e2_retrieval.json'), JSON.stringify({ summary }, null, 1));
  NOISE_LEVELS.forEach((nz) => {
    const S = summary.byNoise[nz];
    console.log(`
=== +${nz} distractor tables: requests=${S.nRequests} mean tables=${S.meanTables.toFixed(1)} mean full-dump tokens=${S.meanFullTokens.toFixed(0)} ===`);
    console.log('GOLD-COMPLETE % by budget:  method'.padEnd(34), BUDGETS.map((b) => String(b).padStart(6)).join(''), '  tokens@1500 reduction');
    methodNames.forEach((m) => {
      console.log(m.padEnd(34), BUDGETS.map((b) => (100 * S.byMethod[m][b].complete.p).toFixed(1).padStart(6)).join(''), String(S.byMethod[m][1500].tokens.toFixed(0)).padStart(8), (100 * S.byMethod[m][1500].tokenReduction).toFixed(1).padStart(8) + '%');
    });
  });
}

main();
