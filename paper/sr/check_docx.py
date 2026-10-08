"""Independent checks on the finished Word and PDF files (they read the files, not the build script's data).

    python check_docx.py
"""
import os, re, sys, collections
import docx
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
DOCX = os.path.join(HERE, 'Verify_before_you_write_Jerath_Jagadeesan.docx')
PDF = os.path.join(HERE, 'Verify_before_you_write_Jerath_Jagadeesan.pdf')
ok = True


def report(passed, msg, detail=''):
    global ok
    ok = ok and passed
    print(('PASS  ' if passed else 'FAIL  ') + msg + (('  -> ' + detail) if detail and not passed else ''))


d = docx.Document(DOCX)
paras = [p.text for p in d.paragraphs]
cells = [c.text for t in d.tables for r in t.rows for c in r.cells]
alltext = '\n'.join(paras + cells)

# 1. leftovers of the LaTeX conversion
# a dollar sign is legitimate inside a cell reference such as $1:$1 or B$2, not as a leftover math delimiter
bad = [m.group(0) for m in re.finditer(r'\\[A-Za-z]+|\?\?|TODO|\{|\}|\$(?![\d])|~', alltext)]
report(not bad, 'no LaTeX commands, braces, "??", TODO or tildes left in the text', str(collections.Counter(bad).most_common(8)))

# 2. author order and front matter
first_page = pymupdf.open(PDF)[0].get_text()
i, j = first_page.find('Ansh Jerath'), first_page.find('Jagadeesan S')
report(0 <= i < j, 'Ansh Jerath is listed before Jagadeesan S (page 1 of the PDF)')
report(paras.index(next(p for p in paras if p.startswith('Ansh Jerath'))) < 6, 'author line is in the front matter of the Word file')
report('Ansh Jerath' in [p for p in paras if 'Jagadeesan' in p][0].split('Jagadeesan')[0], 'author line of the Word file starts with Ansh Jerath')
report('superjoin' not in alltext.lower() + first_page.lower(), 'the name "superjoin" does not appear')

# 3. figure and table numbering: captions run 1..N in order, in the main text and in the supplement
seq = collections.defaultdict(list)
for p in paras:
    # a caption is "Fig. 3." / "Table 2." / "Algorithm 1:" followed by text; a sentence such as "Table 1 compares ..." is not one
    m = re.match(r'(Supplementary Fig\.|Supplementary Table|Fig\.|Table|Algorithm) (S?\d+)[.:]\s', p)
    if m:
        seq[m.group(1)].append(m.group(2))
for kind, nums in seq.items():
    expect = [('S' if kind.startswith('Supp') else '') + str(n) for n in range(1, len(nums) + 1)]
    report(nums == expect, f'{kind} captions run in order ({len(nums)})', str(nums))

# 3b. numbers follow the order of first mention (main text, and separately inside the supplement)
def first_mentions(texts):
    order = collections.defaultdict(list)
    for p in texts:
        if re.match(r'(Supplementary Fig\.|Supplementary Table|Fig\.|Table|Algorithm) (S?\d+)[.:]\s', p):
            continue   # a caption is not a mention
        for m in re.finditer(r'(Supplementary Fig\.|Supplementary Table|Figure|Fig\.|Table|Algorithm) (S?\d+)', p):
            kind = {'Figure': 'Fig.'}.get(m.group(1), m.group(1))
            if m.group(2) not in order[kind]:
                order[kind].append(m.group(2))
    return order


split = next(i for i, p in enumerate(paras) if p.strip() == 'Supplementary information')
main_order = first_mentions(paras[:split])
for kind in ('Fig.', 'Table', 'Algorithm'):
    nums = [int(x) for x in main_order[kind]]
    report(nums == sorted(nums), f'{kind} in the main text are first mentioned in numerical order', str(nums))
supp_order = first_mentions(paras[split:])
for kind in ('Supplementary Fig.', 'Supplementary Table'):
    nums = [int(x[1:]) for x in supp_order[kind]]
    report(nums == sorted(nums), f'{kind} in the supplement are first mentioned in numerical order', str(nums))

# 4. every in-text reference points to a caption that exists
have = {k: set(v) for k, v in seq.items()}
missing = []
for m in re.finditer(r'(Supplementary Fig\.|Supplementary Table|Figure|Fig\.|Table|Algorithm) (S?\d+)', alltext):
    kind = {'Figure': 'Fig.'}.get(m.group(1), m.group(1))
    if m.group(2) not in have.get(kind, set()):
        missing.append(m.group(0))
report(not missing, 'every Fig./Table/Algorithm reference has a caption', str(sorted(set(missing))))

# 5. citations: numbers in the text appear in increasing order of first use and all have an entry in the list
refs = {}
for p in paras:
    m = re.match(r'^(\d+)\.\t', p)
    if m:
        refs[int(m.group(1))] = p
report(sorted(refs) == list(range(1, len(refs) + 1)), f'reference list is numbered 1..{len(refs)}')
cite_nums = []
for p in d.paragraphs:
    for r in p.runs:
        rpr = r._r.rPr
        if rpr is None or rpr.find('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}position') is None:
            continue
        if r.font.color is not None and r.font.color.rgb is not None and str(r.font.color.rgb) == '0000FF' and re.fullmatch(r'[\d,–]+', r.text):
            for part in r.text.split(','):
                a = part.split('–')
                cite_nums += list(range(int(a[0]), int(a[-1]) + 1))
first_use = []
for n in cite_nums:
    if n not in first_use:
        first_use.append(n)
report(first_use == sorted(first_use) and set(first_use) == set(refs), 'citations first appear in numerical order and cover the whole list',
       f'{first_use[:40]} vs {len(refs)}')
# the table that is cited from inside a table cell counts as text; check it separately
report(max(cite_nums) == len(refs), 'highest citation number equals the length of the reference list')

# 6. the document body
pdf = pymupdf.open(PDF)
txt = '\n'.join(pg.get_text() for pg in pdf)
report('??' not in txt, 'no "??" in the PDF')
report(len(pdf) >= 20, f'PDF has {len(pdf)} pages')
for sec in ('Related work', 'Threats to validity', 'Research gap', 'Methodology', 'Proposed system', 'Implementation', 'Results and analysis',
            'Discussion', 'Conclusion', 'Data availability', 'References', 'Author contributions', 'Funding', 'Declarations',
            'Competing interests', 'Additional information', 'Supplementary information'):
    report(any(p.strip() == sec for p in paras), f'section "{sec}" present')
report(sum(1 for p in paras if re.match(r'Supplementary Note \d\.', p)) == 6, 'six supplementary notes')

# 7. PDF layout: nothing outside the page, fonts embedded, text block inside the margins
fonts = collections.Counter()
outside = 0
for pg in pdf:
    for b in pg.get_text('dict')['blocks']:
        if b['type'] == 0:
            for l in b['lines']:
                for s in l['spans']:
                    fonts[s['font']] += len(s['text'])
                    if s['bbox'][2] > pg.rect.width + 0.5 or s['bbox'][0] < -0.5:
                        outside += 1
report(outside == 0, 'no text runs outside the page')
print('fonts in the PDF:', dict(fonts.most_common(8)))
print('RESULT:', 'all checks passed' if ok else 'some checks FAILED')
sys.exit(0 if ok else 1)
