"""Generates paper/figures/*.pdf from eval/results/*.json (matplotlib, vector PDF)."""
import json, os, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
OUT = os.path.join(HERE, '..', 'paper', 'figures')
os.makedirs(OUT, exist_ok=True)

plt.rcParams.update({
    'pdf.fonttype': 42, 'ps.fonttype': 42, 'font.family': 'serif', 'font.serif': ['Times New Roman', 'Times', 'Nimbus Roman', 'Liberation Serif', 'DejaVu Serif'], 'font.size': 8, 'mathtext.fontset': 'stix',
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.linewidth': 0.6,
    'xtick.major.width': 0.6, 'ytick.major.width': 0.6, 'legend.frameon': False,
})
# Okabe-Ito colour-blind-safe palette
C = {'blue': '#0072B2', 'orange': '#E69F00', 'green': '#009E73', 'red': '#D55E00', 'purple': '#CC79A7', 'sky': '#56B4E9', 'grey': '#999999', 'black': '#222222'}

def load(name):
    p = os.path.join(RES, name)
    return json.load(open(p, encoding='utf8')) if os.path.exists(p) else None

# ------------------------------------------------------------------ E1: per-class recall
e1 = load('e1_main.json')
if e1:
    S = e1['summary']
    pretty = {
        'unbalanced_paren': 'Unbalanced paren', 'unbalanced_quote': 'Unbalanced quote', 'missing_equals': 'Missing =', 'injection': 'Injection',
        'ghost_function': 'Hallucinated function', 'ghost_sheet': 'Non-existent sheet', 'ghost_column': 'Column beyond data', 'header_as_name': 'Header used as name', 'query_col_oob': 'QUERY column OOB',
        'lookup_index_oob': 'VLOOKUP index OOB', 'range_size_mismatch': 'Range size mismatch', 'ghost_value': 'Criterion not in column', 'type_mismatch': 'Aggregate over text',
        'self_reference': 'Self reference', 'range_contains_self': 'Range contains self', 'column_contains_self': 'Column contains self', 'cycle_indirect_cell': 'Cycle via cell', 'cycle_indirect_range': 'Cycle via range',
        'wrong_numeric_col': 'Wrong numeric column', 'wrong_function': 'Wrong function'}
    order = [c for g in e1['groups'].values() for c in g if c in S['perClass']['v2']]
    fig, ax = plt.subplots(figsize=(3.45, 3.7))
    h = 0.26
    for i, cls in enumerate(order):
        y = len(order) - 1 - i
        for j, (det, col, lab) in enumerate([('lint', C['grey'], 'Linter'), ('v1', C['orange'], 'Shipped (v1)'), ('v2', C['blue'], 'GroundCheck')]):
            v = 100 * S['perClass'][det][cls]['reject']['p']
            ax.barh(y + (1 - j) * h, v, height=h * 0.9, color=col, label=lab if i == 0 else None)
    ax.set_yticks([len(order) - 1 - i for i in range(len(order))])
    ax.set_yticklabels([pretty.get(c, c) for c in order], fontsize=6.5)
    ax.set_xlim(0, 100); ax.set_xlabel('Recall when blocking only on errors (%)')
    ax.legend(loc='lower right', fontsize=6.5, bbox_to_anchor=(1.0, 0.0))
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e1_classes.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E2: gold-complete vs budget
e2 = load('e2_retrieval.json')
if e2:
    S = e2['summary']; B = S['budgets']
    fig, axes = plt.subplots(2, 1, figsize=(3.45, 3.3), sharey=True)
    for ax, nz, title in [(axes[0], '10', None), (axes[1], '30', None)]:
        N = S['byNoise'][nz]
        for key, lab, col, ls in [('ranker', 'Seven-signal ranker', C['blue'], '-'), ('bm25', 'BM25', C['orange'], '--'), ('only:semanticSimilarity', 'Lexical only', C['green'], ':'), ('-graph signals', 'Ranker w/o graph', C['purple'], '-.'), ('random', 'Random', C['grey'], '-')]:
            ax.plot(B, [100 * N['byMethod'][key][str(b)]['complete']['p'] for b in B], ls, color=col, marker='o', ms=2.5, lw=1.1, label=lab)
        ax.axvline(N['meanFullTokens'], color=C['black'], lw=0.6, ls=':')
        ax.text(N['meanFullTokens'] * 0.97, 55, 'whole workbook', rotation=90, fontsize=6, ha='right', va='center')
        ax.set_xscale('log'); ax.minorticks_off(); ax.set_xticks(B); ax.set_xticklabels([str(b) for b in B], fontsize=6.5)
        ax.set_xlabel('Context budget (tokens)'); ax.set_title(f"{round(N['meanTables'])} tables", fontsize=8)
        ax.set_ylabel('Requests with all gold\ntables in the prompt (%)', fontsize=7)
        ax.set_ylim(0, 102)
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, fontsize=6, loc='upper center', ncol=3, frameon=False, bbox_to_anchor=(0.5, 1.0))
    fig.tight_layout(rect=[0, 0, 1, 0.9]); fig.savefig(os.path.join(OUT, 'fig_e2_budget.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E5: repair strategies
e5 = load('e5_summary.json')
if e5:
    e5 = [m for m in e5 if 'heldout' not in m['model'] and m['repair']['strategies']['v2fb']['transitions']['n'] >= 10]  # models with enough rejected attempts; the held-out run is in the table
    strat = [('resample', 'Resample'), ('generic', 'Generic\nfeedback'), ('v1fb', 'Shipped\nverifier'), ('v2fb', 'Ground-\nCheck'), ('v2fb+susp', 'GC +\nsuspicious')]
    cols = [C['blue'], C['orange'], C['green']]
    fig, ax = plt.subplots(figsize=(3.45, 2.2))
    k = len(e5); w = 0.8 / k
    for mi, m in enumerate(e5):
        base = 100 * m['repair']['attempt1']['p']
        vals = [100 * m['repair']['strategies'][s]['accuracy']['p'] for s, _ in strat]
        lo = [100 * m['repair']['strategies'][s]['accuracy']['lo'] for s, _ in strat]
        hi = [100 * m['repair']['strategies'][s]['accuracy']['hi'] for s, _ in strat]
        xs = [i + (mi - (k - 1) / 2) * w for i in range(len(strat))]
        ax.bar(xs, vals, width=w * 0.92, color=cols[mi % 3], label={'llama3.1-8b': 'Llama 3.1 8B', 'llama3.2-3b': 'Llama 3.2 3B', 'llama3.1-8b-heldout': 'Llama 3.1 8B (held-out)', 'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite'}.get(m['model'], m['model']) + f' (n={m["repair"]["n"]})')
        ax.errorbar(xs, vals, yerr=[[v - l for v, l in zip(vals, lo)], [h - v for v, h in zip(vals, hi)]], fmt='none', ecolor=C['black'], elinewidth=0.6, capsize=1.5)
        ax.hlines(base, xs[0] - w / 2, xs[-1] + w / 2, colors=cols[mi % 3], linestyles='--', lw=0.8)
    ax.set_xticks(range(len(strat))); ax.set_xticklabels([n for _, n in strat], fontsize=6)
    lo_all = min(100 * m['repair']['attempt1']['lo'] for m in e5)
    ax.set_ylim(max(0, lo_all - 8), 100)
    ax.set_ylabel('Execution accuracy (%)'); ax.legend(fontsize=6, loc='lower center', bbox_to_anchor=(0.5, 1.0), ncol=2, borderaxespad=0.2)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e5_repair.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E1: loud vs silent faults, per detector
if e1:
    S = e1['summary']; V = S['byVisibility']
    dets = [('syntax', 'Lexical', C['grey']), ('lint', 'Linter', C['sky']), ('v1', 'Shipped', C['orange']), ('v2', 'GroundCheck', C['blue'])]
    fig, axes = plt.subplots(1, 2, figsize=(3.45, 2.0), sharey=True)
    for ax, vis, title in [(axes[0], 'loud', 'Loud faults'), (axes[1], 'silent', 'Silent faults')]:
        for i, (d, lab, col) in enumerate(dets):
            rej = 100 * V[d][vis]['reject']['p']; flg = 100 * V[d][vis]['flag']['p']
            ax.bar(i, rej, color=col, width=0.72)
            ax.bar(i, max(0, flg - rej), bottom=rej, color=col, alpha=0.35, hatch='////', edgecolor='white', linewidth=0, width=0.72)
            ax.text(i, flg + 1.5, f'{rej:.0f}' if flg - rej < 1 else f'{rej:.0f}/{flg:.0f}', ha='center', fontsize=5.5)
        ax.set_xticks(range(len(dets))); ax.set_xticklabels([l for _, l, _ in dets], rotation=30, ha='right', fontsize=6.5)
        ax.set_title(f"{title} (n={V['v2'][vis]['n']:,})", fontsize=7.5); ax.set_ylim(0, 108)
    axes[0].set_ylabel('Recall (%)')
    from matplotlib.patches import Patch
    axes[1].legend(handles=[Patch(facecolor='#555555', label='blocked'), Patch(facecolor='#555555', alpha=0.35, hatch='////', edgecolor='white', label='warned only')], fontsize=6, loc='upper left')
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e1_visibility.pdf')); plt.close(fig)

# ------------------------------------------------------------------ extra cuts (analyze_extra.js)
X = load('extra_summary.json')
if X:
    import random
    # ---- per-domain recall, shipped vs GroundCheck, with the 12 per-workbook values
    D = X['e1Domain']
    doms = sorted(D.keys(), key=lambda d: -D[d]['v2']['recall']['p'])
    fig, ax = plt.subplots(figsize=(3.45, 2.0))
    random.seed(7)
    for j, (det, lab, col) in enumerate([('v1', 'Shipped (v1)', C['orange']), ('v2', 'GroundCheck', C['blue'])]):
        xs = [i + (j - 0.5) * 0.38 for i in range(len(doms))]
        vals = [100 * D[d][det]['recall']['p'] for d in doms]
        lo = [100 * D[d][det]['recall']['lo'] for d in doms]; hi = [100 * D[d][det]['recall']['hi'] for d in doms]
        ax.bar(xs, vals, width=0.34, color=col, alpha=0.75, label=lab)
        ax.errorbar(xs, vals, yerr=[[v - l for v, l in zip(vals, lo)], [h - v for v, h in zip(vals, hi)]], fmt='none', ecolor=C['black'], elinewidth=0.6, capsize=1.2)
        for x, d in zip(xs, doms):
            pts = [100 * v for v in D[d][det]['perWorkbook']]
            ax.scatter([x + random.uniform(-0.07, 0.07) for _ in pts], pts, s=2.2, color=C['black'], zorder=3, linewidths=0)
    ax.set_xticks(range(len(doms))); ax.set_xticklabels([('HR' if d == 'hr' else d.capitalize()) for d in doms], fontsize=6.5)
    ax.set_ylim(0, 100); ax.set_ylabel('Reject recall (%)'); ax.legend(fontsize=6, loc='upper center', ncol=2, bbox_to_anchor=(0.5, 1.12))
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e1_domain.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E5: what verification sees among the wrong first attempts
e5all = load('e5_summary.json')
if e5all:
    nm = {'llama3.1-8b': 'Llama 3.1 8B', 'llama3.2-3b': 'Llama 3.2 3B', 'llama3.1-8b-heldout': 'Llama 3.1 8B\n(new tasks)', 'gemini-3.1-flash-lite': 'Gemini 3.1\nFlash-Lite', 'gemini-3.5-flash-lite': 'Gemini 3.5\nFlash-Lite', 'gemma-4-26b-a4b-it': 'Gemma 4\n26B-A4B'}
    fig, ax = plt.subplots(figsize=(3.45, 2.3))
    segs = [('Rejected by shipped verifier', C['orange']), ('Also rejected by GroundCheck', C['blue']), ('Only warned', C['sky']), ('Not seen', '#BBBBBB')]
    rows = list(reversed(e5all))
    for yi, m in enumerate(rows):
        t = m['taxonomy']; nw = max(1, t['nWrong'])
        v1 = min(t['v1']['reject'], t['v2']['reject']); v2x = t['v2']['reject'] - v1; warn = t['v2']['flag'] - t['v2']['reject']; unseen = t['nWrong'] - t['v2']['flag']
        left = 0
        for (lab, col), n in zip(segs, [v1, v2x, warn, unseen]):
            w = 100 * n / nw
            ax.barh(yi, w, left=left, color=col, height=0.62, label=lab if yi == 0 else None)
            if w >= 8:
                ax.text(left + w / 2, yi, str(n), ha='center', va='center', fontsize=6, color='white' if col in (C['blue'],) else 'black')
            left += w
    ax.set_yticks(range(len(rows))); ax.set_yticklabels([f"{nm.get(m['model'], m['model'])}  (n={m['taxonomy']['nWrong']})" for m in rows], fontsize=6)
    ax.set_xlim(0, 100); ax.set_xlabel('Share of the wrong first attempts (%)')
    ax.legend(fontsize=5.8, loc='lower center', bbox_to_anchor=(0.45, 1.0), ncol=2, columnspacing=0.8, handlelength=1.0)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e5_taxonomy.pdf')); plt.close(fig)

    # ---- what repair does to the attempts the verifier rejected: right, plausible-but-wrong (silent), or an error still shown
    R = load('robust_summary.json')
    strat = [('resample', 'Resample'), ('generic', 'Generic'), ('v1fb', 'Shipped'), ('v2fb', 'GroundCheck'), ('v2fb+susp', 'GC + susp.')]
    if R:
        show = [m for m in e5all if m['model'] in ('llama3.1-8b', 'llama3.2-3b') and m['model'] in R['e5']]
        fig, axes = plt.subplots(len(show), 1, figsize=(3.45, 2.55), sharex=True)
        axes = [axes] if len(show) == 1 else list(axes)
        parts = [('correct', 'Right', C['green']), ('silentWrong', 'Plausible but wrong (silent)', C['red']), ('loudWrong', 'Error still shown', '#BBBBBB')]
        for ax, m in zip(axes, show):
            U = R['e5'][m['model']]['unsafe']
            for yi, (s_, lab) in enumerate(reversed(strat)):
                tr = U[s_]; n = max(1, tr['n']); left = 0
                for k, pl, col in parts:
                    w = 100 * tr[k] / n
                    ax.barh(yi, w, left=left, color=col, height=0.66, label=pl if (yi == 0 and m is show[0]) else None)
                    if w >= 9:
                        ax.text(left + w / 2, yi, str(tr[k]), ha='center', va='center', fontsize=5.8, color='white' if col != '#BBBBBB' else 'black')
                    left += w
            ax.set_yticks(range(len(strat))); ax.set_yticklabels([l for _, l in reversed(strat)], fontsize=6.3)
            ax.set_title(f"{nm.get(m['model'], m['model']).replace(chr(10), ' ')}: {U['v2fb']['n']} rejected first attempts", fontsize=7, pad=2)
            ax.set_xlim(0, 100)
        axes[-1].set_xlabel('Outcome after repair (% of rejected attempts)')
        axes[0].legend(fontsize=5.8, loc='lower center', bbox_to_anchor=(0.5, 1.28), ncol=3, columnspacing=0.8, handlelength=1.0)
        fig.tight_layout(h_pad=0.6); fig.savefig(os.path.join(OUT, 'fig_e5_repair_fate.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E5: accuracy per task template and model (heatmap)
if X:
    import numpy as np
    tpl = {'agg': 'aggregate', 'count_rows': 'record count', 'cond_sum': 'conditional sum', 'cond_count': 'conditional count', 'cond_avg': 'conditional average', 'two_cond': 'two conditions',
           'lookup': 'cross-sheet lookup', 'pct_of_total': 'share of total', 'count_gt': 'count above threshold', 'max_if': 'MAXIFS', 'sumproduct': 'SUMPRODUCT', 'round_avg': 'rounded average',
           'large_k': 'k-th largest', 'top_cat': 'INDEX/MATCH of max'}
    allm = [('llama3.1-8b', 'Llama 3.1\n8B'), ('llama3.2-3b', 'Llama 3.2\n3B'), ('llama3.1-8b-heldout', 'Llama 3.1 8B,\nnew tasks'), ('gemini-3.1-flash-lite', 'Gemini 3.1\nFlash-Lite'), ('gemini-3.5-flash-lite', 'Gemini 3.5\nFlash-Lite'), ('gemma-4-26b-a4b-it', 'Gemma 4\n26B-A4B')]
    allm = [(m, h) for m, h in allm if m in X['e5']]
    mods = [m for m, _ in allm]; heads = [h for _, h in allm]
    types = list(tpl.keys())
    M = np.array([[100 * X['e5'][m]['byType']['retr'].get(t, {'acc': float('nan')})['acc'] for m in mods] for t in types])
    order = np.argsort(-np.nanmean(M[:, :3], axis=1))
    types = [types[i] for i in order]; M = M[order]
    fig, ax = plt.subplots(figsize=(3.45, 3.0))
    im = ax.imshow(M, cmap='cividis', vmin=0, vmax=100, aspect='auto')
    # six model names do not fit side by side at column width, so they are set on one line and tilted
    ax.set_xticks(range(len(mods))); ax.set_xticklabels([h.replace('\n', ' ') for h in heads], fontsize=6.2, rotation=40, ha='left', rotation_mode='anchor')
    ax.set_yticks(range(len(types))); ax.set_yticklabels([tpl[t] for t in types], fontsize=6.3)
    ax.xaxis.tick_top(); ax.tick_params(length=0)
    for s in ax.spines.values():
        s.set_visible(False)
    for i in range(M.shape[0]):
        for j in range(M.shape[1]):
            v = M[i, j]
            if not np.isnan(v):
                ax.text(j, i, f'{v:.0f}', ha='center', va='center', fontsize=6.3, color='white' if v < 62 else 'black')
    cb = fig.colorbar(im, ax=ax, fraction=0.045, pad=0.02); cb.ax.tick_params(labelsize=6); cb.set_label('Attempt-1 accuracy (%)', fontsize=6.5)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e5_templates.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E2: gold-complete rate as the workbook grows
e2b = load('e2_retrieval.json')
if e2b:
    S2 = e2b['summary']
    fig, ax = plt.subplots(figsize=(3.45, 1.95))
    series = [('ranker', 'Seven-signal ranker', C['blue'], '-', 'o'), ('bm25', 'BM25', C['orange'], '--', 's'), ('only:semanticSimilarity', 'Lexical only', C['green'], ':', '^'),
              ('random', 'Random', C['grey'], '-', 'x'), ('active-sheet-only', 'Active sheet only', C['black'], '-.', 'd')]
    for key, lab, col, ls, mk in series:
        xs, ys = [], []
        for nz in S2['noiseLevels'] if 'noiseLevels' in S2 else ['0', '10', '30']:
            N = S2['byNoise'][str(nz)]
            xs.append(N['meanFullTokens']); ys.append(100 * N['byMethod'][key]['1500']['complete']['p'])
        ax.plot(xs, ys, ls, color=col, marker=mk, ms=3, lw=1.1, label=lab)
    ax.axvline(1500, color=C['black'], lw=0.6, ls=':')
    ax.text(1560, 8, 'budget\n1,500', fontsize=6, va='bottom')
    ax.set_xscale('log'); ax.minorticks_off()
    ticks = [S2['byNoise'][str(nz)]['meanFullTokens'] for nz in (S2['noiseLevels'] if 'noiseLevels' in S2 else ['0', '10', '30'])]
    ax.set_xticks(ticks); ax.set_xticklabels([f'{round(t):,}\n({round(S2["byNoise"][str(nz)]["meanTables"])} tables)' for t, nz in zip(ticks, (S2['noiseLevels'] if 'noiseLevels' in S2 else ['0', '10', '30']))], fontsize=6.3)
    ax.set_xlabel('Whole workbook (tokens)', fontsize=7); ax.set_ylabel('Requests with all\ngold tables (%)', fontsize=7); ax.set_ylim(0, 104)
    ax.legend(fontsize=5.8, loc='center left', ncol=1, bbox_to_anchor=(0.0, 0.40))
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_e2_scale.pdf')); plt.close(fig)

# ------------------------------------------------------------------ E3: cost
e3 = load('e3_scalability.json')
if e3:
    A = e3['analyze']
    fig, axes = plt.subplots(1, 2, figsize=(3.45, 1.9))
    base = [a for a in A if a['sheets'] == 3 and a['formulas'] == 0]
    base.sort(key=lambda a: a['rows'])
    ax = axes[0]
    for key, lab, col, ls in [('analyzeMs', 'Analysis', C['black'], '-'), ('v1Ms', 'Verify v1', C['orange'], '--'), ('v2Ms', 'Verify GC', C['blue'], '-')]:
        ax.plot([a['rows'] for a in base], [a[key] for a in base], ls, color=col, marker='o', ms=2.5, lw=1.1, label=lab)
    withf = [a for a in A if a['sheets'] == 3 and a['formulas'] > 0]
    ax.scatter([a['rows'] for a in withf], [a['analyzeMs'] for a in withf], marker='D', s=9, color=C['red'], zorder=3, label='Analysis, rows=formulas')
    ax.set_xlabel('Rows per sheet', fontsize=7); ax.set_ylabel('CPU time (ms)', fontsize=7); ax.legend(fontsize=5.5, loc='upper left')
    ax = axes[1]
    sw = sorted([a for a in A if a['rows'] == 500 and (a['formulas'] in (0, 100))], key=lambda a: a['sheets'])
    sw = [a for a in sw if not (a['sheets'] == 3 and a['formulas'] != 0)]
    for key, lab, col, ls in [('analyzeCalls', 'Analysis', C['black'], '-'), ('v1Calls', 'Verify v1', C['orange'], '--'), ('v2Calls', 'Verify GC', C['blue'], '-')]:
        ax.plot([a['sheets'] for a in sw], [a[key] for a in sw], ls, color=col, marker='o', ms=2.5, lw=1.1, label=lab)
    ax.set_xlabel('Sheets', fontsize=7); ax.set_ylabel('SpreadsheetApp calls', fontsize=7)
    fig.tight_layout(w_pad=0.8); fig.savefig(os.path.join(OUT, 'fig_e3_cost.pdf')); plt.close(fig)

# ------------------------------------------------------------------ real-world sets: where the two verifiers disagree
RB = load('robust_summary.json')
if RB and RB.get('realWorld'):
    RW = RB['realWorld']
    sets = [('test', 'Held-out\n(first pass)'), ('fresh', 'Confirmation 1\n(frozen v2)'), ('fresh2', 'Confirmation 2\n(frozen v2.1)')]
    sets = [(k, lab) for k, lab in sets if k in RW]
    parts = [('both', 'Rejected by both', C['grey']),
             ('onlyV2Real', 'Only GroundCheck (engine error)', C['blue']),
             ('onlyV2Empty', 'Only GroundCheck (blanked formula)', C['sky']),
             ('onlyV1RefLiteral', 'Only shipped: #REF! left in formula', C['orange']),
             ('onlyV1Indirect', 'Only shipped: INDIRECT text', '#F2C57C'),
             ('onlyV1Other', 'Only shipped: other', C['red'])]
    fig, ax = plt.subplots(figsize=(3.45, 1.9))
    for yi, (k, lab) in enumerate(reversed(sets)):
        O = RW[k]['overlap']; left = 0
        for key, pl, col in parts:
            v = O.get(key, 0)
            ax.barh(yi, v, left=left, color=col, height=0.62, label=pl if yi == 0 else None)
            if v >= 28:
                ax.text(left + v / 2, yi, str(v), ha='center', va='center', fontsize=5.8, color='white' if col in (C['blue'], C['red'], C['grey']) else 'black')
            left += v
    ax.set_yticks(range(len(sets))); ax.set_yticklabels([lab for _, lab in reversed(sets)], fontsize=6.3)
    ax.set_xlabel('Formulas rejected by at least one verifier', fontsize=7)
    ax.legend(fontsize=5.4, loc='upper center', bbox_to_anchor=(0.42, -0.46), ncol=2, columnspacing=0.8, handlelength=1.0)
    fig.tight_layout(); fig.savefig(os.path.join(OUT, 'fig_rw_overlap.pdf'), bbox_inches='tight'); plt.close(fig)

print('figures written to', OUT)
