'use strict';
/**
 * E4 — SSRF filter evaluation.
 *
 *   node e4_ssrf.js [--tag main]
 *
 * A hand-built corpus of URLs that MUST be blocked (addresses that reach
 * loopback, private ranges, link-local/cloud-metadata, in every encoding a
 * resolver accepts) and URLs that MUST be allowed (public hosts, including
 * boundary addresses next to the private ranges and benign URLs that merely
 * contain suspicious substrings). Run against the shipped filter (commit
 * 44a3f4f) and the current one.
 *
 * Out of scope for a static filter, and therefore NOT in the corpus: hostnames
 * that resolve to private addresses via attacker-controlled DNS (DNS rebinding).
 */
const fs = require('fs');
const path = require('path');
const { loadWorkbook, readBaseline } = require('./lib/gas');
const { generateWorkbook } = require('./lib/workbookGen');
const { wilson } = require('./lib/stats');

const BLOCK = {
  'loopback (dotted)': ['http://127.0.0.1/', 'https://127.0.0.1:8443/admin', 'http://127.1/', 'http://127.0.1/', 'http://127.255.255.254/', 'http://127.000.000.001/'],
  'loopback (decimal/hex/octal)': ['http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://0x7f.1/', 'http://0177.1/', 'http://127.0x0.0.1/'],
  'loopback (IPv6)': ['http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::127.0.0.1]/', 'http://[0000:0000:0000:0000:0000:0000:0000:0001]:80/', 'http://[::]/'],
  'unspecified': ['http://0.0.0.0/', 'http://0/', 'http://0.0.0.0:8080/', 'http://[::ffff:0.0.0.0]/'],
  'localhost names': ['http://localhost/', 'http://LOCALHOST:3000/', 'http://localhost./', 'http://foo.localhost/', 'http://a.b.localhost:8080/x'],
  'private v4 (dotted)': ['http://10.0.0.1/', 'http://10.255.255.254/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://192.168.0.1:8080/', 'http://172.20.10.5/'],
  'private v4 (encoded)': ['http://167772161/', 'http://3232235777/', 'http://0xc0a80101/', 'http://012.0.0.1/', 'http://0xa.0.0.1/', 'http://0300.0250.0.1/', 'http://2886729729/'],
  'link-local / metadata': ['http://169.254.169.254/latest/meta-data/', 'http://169.254.169.254.:80/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://0251.0376.0251.0376/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://metadata.google.internal./', 'http://metadata/', 'http://100.100.100.200/latest/meta-data/', 'http://[fe80::a9fe:a9fe%25eth0]/'],
  'IPv6-mapped / translated private': ['http://[::ffff:10.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[64:ff9b::7f00:1]/', 'http://[::ffff:192.168.1.1]/', 'http://[::ffff:c0a8:101]/', 'http://[2002:7f00:1::]/'],
  'userinfo / authority tricks': ['http://evil.com@127.0.0.1/', 'http://user:pass@localhost/', 'http://127.0.0.1#@example.com/', 'http://example.com@169.254.169.254/', 'http://127.0.0.1:80@example.com@10.0.0.1/', 'https://good.example.com\\@127.0.0.1/'],
  'wildcard-DNS names for private IPs': ['http://127.0.0.1.nip.io/', 'http://169.254.169.254.nip.io/', 'http://10.0.0.1.sslip.io/', 'http://localtest.me/', 'http://foo.localtest.me/', 'http://lvh.me/'],
  'internal-only names': ['http://router.local/', 'http://db.internal/', 'http://printer.localdomain/', 'http://intranet/', 'http://wiki/', 'http://nas.home.arpa/'],
  'non-http schemes': ['file:///etc/passwd', 'ftp://127.0.0.1/', 'gopher://127.0.0.1:6379/_INFO', 'javascript:alert(1)', 'data:text/plain,hi', 'dict://127.0.0.1:11211/stats'],
  'unicode / formatting': ['http://１２７.０.０.１/', 'http://①②⑦.0.0.1/', 'http://127。0。0。1/', 'http://127.0.0.1%09/', ' http://127.0.0.1/', 'http://127.0.0.1\t/']
};

const ALLOW = {
  'public hosts': ['https://api.github.com/users/octocat', 'https://jsonplaceholder.typicode.com/users', 'https://restcountries.com/v3.1/all?fields=name', 'https://api.coindesk.com/v1/bpi/currentprice.json', 'https://example.com:8443/path?q=1', 'https://open-meteo.com/en/docs', 'https://hooks.zapier.com/hooks/catch/123/abc/', 'http://example.org/'],
  'public IPs': ['https://8.8.8.8/', 'https://1.1.1.1/dns-query', 'https://[2001:4860:4860::8888]/', 'https://93.184.216.34/', 'https://[2606:4700:4700::1111]/'],
  'boundary addresses (just outside private ranges)': ['https://172.32.0.1/', 'https://172.15.255.255/', 'https://11.0.0.1/', 'https://9.255.255.255/', 'https://192.169.0.1/', 'https://192.167.255.255/', 'https://169.253.255.255/', 'https://169.255.0.1/', 'https://100.63.255.255/', 'https://100.128.0.1/', 'https://128.0.0.1/', 'https://126.255.255.255/'],
  'public IPs whose digits contain private-looking substrings': ['https://210.1.2.3/', 'https://110.10.10.10/', 'https://18.127.0.0/', 'https://5.172.16.8/', 'https://192.168.1.1.example.com/', 'https://1.1.1.10/', 'https://3.10.0.0/'],
  'benign URLs containing suspicious substrings': ['https://example.com/?next=http://localhost:3000', 'https://example.com/redirect?u=127.0.0.1', 'https://my-localhost-guide.org/', 'https://example.com/docs/10.0.0.1-setup', 'https://example.com/foo.internal', 'https://example.com/api/v1.10.2.3/items', 'https://blog.example.com/how-to-use-localhost', 'https://example.com/169.254.169.254', 'https://local.example.com/', 'https://docs.internal.example.com/', 'https://localhost-news.com/', 'https://www.local.gov.uk/'],
  'IDN / unusual but public': ['https://xn--bcher-kva.example/', 'https://münchen.de/', 'https://example.com./', 'https://EXAMPLE.COM/Path']
};

function build() {
  const rows = [];
  Object.keys(BLOCK).forEach((cat) => BLOCK[cat].forEach((u) => rows.push({ url: u, cat, want: 'block' })));
  Object.keys(ALLOW).forEach((cat) => ALLOW[cat].forEach((u) => rows.push({ url: u, cat, want: 'allow' })));
  return rows;
}

function runDetector(src) {
  const env = loadWorkbook(generateWorkbook('sales', 1), { sourceOverrides: src ? { 'Verification.js': src } : undefined });
  env.sandbox.console = { log() {}, warn() {}, error() {}, info() {} };
  return (url) => { try { env.sandbox.validateUrl_(url); return false; } catch (e) { return true; } }; // true = blocked
}

function main() {
  const rows = build();
  const detectors = { v1: runDetector(readBaseline('Verification.v1.js')), v2: runDetector(null) };
  const summary = { corpus: { block: rows.filter((r) => r.want === 'block').length, allow: rows.filter((r) => r.want === 'allow').length }, perCategory: {}, overall: {}, errors: { v1: [], v2: [] } };

  Object.keys(detectors).forEach((d) => {
    let blockTp = 0, blockN = 0, allowFp = 0, allowN = 0;
    summary.perCategory[d] = {};
    rows.forEach((r) => {
      const blocked = detectors[d](r.url);
      const c = summary.perCategory[d][r.cat] = summary.perCategory[d][r.cat] || { want: r.want, n: 0, correct: 0 };
      c.n++;
      const ok = r.want === 'block' ? blocked : !blocked;
      if (ok) c.correct++; else summary.errors[d].push({ url: r.url, cat: r.cat, want: r.want });
      if (r.want === 'block') { blockN++; if (blocked) blockTp++; } else { allowN++; if (blocked) allowFp++; }
    });
    summary.overall[d] = { blockRecall: wilson(blockTp, blockN), falseBlockRate: wilson(allowFp, allowN), bypasses: blockN - blockTp, falseBlocks: allowFp };
  });

  fs.writeFileSync(path.join(__dirname, 'results', 'e4_ssrf.json'), JSON.stringify(summary, null, 1));
  console.log(`corpus: ${summary.corpus.block} must-block, ${summary.corpus.allow} must-allow`);
  ['v1', 'v2'].forEach((d) => {
    const o = summary.overall[d];
    console.log(`${d}: block recall ${(100 * o.blockRecall.p).toFixed(1)}% [${(100 * o.blockRecall.lo).toFixed(1)}, ${(100 * o.blockRecall.hi).toFixed(1)}]  (${o.bypasses} bypasses)   false-block ${(100 * o.falseBlockRate.p).toFixed(1)}% (${o.falseBlocks} of ${summary.corpus.allow})`);
  });
  console.log('\nper category (correct/n):');
  Object.keys(summary.perCategory.v1).forEach((c) => {
    const a = summary.perCategory.v1[c], b = summary.perCategory.v2[c];
    console.log(c.padEnd(52), a.want.padEnd(6), `${a.correct}/${a.n}`.padStart(6), `${b.correct}/${b.n}`.padStart(6));
  });
  if (summary.errors.v2.length) { console.log('\nv2 errors:'); summary.errors.v2.forEach((e) => console.log('  ', e.want, e.url)); }
}

main();
