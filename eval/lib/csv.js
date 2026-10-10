'use strict';
// Minimal CSV reader/writer (RFC 4180 quoting) so the annotation tooling needs no dependency.

function parse(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** Rows -> array of objects keyed by the header row. */
function parseObjects(text) {
  const rows = parse(text.replace(/^﻿/, ''));
  const head = rows.shift() || [];
  return rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

function stringify(rows) {
  const esc = (x) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parse, parseObjects, stringify };
