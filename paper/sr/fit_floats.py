"""Word has no float placement, so a figure or table that does not fit at the bottom of a page jumps to the next one and
leaves a gap. This script asks Word where every float lands and moves floats that left a gap behind them past one more
paragraph, until the gaps close. The result is stored in float_delays.json, which build_docx.py applies.

    python fit_floats.py [max_iterations]
"""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
DELAYS = os.path.join(HERE, 'float_delays.json')
PROBE = os.path.join(HERE, 'probe.json')
BODY_BOTTOM = 742.0
GAP = 80.0          # a gap taller than this (points) is worth closing
MAX_DELAY = 4       # a float should stay near the text that introduces it


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        raise SystemExit('command failed: ' + ' '.join(cmd))
    return r.stdout


def probe(pdf):
    run([sys.executable, os.path.join(HERE, 'build_docx.py')])
    args = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(HERE, 'render_probe.ps1')]
    if not pdf:
        args.append('-NoPdf')
    run(args)
    return json.load(open(PROBE, encoding='utf-8-sig'))


def problems(data):
    out = []
    for f in data['floats']:
        top_of_page = f['page'] > f['ppage'] and f['y'] < 90
        gap = BODY_BOTTOM - (f['py'] + 11) if f['ppage'] == f['page'] - 1 else 0
        if top_of_page and gap > GAP:
            out.append((f['name'], round(gap), f['page']))
    return out


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    delays = json.load(open(DELAYS)) if os.path.exists(DELAYS) else {}
    for it in range(1, limit + 1):
        t0 = time.time()
        data = probe(pdf=False)
        bad = problems(data)
        print(f'iteration {it}: {data["pages"]} pages, {len(bad)} gaps {bad}  ({time.time() - t0:.0f}s)', flush=True)
        if not bad:
            break
        # move the earliest offender; any later offender at least three pages further on is independent of it
        first_page = bad[0][2]
        moved = False
        for name, gap, page in bad:
            if page - first_page >= 3 or name == bad[0][0]:
                label = name[len('_fl_'):]
                key = next((k for k in all_labels() if re.sub(r'\W', '_', k) == label), None)
                if key is None:
                    print('  cannot map', name)
                    continue
                if delays.get(key, 0) < MAX_DELAY:
                    delays[key] = delays.get(key, 0) + 1
                    moved = True
                if page - first_page < 3:
                    first_page = page
        json.dump(delays, open(DELAYS, 'w'), indent=1)
        if not moved:
            print('no further moves possible')
            break
    print('delays:', delays)


def all_labels():
    sys.path.insert(0, HERE)
    import build_docx
    return [b[1]['label'] for b in build_docx.assemble() if b[0] in ('table', 'figure', 'algorithm') and b[1].get('label')]


if __name__ == '__main__':
    main()
