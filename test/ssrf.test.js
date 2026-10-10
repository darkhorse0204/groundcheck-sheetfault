'use strict';
/**
 * SSRF validation: hosts are parsed and classified, not substring-matched, and
 * redirects are followed manually with every hop re-validated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGasEnvironment } = require('./support/gasEnvironment');

function env(extra) {
  const e = createGasEnvironment(Object.assign({ sheetData: [['A'], [1]] }, extra || {}));
  e.sandbox.console = { log() {}, warn() {}, error() {} };
  return e;
}
const blocked = (e, url) => { try { e.sandbox.validateUrl_(url); return false; } catch (err) { return /SECURITY_ERROR/.test(err.message); } };

test('blocks loopback, private and metadata addresses in every encoding a resolver accepts', () => {
  const e = env();
  [
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://017700000001/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:0:0:1]/',
    'http://10.0.0.1/', 'http://172.16.5.4/', 'http://192.168.1.1/', 'http://3232235777/',
    'http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/',
    'http://localhost/', 'http://LOCALHOST./', 'http://foo.localhost/', 'http://metadata.google.internal/', 'http://metadata/',
    'http://127.0.0.1.nip.io/', 'http://localtest.me/', 'http://router.local/',
    'http://evil.com@127.0.0.1/', 'http://user:pw@example.com/', 'http://１２７.０.０.１/', 'http://127。0。0。1/',
    'https://good.example.com\\@127.0.0.1/', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/', 'http://0/'
  ].forEach((u) => assert.ok(blocked(e, u), 'should block ' + u));
});

test('allows public hosts, including addresses just outside the private ranges and URLs that only mention private addresses', () => {
  const e = env();
  [
    'https://api.github.com/users/octocat', 'https://8.8.8.8/', 'https://[2001:4860:4860::8888]/',
    'https://172.32.0.1/', 'https://172.15.255.255/', 'https://100.63.255.255/', 'https://169.253.255.255/', 'https://11.0.0.1/', 'https://128.0.0.1/',
    'https://210.1.2.3/', 'https://192.168.1.1.example.com/',
    'https://example.com/?next=http://localhost:3000', 'https://my-localhost-guide.org/', 'https://example.com/docs/10.0.0.1-setup',
    'https://docs.internal.example.com/', 'https://www.local.gov.uk/', 'https://example.com./'
  ].forEach((u) => assert.ok(!blocked(e, u), 'should allow ' + u));
});

test('fetch_api never auto-follows redirects and re-validates every hop', () => {
  const calls = [];
  const e = env({
    urlFetchStub: (url, options) => {
      calls.push({ url, followRedirects: options.followRedirects });
      if (url === 'https://public.example.com/start') {
        return { getResponseCode: () => 302, getContentText: () => '', getAllHeaders: () => ({ Location: 'http://169.254.169.254/latest/meta-data/' }) };
      }
      return { getResponseCode: () => 200, getContentText: () => '[]', getAllHeaders: () => ({ 'Content-Type': 'application/json' }) };
    }
  });
  const r = e.sandbox.executeTool_('fetch_api', { url: 'https://public.example.com/start' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Redirect blocked/);
  assert.equal(calls.length, 1, 'the internal address was never requested');
  assert.equal(calls[0].followRedirects, false);
});

test('fetch_api follows a redirect to another public URL', () => {
  const urls = [];
  const e = env({
    urlFetchStub: (url) => {
      urls.push(url);
      if (url === 'https://a.example.com/x') return { getResponseCode: () => 301, getContentText: () => '', getAllHeaders: () => ({ location: '/y' }) };
      return { getResponseCode: () => 200, getContentText: () => '[{"id":1}]', getAllHeaders: () => ({ 'Content-Type': 'application/json' }) };
    }
  });
  const r = e.sandbox.executeTool_('fetch_api', { url: 'https://a.example.com/x' });
  assert.equal(r.ok, true);
  assert.deepEqual(urls, ['https://a.example.com/x', 'https://a.example.com/y']);
  assert.equal(r.result.rowCount, 1);
});

test('absolutizeUrl_ resolves relative, protocol-relative and absolute Location values', () => {
  const e = env();
  const abs = e.sandbox.absolutizeUrl_;
  assert.equal(abs('/p?q=1', 'https://h.example.com/a/b'), 'https://h.example.com/p?q=1');
  assert.equal(abs('//other.example.com/z', 'https://h.example.com/a'), 'https://other.example.com/z');
  assert.equal(abs('http://x.example.com/', 'https://h.example.com/a'), 'http://x.example.com/');
});
