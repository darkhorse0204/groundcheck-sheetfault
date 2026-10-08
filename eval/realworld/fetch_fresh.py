"""Stream the Sheetpedia release archive and keep xlsx files from the part AFTER the first SKIP_MB megabytes
(the development and held-out sets of the paper came from the first 500 MB), so the confirmation set is disjoint.

    python fetch_fresh.py <out_dir> [keep=2500] [skip_mb=540]

The archive is a gzip stream, so the first SKIP_MB are downloaded and discarded; nothing is stored for them.
"""
import sys, os, tarfile, urllib.request, time

URL = 'https://huggingface.co/datasets/tianzl66/Sheetpedia_xlsx/resolve/main/pii_processed_xlsx_0929.tar.gz'
out = sys.argv[1]
KEEP = int(sys.argv[2]) if len(sys.argv) > 2 else 2500
SKIP = (int(sys.argv[3]) if len(sys.argv) > 3 else 540) * 1_000_000
MAX_BYTES = 600_000
os.makedirs(out, exist_ok=True)


class Counting:
    def __init__(self, f):
        self.f, self.n = f, 0

    def read(self, k=-1):
        b = self.f.read(k)
        self.n += len(b)
        return b


req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
resp = urllib.request.urlopen(req, timeout=120)
raw = Counting(resp)
tf = tarfile.open(fileobj=raw, mode='r|gz')
kept = seen = 0
t0 = time.time()
for m in tf:
    seen += 1
    if raw.n < SKIP:
        if seen % 500 == 0:
            print(f'skipping: {raw.n / 1e6:.0f} MB read, {seen} members, {time.time() - t0:.0f}s', flush=True)
        continue
    if not (m.isfile() and m.name.lower().endswith('.xlsx')) or m.size > MAX_BYTES:
        continue
    data = tf.extractfile(m).read()
    with open(os.path.join(out, os.path.basename(m.name)), 'wb') as g:
        g.write(data)
    kept += 1
    if kept % 100 == 0:
        print(f'kept {kept} files at {raw.n / 1e6:.0f} MB, {time.time() - t0:.0f}s', flush=True)
    if kept >= KEEP:
        break
print(f'done: kept {kept} files, archive position about {raw.n / 1e6:.0f} MB, {time.time() - t0:.0f}s')
