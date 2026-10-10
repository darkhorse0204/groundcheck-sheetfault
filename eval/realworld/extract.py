"""
Extract a real-world formula corpus from Sheetpedia workbooks (CC BY-SA 4.0,
Tian et al., NeurIPS 2025 D&B). Writes one JSON file (not committed) holding,
per sampled workbook: sheet grids (formula cells kept as '=...' text) and a
sample of formula cells with the cached result Excel stored for each.

Cached values are NOT available in this release (they were stripped), so there
is no label here: formulas are adjudicated afterwards (HyperFormula + manual).
"""
import sys, os, json, random, re, glob
import openpyxl
from openpyxl.worksheet.formula import ArrayFormula

SRC, OUT = sys.argv[1], sys.argv[2]
MAX_WB = int(sys.argv[3]) if len(sys.argv) > 3 else 400
MAX_PER_WB = 25
MAX_ROWS, MAX_COLS = 1500, 60
ERR = re.compile(r'^#(REF!|NAME\?|VALUE!|DIV/0!|N/A|NUM!|NULL!)$')

random.seed(2025)
files = sorted(glob.glob(os.path.join(SRC, '*.xlsx')))
random.shuffle(files)

def norm(f):
    return re.sub(r'_xl(fn|ws)\.', '', f)

def a1(r, c):
    s = ''
    while c > 0:
        c, rem = divmod(c - 1, 26)
        s = chr(65 + rem) + s
    return f'{s}{r}'

out, stats = [], {'files_tried': 0, 'skipped_big': 0, 'skipped_nocache': 0, 'skipped_err': 0, 'excluded_structured_or_external': 0, 'formulas': 0}
for path in files:
    if len(out) >= MAX_WB:
        break
    if os.path.getsize(path) > 600_000:
        continue
    stats['files_tried'] += 1
    try:
        wf = openpyxl.load_workbook(path, data_only=False)
        wv = None
    except Exception:
        stats['skipped_err'] += 1
        continue
    if any(ws.max_row > MAX_ROWS or ws.max_column > MAX_COLS for ws in wf.worksheets) or len(wf.worksheets) > 12:
        stats['skipped_big'] += 1
        continue
    names = []
    def add_names(dn_dict):
        for nm, dn in dn_dict.items():
            try:
                dests = list(dn.destinations)
            except Exception:
                dests = []
            if dests:
                sh, ref = dests[0]
                names.append({'name': nm, 'sheet': sh, 'a1': ref.replace('$', '')})
            else:
                names.append({'name': nm, 'sheet': None, 'a1': 'A1'})
    try:
        add_names(wf.defined_names)
        for w in wf.worksheets:
            add_names(w.defined_names)
    except Exception:
        pass
    sheets, cells = {}, []
    cached_any = False
    for ws in wf.worksheets:
        grid = []
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=ws.max_column):
            g = []
            for cell in row:
                v = cell.value
                if isinstance(v, ArrayFormula):
                    v = v.text if v.text else ''
                    if isinstance(v, str) and not v.startswith('='):
                        v = '=' + v
                if (cell.data_type == 'f') and isinstance(v, str) and v.startswith('='):
                    f = norm(v)
                    cv = None
                    cached_any = True
                    if '[' in f:
                        stats['excluded_structured_or_external'] += 1
                        g.append('')
                        continue
                    g.append(f)
                    cells.append({'sheet': ws.title, 'cell': cell.coordinate, 'formula': f,
                                  'cached': (str(cv) if isinstance(cv, str) else (None if cv is None else 'VALUE')),
                                  'error': (cv if isinstance(cv, str) and ERR.match(cv) else None)})
                elif v is None:
                    g.append('')
                elif isinstance(v, (int, float, bool)):
                    g.append(v)
                else:
                    g.append(str(v))
            grid.append(g)
        sheets[ws.title] = grid
    if not cached_any or not cells:
        stats['skipped_nocache'] += 1
        continue
    # sample: keep every error-valued formula (up to cap) plus a random sample of the rest
    random.shuffle(cells)
    chosen = cells[:MAX_PER_WB]
    stats['formulas'] += len(chosen)
    out.append({'file': os.path.basename(path), 'sheets': sheets, 'sheetOrder': [w.title for w in wf.worksheets], 'namedRanges': names, 'formulas': chosen})

stats['workbooks'] = len(out)
json.dump({'stats': stats, 'workbooks': out}, open(OUT, 'w'))
print(json.dumps(stats))
