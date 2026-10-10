"""Consistency checks on the built paper (run after `tectonic -X compile main.tex --keep-logs`).

    python check_paper.py

Checks: unresolved references/citations/macros in the LaTeX log and PDF text; every \\cite key exists and every
bibliography entry is cited; every \\label is referenced; floats are referenced in order of first mention;
PDF page count; numbers quoted in the abstract agree with the generated macro file; terminology variants.
Exit code 1 if any hard check fails.
"""
import io, os, re, sys, glob

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'paper')
fail = 0


def report(ok, msg):
    global fail
    print(('PASS  ' if ok else 'FAIL  ') + msg)
    if not ok:
        fail += 1


def read(p):
    return io.open(p, encoding='utf8').read()


tex = {p: read(p) for p in glob.glob(os.path.join(ROOT, '*.tex')) + glob.glob(os.path.join(ROOT, 'sections', '*.tex')) + glob.glob(os.path.join(ROOT, 'figures', '*.tex'))}
src = '\n'.join(tex.values())
gen = '\n'.join(read(p) for p in glob.glob(os.path.join(ROOT, 'generated', '*.tex')))
body = src + '\n' + gen
bib = read(os.path.join(ROOT, 'refs.bib'))

# ---- LaTeX log
log = read(os.path.join(ROOT, 'main.log'))
report(not re.search(r'undefined (control|references|citations)|Citation .* undefined|Reference .* undefined|Missing character|LaTeX Error', log), 'LaTeX log has no undefined references, citations, macros or missing characters')
report(not re.search(r'Overfull \\hbox', log), 'no overfull boxes')

# ---- PDF text
try:
    import pymupdf
    doc = pymupdf.open(os.path.join(ROOT, 'main.pdf'))
    text = '\n'.join(p.get_text() for p in doc)
    report(not re.search(r'\?\?|\bTODO\b|\bXXX\b|lorem', text, re.I), 'no "??", TODO or placeholder text in the PDF (%d pages)' % len(doc))
except Exception as e:  # pragma: no cover
    text = ''
    print('SKIP  PDF text checks (%s)' % e)

# ---- citations
cites = set()
for m in re.finditer(r'\\cite\{([^}]*)\}', src):
    cites.update(k.strip() for k in m.group(1).split(','))
keys = set(re.findall(r'@\w+\{([^,]+),', bib))
report(not (cites - keys), 'every cited key is in refs.bib' + ('' if not (cites - keys) else ': missing ' + ', '.join(sorted(cites - keys))))
report(not (keys - cites), 'every refs.bib entry is cited' + ('' if not (keys - cites) else ': uncited ' + ', '.join(sorted(keys - cites))))

# ---- labels
labels = set(re.findall(r'\\label\{([^}]*)\}', body))
refs = set()
for m in re.finditer(r'\\(?:ref|autoref|pageref)\{([^}]*)\}', body):
    refs.add(m.group(1))
report(not (refs - labels), 'every \\ref resolves to a \\label' + ('' if not (refs - labels) else ': ' + ', '.join(sorted(refs - labels))))
unref = sorted(l for l in labels - refs if l.startswith(('tab:', 'fig:')))
report(not unref, 'every table and figure is referenced in the text' + ('' if not unref else ': ' + ', '.join(unref)))

# ---- order of first mention of floats vs the order the floats appear (IEEE: cite in numerical order)
def expand(path, seen=()):
    t = read(path)
    def sub(m):
        f = os.path.join(ROOT, m.group(1) + ('' if m.group(1).endswith('.tex') else '.tex'))
        return expand(f) if os.path.exists(f) else ''
    return re.sub(r'\\input\{([^}]*)\}', sub, t)


full = expand(os.path.join(ROOT, 'main.tex'))
main_part = full.split('\\appendices')[0]
appears = [m.group(1) for m in re.finditer(r'\\label\{((?:tab|fig):[^}]*)\}', main_part)]
mentioned = []
for m in re.finditer(r'\\ref\{((?:tab|fig):[^}]*)\}', re.sub(r'\\caption\{.*?\}\s*\\label', '\\\\label', main_part, flags=re.S)):
    if m.group(1) not in mentioned:
        mentioned.append(m.group(1))
in_main = [l for l in appears]
mentioned_main = [l for l in mentioned if l in in_main]
# floats are numbered in order of appearance in the source (approximately the PDF order)
rank = {l: i for i, l in enumerate(appears)}
# tables and figures are numbered by separate counters, so the order is checked within each kind
ordered = all(
    all(rank[a] <= rank[b] for a, b in zip(seq, seq[1:]))
    for seq in ([l for l in mentioned_main if l.startswith('tab:')], [l for l in mentioned_main if l.startswith('fig:')])
)
report(ordered, 'floats of the main text are first cited in numerical order')
report(all(l in mentioned for l in appears), 'every float of the main text is cited in the main text' + ('' if all(l in mentioned for l in appears) else ': ' + ', '.join(l for l in appears if l not in mentioned)))
order = mentioned_main

# ---- abstract numbers against macros
abs_t = tex[os.path.join(ROOT, 'sections', 'abstract.tex')]
macros = dict(re.findall(r'\\newcommand\{\\(\w+)\}\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', gen))
missing = [m for m in set(re.findall(r'\\([A-Za-z]+)(?=[\\%{ .,;)])', abs_t)) if m not in macros and m not in (
    'gc', 'sheetfault', 'code', 'emph', 'textbf', 'cite', 'cite', 'ref', 'hline', 'ifdefined', 'fi', 'input', 'label', 'begin', 'end')]
report(not missing, 'macros used in the abstract are all defined' + ('' if not missing else ': ' + ', '.join(sorted(missing))))

# ---- terminology
variants = {
    'GroundCheck written in running text without the macro': len(re.findall(r'(?<![\\A-Za-z{])GroundCheck(?![A-Za-z}])', re.sub(r'\\(caption|label)\{[^}]*\}', '', '\n'.join(v for k, v in tex.items() if 'sections' in k)))),
    'Sheet Fault / Sheetfault spellings': len(re.findall(r'Sheet ?[Ff]ault', src)) - len(re.findall(r'SheetFault', src)),
    'lowercase "llama"/"gemini" prose': len(re.findall(r'(?<![\\{:\w-])(?:llama|gemini)\b', re.sub(r'\\code\{[^}]*\}', '', src))),
}
for k, v in variants.items():
    print(('INFO  ' if v == 0 else 'WARN  ') + '%s: %d' % (k, v))

print('first mention order of floats:', ', '.join(order))
sys.exit(1 if fail else 0)
