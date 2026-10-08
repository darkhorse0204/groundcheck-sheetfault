/**
 * FormulaParser.js — Google Sheets formula tokenizer + parser
 *
 * Turns a formula string into an AST so Verification.js can reason about
 * function calls, argument positions and typed references instead of
 * pattern-matching raw text. Pure functions only: no SpreadsheetApp, no
 * network, no state — everything here is unit-testable with plain strings.
 *
 * AST node shapes (every node has `t` and `pos`, the source offset):
 *   { t: 'num',   v: Number }
 *   { t: 'str',   v: String }                      (quotes removed, "" unescaped)
 *   { t: 'bool',  v: Boolean }
 *   { t: 'err',   v: String }                      error literal such as #N/A
 *   { t: 'name',  v: String }                      bare identifier: a named range, or a hallucination
 *   { t: 'ref',   sheet: String|null, kind: 'cell'|'range'|'col'|'row',
 *                 a: String, b: String|null, c1, r1, c2, r2 }   (1-based; null = open-ended)
 *   { t: 'call',  name: 'SUMIF', rawName: 'sumif', args: [node|{t:'empty'}] }
 *   { t: 'bin',   op: String, l: node, r: node }
 *   { t: 'un',    op: '-'|'+', e: node }
 *   { t: 'pct',   e: node }
 *   { t: 'array', rows: [[node]] }
 *
 * parseFormulaAst_ never throws; failures come back as { ok: false, error, pos }.
 */

var FORMULA_TOKEN_PATTERNS_ = [
  ['str',    /^"(?:[^"]|"")*"/],
  ['qname',  /^'(?:[^']|'')+'(?=!)/],
  ['err',    /^#(?:N\/A|REF!|NAME\?|VALUE!|DIV\/0!|NUM!|NULL!|ERROR!)/i],
  ['num',    /^\$?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/],
  ['cell',   /^\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_.(])/],
  ['colref', /^\$?[A-Za-z]{1,3}(?=:\$?[A-Za-z]{1,3}(?![A-Za-z0-9_.(]))/],
  ['ident',  /^\$?[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/],
  ['op',     /^(?:<>|<=|>=|=|<|>|\+|-|\*|\/|\^|&|%|:|!|,|;|\(|\)|\{|\})/]
];

function colLettersToNumber_(letters) {
  var n = 0;
  var up = letters.replace(/\$/g, '').toUpperCase();
  for (var i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n;
}

function splitCellRef_(cell) {
  var m = String(cell).replace(/\$/g, '').match(/^([A-Za-z]+)(\d+)$/);
  return m ? { col: colLettersToNumber_(m[1]), row: parseInt(m[2], 10) } : null;
}

/** Splits a formula (without validating it) into tokens. Returns { tokens } or { error, pos }. */
function tokenizeFormula_(src) {
  var tokens = [];
  var i = 0;
  while (i < src.length) {
    var ch = src.charAt(i);
    if (/\s/.test(ch)) { i++; continue; }
    var rest = src.slice(i);
    var matched = false;
    for (var p = 0; p < FORMULA_TOKEN_PATTERNS_.length; p++) {
      var m = rest.match(FORMULA_TOKEN_PATTERNS_[p][1]);
      if (m) {
        tokens.push({ type: FORMULA_TOKEN_PATTERNS_[p][0], text: m[0], pos: i });
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return { error: 'Unexpected character "' + ch + '" at position ' + i + '.', pos: i };
    }
  }
  return { tokens: tokens };
}

function FormulaParseError_(message, pos) {
  this.message = message;
  this.pos = pos;
}

/** Parses a formula string (leading "=" optional) into an AST. */
function parseFormulaAst_(formula) {
  var src = String(formula);
  var offset = 0;
  if (src.charAt(0) === '=') { src = src.slice(1); offset = 1; }

  var lexed = tokenizeFormula_(src);
  if (lexed.error) return { ok: false, error: lexed.error, pos: lexed.pos + offset };
  var tokens = lexed.tokens;
  var idx = 0;

  function peek(k) { return tokens[idx + (k || 0)]; }
  function next() { return tokens[idx++]; }
  function isOp(tok, text) { return tok && tok.type === 'op' && tok.text === text; }
  function fail(message, tok) { throw new FormulaParseError_(message, (tok ? tok.pos : src.length) + offset); }
  function expectOp(text) {
    var t = next();
    if (!isOp(t, text)) fail('Expected "' + text + '"' + (t ? ' but found "' + t.text + '"' : ' but the formula ended') + '.', t);
    return t;
  }

  function parseExpr() { return parseComparison(); }

  function parseComparison() {
    var left = parseConcat();
    while (peek() && peek().type === 'op' && /^(=|<>|<=|>=|<|>)$/.test(peek().text)) {
      var op = next();
      left = { t: 'bin', op: op.text, l: left, r: parseConcat(), pos: op.pos + offset };
    }
    return left;
  }

  function parseConcat() {
    var left = parseAdditive();
    while (isOp(peek(), '&')) {
      var op = next();
      left = { t: 'bin', op: '&', l: left, r: parseAdditive(), pos: op.pos + offset };
    }
    return left;
  }

  function parseAdditive() {
    var left = parseMultiplicative();
    while (peek() && peek().type === 'op' && /^[+-]$/.test(peek().text)) {
      var op = next();
      left = { t: 'bin', op: op.text, l: left, r: parseMultiplicative(), pos: op.pos + offset };
    }
    return left;
  }

  function parseMultiplicative() {
    var left = parsePower();
    while (peek() && peek().type === 'op' && /^[*\/]$/.test(peek().text)) {
      var op = next();
      left = { t: 'bin', op: op.text, l: left, r: parsePower(), pos: op.pos + offset };
    }
    return left;
  }

  function parsePower() {
    var left = parseUnary();
    while (isOp(peek(), '^')) {
      var op = next();
      left = { t: 'bin', op: '^', l: left, r: parseUnary(), pos: op.pos + offset };
    }
    return left;
  }

  function parseUnary() {
    var t = peek();
    if (t && t.type === 'op' && (t.text === '-' || t.text === '+')) {
      next();
      return { t: 'un', op: t.text, e: parseUnary(), pos: t.pos + offset };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    var node = parsePrimary();
    while (isOp(peek(), '%') || isOp(peek(), ':')) {
      var t = next();
      if (t.text === '%') node = { t: 'pct', e: node, pos: t.pos + offset };
      else node = { t: 'bin', op: ':', l: node, r: parsePrimary(), pos: t.pos + offset }; // e.g. A1:INDEX(B:B,5)
    }
    return node;
  }

  function makeRef(sheet, a, b, kind, pos) {
    var ref = { t: 'ref', sheet: sheet, kind: kind, a: a, b: b, c1: null, r1: null, c2: null, r2: null, pos: pos + offset };
    if (kind === 'cell' || kind === 'range') {
      var s1 = splitCellRef_(a), s2 = b ? splitCellRef_(b) : s1;
      ref.c1 = Math.min(s1.col, s2.col); ref.c2 = Math.max(s1.col, s2.col);
      ref.r1 = Math.min(s1.row, s2.row); ref.r2 = Math.max(s1.row, s2.row);
    } else if (kind === 'col') {
      var c1 = colLettersToNumber_(a), c2 = colLettersToNumber_(b);
      ref.c1 = Math.min(c1, c2); ref.c2 = Math.max(c1, c2);
    } else if (kind === 'row') {
      var r1 = parseInt(String(a).replace('$', ''), 10), r2 = parseInt(String(b).replace('$', ''), 10);
      ref.r1 = Math.min(r1, r2); ref.r2 = Math.max(r1, r2);
    }
    return ref;
  }

  // Parses the part of a reference after an optional "Sheet!" prefix.
  function parseRefTail(sheet, startTok) {
    var t = next();
    if (!t) fail('Expected a cell reference after "!".', startTok);
    if (t.type === 'cell') {
      if (isOp(peek(), ':') && peek(1) && peek(1).type === 'cell') {
        next();
        var end = next();
        return makeRef(sheet, t.text.replace(/\$/g, ''), end.text.replace(/\$/g, ''), 'range', startTok.pos);
      }
      // open-ended range such as F2:F (runs to the bottom of the sheet)
      if (isOp(peek(), ':') && peek(1) && (peek(1).type === 'ident' || peek(1).type === 'colref') && /^\$?[A-Za-z]{1,3}$/.test(peek(1).text)) {
        next();
        var openEnd = next();
        var openRef = makeRef(sheet, t.text.replace(/\$/g, ''), null, 'range', startTok.pos);
        openRef.b = openEnd.text.replace(/\$/g, '');
        openRef.c2 = Math.max(openRef.c1, colLettersToNumber_(openEnd.text));
        openRef.c1 = Math.min(openRef.c1, colLettersToNumber_(openEnd.text));
        openRef.r2 = null;
        return openRef;
      }
      return makeRef(sheet, t.text.replace(/\$/g, ''), null, 'cell', startTok.pos);
    }
    if (t.type === 'colref') {
      expectOp(':');
      var e = next();
      if (!e || (e.type !== 'ident' && e.type !== 'colref') || !/^\$?[A-Za-z]{1,3}$/.test(e.text)) fail('Invalid column range.', e || t);
      return makeRef(sheet, t.text.replace(/\$/g, ''), e.text.replace(/\$/g, ''), 'col', startTok.pos);
    }
    if (t.type === 'num' && isOp(peek(), ':') && peek(1) && peek(1).type === 'num') {
      next();
      var e2 = next();
      return makeRef(sheet, t.text, e2.text, 'row', startTok.pos);
    }
    if (t.type === 'ident') return { t: 'name', v: t.text, sheet: sheet, pos: t.pos + offset };
    fail('Invalid reference after "!".', t);
  }

  function parseCall(nameTok) {
    expectOp('(');
    var args = [];
    if (isOp(peek(), ')')) { next(); return finishCall(nameTok, args); }
    while (true) {
      var t = peek();
      if (isOp(t, ',') || isOp(t, ';')) { args.push({ t: 'empty', pos: t.pos + offset }); next(); continue; }
      if (isOp(t, ')')) { args.push({ t: 'empty', pos: t.pos + offset }); next(); break; }
      args.push(parseExpr());
      var sep = next();
      if (isOp(sep, ',') || isOp(sep, ';')) {
        if (isOp(peek(), ')')) { args.push({ t: 'empty', pos: sep.pos + offset }); next(); break; }
        continue;
      }
      if (isOp(sep, ')')) break;
      fail('Expected "," or ")" in call to ' + nameTok.text.toUpperCase() + '.', sep);
    }
    return finishCall(nameTok, args);
  }

  function finishCall(nameTok, args) {
    return { t: 'call', name: nameTok.text.toUpperCase(), rawName: nameTok.text, args: args, pos: nameTok.pos + offset };
  }

  function parseArray() {
    var rows = [[]];
    while (true) {
      rows[rows.length - 1].push(parseExpr());
      var t = next();
      if (isOp(t, ',')) continue;
      if (isOp(t, ';')) { rows.push([]); continue; }
      if (isOp(t, '}')) break;
      fail('Expected "," ";" or "}" in array literal.', t);
    }
    return { t: 'array', rows: rows, pos: 0 };
  }

  function parsePrimary() {
    var t = next();
    if (!t) fail('The formula ended unexpectedly.', null);

    if (t.type === 'num') {
      if (isOp(peek(), ':') && peek(1) && peek(1).type === 'num') {
        next(); var e = next();
        return makeRef(null, t.text, e.text, 'row', t.pos);
      }
      return { t: 'num', v: parseFloat(t.text.replace('$', '')), pos: t.pos + offset };
    }
    if (t.type === 'err') return { t: 'err', v: t.text.toUpperCase(), pos: t.pos + offset };
    if (t.type === 'str') return { t: 'str', v: t.text.slice(1, -1).replace(/""/g, '"'), pos: t.pos + offset };

    if (t.type === 'qname') {
      expectOp('!');
      return parseRefTail(t.text.slice(1, -1).replace(/''/g, "'"), t);
    }
    if (t.type === 'cell') {
      idx--; return parseRefTail(null, t);
    }
    if (t.type === 'colref') {
      idx--; return parseRefTail(null, t);
    }
    if (t.type === 'ident') {
      if (isOp(peek(), '(')) return parseCall(t);
      if (isOp(peek(), '!')) { next(); return parseRefTail(t.text, t); }
      var up = t.text.toUpperCase();
      if (up === 'TRUE' || up === 'FALSE') return { t: 'bool', v: up === 'TRUE', pos: t.pos + offset };
      return { t: 'name', v: t.text, sheet: null, pos: t.pos + offset };
    }
    if (isOp(t, '(')) {
      var inner = parseExpr();
      expectOp(')');
      return inner;
    }
    if (isOp(t, '{')) {
      var arr = parseArray();
      arr.pos = t.pos + offset;
      return arr;
    }
    fail('Unexpected "' + t.text + '".', t);
  }

  try {
    if (tokens.length === 0) return { ok: false, error: 'The formula is empty.', pos: offset };
    var ast = parseExpr();
    if (idx < tokens.length) fail('Unexpected "' + tokens[idx].text + '" after the end of the expression.', tokens[idx]);
    return { ok: true, ast: ast };
  } catch (e) {
    if (e instanceof FormulaParseError_) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: 'Could not parse formula: ' + e.message, pos: 0 };
  }
}

/** Depth-first walk; fn(node, parent) is called for every node. */
function walkFormulaAst_(node, fn, parent) {
  if (!node) return;
  fn(node, parent || null);
  if (node.t === 'call') node.args.forEach(function (a) { walkFormulaAst_(a, fn, node); });
  else if (node.t === 'bin') { walkFormulaAst_(node.l, fn, node); walkFormulaAst_(node.r, fn, node); }
  else if (node.t === 'un' || node.t === 'pct') walkFormulaAst_(node.e, fn, node);
  else if (node.t === 'array') node.rows.forEach(function (row) { row.forEach(function (c) { walkFormulaAst_(c, fn, node); }); });
}

/** All reference nodes in the formula, in source order. */
function collectAstRefs_(ast) {
  var refs = [];
  walkFormulaAst_(ast, function (n) { if (n.t === 'ref') refs.push(n); });
  return refs;
}

/** Levenshtein distance, early-exiting above `limit`. */
function editDistance_(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  var prev = [], cur = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    cur[0] = i;
    var rowMin = cur[0];
    for (j = 1; j <= b.length; j++) {
      var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}
