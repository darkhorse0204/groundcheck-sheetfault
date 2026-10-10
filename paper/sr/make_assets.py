"""Figure assets for the Word version of the paper.

  * the three TikZ diagrams are compiled stand-alone with Tectonic (same macros as the LaTeX paper) and rasterised;
  * the matplotlib figures (vector PDFs in ../figures) are rasterised at 400 dpi.

Run:  python make_assets.py <path-to-tectonic.exe>
Output: assets/*.png
"""
import os, re, subprocess, sys, io
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
PAPER = os.path.abspath(os.path.join(HERE, '..'))
OUT = os.path.join(HERE, 'assets')
TEC = sys.argv[1] if len(sys.argv) > 1 else 'tectonic'
os.makedirs(OUT, exist_ok=True)

PREAMBLE = r'''\documentclass[border=4pt]{standalone}
\usepackage[T1]{fontenc}
\usepackage{times}
\hyphenpenalty=10000 \exhyphenpenalty=10000
\usepackage{amsmath}
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{positioning,arrows.meta,shapes.geometric,fit,calc}
\input{%s}
\newcommand{\gc}{\textsc{GroundCheck}}
\newcommand{\sheetfault}{\textsc{SheetFault}}
\newcommand{\code}[1]{\texttt{#1}}
\begin{document}
%s
\end{document}
'''

def raster(pdf, png, dpi=400):
    d = pymupdf.open(pdf)
    d[0].get_pixmap(dpi=dpi, alpha=False).save(png)
    return d[0].rect


for name in ('arch', 'anatomy', 'bench'):
    src = open(os.path.join(PAPER, 'figures', name + '.tex'), encoding='utf8').read()
    m = re.search(r'\\begin\{tikzpicture\}.*\\end\{tikzpicture\}', src, re.S)
    assert m, name
    numbers = os.path.join(PAPER, 'generated', 'numbers').replace('\\', '/')
    tex = PREAMBLE % (numbers, m.group(0))
    tex_path = os.path.join(OUT, f'tikz_{name}.tex')
    open(tex_path, 'w', encoding='utf8').write(tex)
    r = subprocess.run([TEC, '-X', 'compile', f'tikz_{name}.tex'], cwd=OUT, capture_output=True, text=True)
    pdf = os.path.join(OUT, f'tikz_{name}.pdf')
    if not os.path.exists(pdf):
        print(r.stdout[-1500:], r.stderr[-1500:])
        raise SystemExit('tikz compile failed: ' + name)
    rect = raster(pdf, os.path.join(OUT, f'fig_{name}.png'))
    print(name, 'tikz ->', round(rect.width), 'x', round(rect.height), 'pt')

for f in sorted(os.listdir(os.path.join(PAPER, 'figures'))):
    if f.endswith('.pdf'):
        rect = raster(os.path.join(PAPER, 'figures', f), os.path.join(OUT, f.replace('.pdf', '.png')))
        print(f, round(rect.width), 'x', round(rect.height), 'pt')
