'use strict';
// Usage: node analyze.js <tag> <detector> [policy=flag|reject] [maxPerClass=3]
const fs = require('fs');
const [tag, det, pol = 'flag', maxN = '3'] = process.argv.slice(2);
const res = JSON.parse(fs.readFileSync(`results/e1_${tag}.json`, 'utf8'));
const idx = pol === 'reject' ? 0 : 1;
const missed = {}, fps = {};
res.records.forEach((r) => {
  const hit = r.d[det][idx] === 1;
  if (r.label === 'fault' && !hit) (missed[r.cls] = missed[r.cls] || []).push(r);
  if (r.label === 'clean' && hit) (fps[r.cls] = fps[r.cls] || []).push(r);
});
console.log(`== MISSED faults (${det}, ${pol}) ==`);
Object.keys(missed).sort().forEach((c) => { console.log(`${c}: ${missed[c].length}`); missed[c].slice(0, +maxN).forEach((r) => console.log('    ', r.wb, r.f)); });
console.log(`\n== FALSE POSITIVES (${det}, ${pol}) ==`);
Object.keys(fps).sort().forEach((c) => { console.log(`${c}: ${fps[c].length}`); fps[c].slice(0, +maxN).forEach((r) => console.log('    ', r.wb, r.f)); });
