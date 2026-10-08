"""Second stage of float placement. fit_floats.py moves one float at a time and can get stuck; this script takes the
floats that still leave a gap and tries every delay from -3 to +6 paragraphs for each of them, keeping the delay after
which Word reports the smallest total gap.

    python fit_search.py label [label ...]        (labels as in LaTeX, e.g. fig:e1-classes)
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fit_floats as F


def score(data):
    bad = F.problems(data)
    return sum(g - F.GAP for _, g, _ in bad), len(bad), data['pages']


def main():
    delays = json.load(open(F.DELAYS)) if os.path.exists(F.DELAYS) else {}
    for label in sys.argv[1:]:
        results = []
        for d in range(-3, 7):
            delays[label] = d
            json.dump(delays, open(F.DELAYS, 'w'), indent=1)
            s = score(F.probe(pdf=False))
            results.append((s, abs(d), d))
            print(f'  {label} delay {d:+d}: excess gap {s[0]}, {s[1]} gaps, {s[2]} pages', flush=True)
        best = min(results)
        delays[label] = best[2]
        json.dump(delays, open(F.DELAYS, 'w'), indent=1)
        print(f'{label}: best delay {best[2]:+d} (excess gap {best[0][0]}, {best[0][1]} gaps)', flush=True)
    s = score(F.probe(pdf=False))
    print('final:', s, F.problems(F.probe(pdf=False)))
    print('delays:', delays)


if __name__ == '__main__':
    main()
