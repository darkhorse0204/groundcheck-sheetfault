"""Converts the paper's LaTeX sources (sections, generated tables, figure files) into a neutral block structure that
build_docx.py lays out in the Word document. Every number in the prose is still taken from generated/numbers.tex, so the
Word version cannot drift from the LaTeX/PDF version.

Block kinds
  ('h1', title, label) ('h2', title, label) ('h3', title)            headings (h3 = run-in lead)
  ('p', runs)  ('list', [runs, ...])  ('quote', [runs, ...])
  ('table', dict)  ('figure', dict)
Runs are dicts {'t': text, 'b','i','mono','sup','sub','blue','nb' flags} or special: {'cite': [keys]}, {'xref': (word,label)}, {'br': True}
"""
import os, re

HERE = os.path.dirname(os.path.abspath(__file__))
PAPER = os.path.abspath(os.path.join(HERE, '..'))
ASSETS = os.path.join(HERE, 'assets')


# ----------------------------------------------------------------------------------------------- macros / conditionals
def load_macros():
    macros = {}
    for line in open(os.path.join(PAPER, 'generated', 'numbers.tex'), encoding='utf8'):
        m = re.match(r'^\\newcommand\{\\(\w+)\}\{(.*)\}\s*$', line.rstrip('\n'))
        if m:
            macros[m.group(1)] = m.group(2)
    macros['gc'] = 'GroundCheck'
    macros['sheetfault'] = 'SheetFault'
    return macros


MACROS = load_macros()
DEFINED = set(MACROS)


def strip_comments(t):
    return re.sub(r'(?m)(?<!\\)%.*$', '', t)


def resolve_ifs(t):
    parts = re.split(r'(\\ifdefined\\[A-Za-z]+|\\else(?![A-Za-z])|\\fi(?![A-Za-z]))', t)
    out, stack = [], []
    for p in parts:
        if p.startswith('\\ifdefined'):
            stack.append([p[len('\\ifdefined\\'):] in DEFINED, False])
        elif p == '\\else':
            stack[-1][1] = True
        elif p == '\\fi':
            stack.pop()
        elif all((c if not e else not c) for c, e in stack):
            out.append(p)
    assert not stack, 'unbalanced \\ifdefined'
    return ''.join(out)


def expand_macros(t):
    def rep(m):
        n = m.group(1)
        return MACROS[n] if n in MACROS else m.group(0)
    return re.sub(r'\\([A-Za-z]+)', rep, t)


def preprocess(t):
    t = strip_comments(t)
    t = resolve_ifs(t)
    t = expand_macros(t)
    # "Table~\ref{x}" etc. become one cross-reference command so that the rendering can follow the journal style
    t = re.sub(r'(Table|Figure|Section|Appendix)~\\ref\{([^}]+)\}', lambda m: '\\xref{%s}{%s}' % (m.group(1), m.group(2)), t)
    return t


# ----------------------------------------------------------------------------------------------------- brace helpers
def find_group(s, i):
    """s[i] == '{': returns (content, index after the closing brace)."""
    assert s[i] == '{', s[i:i + 30]
    depth, j = 0, i
    while j < len(s):
        c = s[j]
        if c == '\\':
            j += 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1
    raise ValueError('unbalanced braces: ' + s[i:i + 60])


def split_top(s, sep):
    """Split on sep (a string) at brace depth 0."""
    out, depth, cur, i = [], 0, [], 0
    while i < len(s):
        c = s[i]
        if c == '\\' and s.startswith(sep, i) and depth == 0 and sep.startswith('\\'):
            out.append(''.join(cur)); cur = []; i += len(sep); continue
        if c == '\\':
            cur.append(s[i:i + 2]); i += 2; continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        if depth == 0 and sep == '&' and c == '&':
            out.append(''.join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    out.append(''.join(cur))
    return out


# ------------------------------------------------------------------------------------------------------------ inline
GREEK = {'Delta': 'Δ', 'kappa': 'κ', 'times': '×', 'to': '→', 'rightarrow': '→', 'leftrightarrow': '↔', 'ast': '*', 'pm': '±'}


def run(t, **f):
    d = {'t': t}
    d.update({k: True for k, v in f.items() if v})
    return d


def parse_math(src, fmt):
    runs, i = [], 0
    while i < len(src):
        c = src[i]
        if c == '\\':
            m = re.match(r'\\([A-Za-z]+)', src[i:])
            if m:
                name = m.group(1)
                i += len(m.group(0))
                if name == 'text' and i < len(src) and src[i] == '{':
                    g, i = find_group(src, i)
                    runs.append(run(g, **fmt))
                elif name in GREEK:
                    runs.append(run(GREEK[name], **fmt))
                continue
            i += 2
            continue
        if c in '_^' and i + 1 < len(src):
            flag = 'sub' if c == '_' else 'sup'
            if src[i + 1] == '{':
                g, i = find_group(src, i + 1)
            else:
                g, i = src[i + 1], i + 2
            for r in parse_math(g, dict(fmt, **{flag: True})):
                runs.append(r)
            continue
        if c in '{}':
            i += 1
            continue
        if c == '-':
            runs.append(run('−', **fmt)); i += 1; continue
        # letters in math are italic
        runs.append(run(c, **dict(fmt, i=not fmt.get('i'))) if c.isalpha() else run(c, **fmt))
        i += 1
    return runs


def parse_inline(src, fmt=None):
    fmt = dict(fmt or {})
    runs, buf, i, n = [], [], 0, len(src)

    def flush():
        if buf:
            runs.append(run(''.join(buf), **fmt))
            buf.clear()

    def sub(g, **extra):
        flush()
        runs.extend(parse_inline(g, dict(fmt, **extra)))

    while i < n:
        c = src[i]
        if c == '\\':
            if i + 1 >= n:
                break
            nxt = src[i + 1]
            if not nxt.isalpha():
                i += 2
                if nxt in '%&_#${}':
                    buf.append(nxt)
                elif nxt == '\\':
                    flush(); runs.append({'br': True})
                elif nxt == ',':
                    buf.append('\u2009')
                elif nxt == ' ':
                    buf.append(' ')
                elif nxt == '-':
                    pass
                continue
            m = re.match(r'\\([A-Za-z]+)\*?', src[i:])
            name = m.group(1)
            i += len(m.group(0))
            # skip optional [..] and swallow nothing else
            if name in ('textbf', 'emph', 'textit', 'code', 'texttt', 'textsc', 'text', 'textrm', 'mbox', 'underline'):
                g, i = find_group(src, i)
                if name == 'textbf':
                    sub(g, b=True)
                elif name in ('emph', 'textit'):
                    sub(g, i=not fmt.get('i'))
                elif name in ('code', 'texttt'):
                    sub(g, mono=True)
                else:
                    sub(g)
            elif name == 'cite':
                g, i = find_group(src, i)
                flush(); runs.append({'cite': [k.strip() for k in g.split(',')]})
            elif name == 'xref':
                w, i = find_group(src, i)
                lab, i = find_group(src, i)
                flush(); runs.append({'xref': (w, lab)})
            elif name == 'ref':
                g, i = find_group(src, i)
                flush(); runs.append({'xref': ('', g)})
            elif name == 'label':
                _, i = find_group(src, i)
            elif name == 'shortstack':
                if i < n and src[i] == '[':
                    i = src.index(']', i) + 1
                g, i = find_group(src, i)
                sub(g)
            elif name == 'hspace':
                if i < n and src[i] == '{':
                    _, i = find_group(src, i)
                buf.append('  ')
            elif name == 'dots':
                buf.append('…')
            elif name == 'textquotedblleft':
                buf.append('“')
            elif name == 'textquotedblright':
                buf.append('”')
            elif name in ('small', 'footnotesize', 'ttfamily', 'raggedright', 'arraybackslash', 'centering', 'itemsep', 'topsep'):
                pass
            elif name in GREEK:
                buf.append(GREEK[name])
            else:
                raise ValueError('unhandled command \\' + name + ' near: ' + src[max(0, i - 40):i + 40])
            continue
        if c == '$':
            j = i + 1
            while j < n and src[j] != '$':
                j += 2 if src[j] == '\\' else 1
            flush()
            runs.extend(parse_math(src[i + 1:j], fmt))
            i = j + 1
            continue
        if c == '{':
            g, i = find_group(src, i)
            sub(g)
            continue
        if c == '}':
            i += 1
            continue
        if c == '~':
            buf.append('\u00a0'); i += 1; continue
        if src.startswith('---', i):
            buf.append('—'); i += 3; continue
        if src.startswith('--', i):
            buf.append('–'); i += 2; continue
        if src.startswith('``', i):
            buf.append('“'); i += 2; continue
        if src.startswith("''", i):
            buf.append('”'); i += 2; continue
        if c == '`':
            buf.append('‘'); i += 1; continue
        if c == "'" and not fmt.get('mono'):
            buf.append('’'); i += 1; continue
        if c == '\n':
            buf.append(' '); i += 1; continue
        buf.append(c)
        i += 1
    flush()
    # collapse double spaces created by line joins
    out = []
    for r in runs:
        if 't' in r and not r.get('mono'):
            r['t'] = re.sub(r' {2,}', ' ', r['t'])
        out.append(r)
    return merge_runs(out)


def merge_runs(runs):
    out = []
    for r in runs:
        if out and 't' in r and 't' in out[-1] and {k: v for k, v in r.items() if k != 't'} == {k: v for k, v in out[-1].items() if k != 't'}:
            out[-1]['t'] += r['t']
        else:
            out.append(dict(r))
    return out


# ------------------------------------------------------------------------------------------------------------ tables
def parse_spec(spec):
    spec = re.sub(r'>\{[^}]*(?:\{[^}]*\})*[^}]*\}', '', spec)  # drop >{\raggedright\arraybackslash}
    cols, i = [], 0
    while i < len(spec):
        c = spec[i]
        if c in 'lrc':
            cols.append({'a': c, 'w': None}); i += 1
        elif c == 'p':
            g, j = find_group(spec, i + 1)
            cm = float(re.match(r'[\d.]+', g).group(0))
            cols.append({'a': 'l', 'w': cm}); i = j
        else:
            i += 1
    return cols


def parse_tabular(text):
    m = re.search(r'\\begin\{tabular\}', text)
    i = m.end()
    spec, i = find_group(text, i)
    end = text.index('\\end{tabular}', i)
    body = text[i:end]
    cols = parse_spec(spec)
    rows = [r for r in split_top(body, '\\\\')]
    grid, header_rows, seen_mid, started = [], 0, False, False
    pending_v = {}   # column -> remaining rows of a \multirow
    for raw in rows:
        # rules at the start of the row text
        mid = '\\midrule' in raw
        raw = re.sub(r'\\(toprule|midrule|bottomrule|hline)', '', raw)
        raw = re.sub(r'\\cmidrule(\([lr]+\))?\{[^}]*\}', '', raw)
        raw = re.sub(r'\\addlinespace(\[[^\]]*\])?', '', raw).strip()
        if mid and not seen_mid and started:
            seen_mid = True
            header_rows = len(grid)
        if not raw:
            continue
        started = True
        cells, col = [], 0
        for cell in split_top(raw, '&'):
            cell = cell.strip()
            span, vspan, vcont = 1, 1, False
            mm = re.match(r'\\multicolumn\{(\d+)\}\{[^}]*\}', cell)
            if mm:
                span = int(mm.group(1))
                g, _ = find_group(cell, mm.end())
                cell = g.strip()
            mr = re.match(r'\\multirow\{(\d+)\}\{\*\}', cell)
            if mr:
                vspan = int(mr.group(1))
                g, _ = find_group(cell, mr.end())
                cell = g.strip()
                pending_v[col] = vspan - 1
            elif col in pending_v and pending_v[col] > 0 and cell == '':
                vcont = True
                pending_v[col] -= 1
            cells.append({'runs': parse_inline(cell), 'span': span, 'vspan': vspan, 'vcont': vcont, 'col': col})
            col += span
        grid.append(cells)
    if not seen_mid:
        header_rows = 1
    return {'cols': cols, 'rows': grid, 'header_rows': header_rows}


def parse_float(env, body, name_hint=None):
    cap = None
    m = re.search(r'\\caption\{', body)
    if m:
        cap, _ = find_group(body, m.end() - 1)
    lab = re.search(r'\\label\{([^}]*)\}', body)
    return (parse_inline(cap) if cap is not None else [], lab.group(1) if lab else None)


# ---------------------------------------------------------------------------------------------------------- blocks
TOP = re.compile(
    r'\\begin\{(figure\*?|table\*?|itemize|enumerate|quote|abstract)\}(.*?)\\end\{\1\}'
    r'|\\input\{([^}]*)\}'
    r'|\\(section|subsection|paragraph)\{((?:[^{}]|\{[^{}]*\})*)\}'
    r'|\\label\{([^}]*)\}'
    r'|\\makeatletter.*?\\makeatother'
    r'|\\renewcommand\{[^}]*\}\{[^}]*\}', re.S)


def read(path):
    return open(path, encoding='utf8').read()


def figure_from_tikz(name):
    src = preprocess(read(os.path.join(PAPER, 'figures', name + '.tex')))
    cap, lab = parse_float('figure*', src)
    return ('figure', {'img': os.path.join(ASSETS, f'fig_{name}.png'), 'caption': cap, 'label': lab, 'wide': True})


def parse_blocks(src):
    src = preprocess(src)
    blocks, pos = [], 0

    def paras(text):
        for ptxt in re.split(r'\n\s*\n', text):
            ptxt = ptxt.strip()
            if ptxt:
                blocks.append(('p', parse_inline(ptxt)))

    for m in TOP.finditer(src):
        paras(src[pos:m.start()])
        pos = m.end()
        env, body, inp, cmd, title, lab = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
        if env in ('figure', 'figure*'):
            g = re.search(r'\\includegraphics(\[[^\]]*\])?\{([^}]*)\}', body)
            cap, label = parse_float(env, body)
            img = os.path.join(ASSETS, os.path.basename(g.group(2)) + '.png')
            blocks.append(('figure', {'img': img, 'caption': cap, 'label': label, 'wide': env == 'figure*'}))
        elif env in ('table', 'table*'):
            cap, label = parse_float(env, body)
            t = parse_tabular(body)
            t.update({'caption': cap, 'label': label, 'wide': env == 'table*'})
            blocks.append(('table', t))
        elif env in ('itemize', 'enumerate'):
            items = [parse_inline(x.strip()) for x in re.split(r'\\item\b', body)[1:]]
            blocks.append(('list', items))
        elif env == 'quote':
            body = body.replace('\\small', '').replace('\\ttfamily', '')
            lines = [parse_inline(x.strip(), {'mono': True}) for x in split_top(body, '\\\\') if x.strip()]
            blocks.append(('quote', lines))
        elif env == 'abstract':
            blocks.append(('abstract', parse_inline(' '.join(body.split()))))
        elif inp is not None:
            if inp.startswith('generated/'):
                f = os.path.join(PAPER, inp + '.tex')
                blocks.extend(parse_blocks(read(f)))
            elif inp.startswith('figures/'):
                blocks.append(figure_from_tikz(inp.split('/')[1]))
            else:
                blocks.extend(parse_blocks(read(os.path.join(PAPER, inp + '.tex'))))
        elif cmd:
            if cmd == 'section':
                blocks.append(('h1', parse_inline(title), None))
            elif cmd == 'subsection':
                blocks.append(('h2', parse_inline(title), None))
            else:
                blocks.append(('h3', parse_inline(title)))
        elif lab is not None:
            if blocks and blocks[-1][0] in ('h1', 'h2'):
                blocks[-1] = blocks[-1][:2] + (lab,)
    paras(src[pos:])
    return blocks


def load_file(rel):
    return parse_blocks(read(os.path.join(PAPER, rel)))


def reorder_floats(blocks):
    """Floats follow the first text paragraph after their source position and never cross a heading,
    which mimics where LaTeX would put them and keeps tables next to the text that discusses them."""
    out, pending = [], []
    for b in blocks:
        if b[0] in ('table', 'figure'):
            pending.append(b)
        elif b[0] in ('h1', 'h2', 'h3'):
            out.extend(pending); pending = []
            out.append(b)
        else:
            out.append(b)
            if b[0] in ('p', 'list'):
                out.extend(pending); pending = []
    out.extend(pending)
    return out


def runs_text(runs):
    return ''.join(r.get('t', '') for r in runs)
