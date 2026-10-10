/**
 * Verification.js — Output Validation Layer
 *
 * The safety net between "LLM generated something" and "we inject it into the user's sheet."
 * Catches structural errors (unbalanced parens, missing =, unknown functions) and blocks
 * SSRF attacks on the fetch/push pipelines.
 *
 * Important: this only catches STRUCTURAL issues, not semantic ones. We can verify
 * "is the parentheses balanced?" but NOT "does this formula actually do what the user wanted?"
 * Semantic verification would require executing the formula, which is a v3 problem.
 */

// ============================================
// URL SECURITY — SSRF Protection
// ============================================
//
// The LLM (or a prompt-injected sheet cell) can name any URL. Before any fetch or
// POST the URL is PARSED and its host CLASSIFIED — never pattern-matched against
// the raw string, which both misses encodings (decimal 2130706433, hex
// 0x7f000001, octal 0177.0.0.1, 127.1, IPv6-mapped ::ffff:7f00:1) and blocks
// harmless URLs that merely contain "localhost" or "10.0.0.1" in a path.
//
//   1. only http/https; no credentials, spaces or control characters
//   2. the host is canonicalised (NFKC, IDNA dots, lowercase, trailing dot)
//   3. an IPv4 host in ANY inet_aton form (1-4 parts; decimal/octal/hex) or an IPv6
//      host (incl. IPv4-mapped, NAT64, 6to4) is checked against the reserved ranges
//   4. a name host is rejected if it is a single label, ends in an internal-only
//      suffix, or belongs to a wildcard-DNS service that maps names to IPs
//
// Not covered, because a static check cannot see it: a public-looking name whose
// DNS record points at a private address (DNS rebinding). UrlFetchApp requests
// leave from Google's network, not the user's, which limits (not removes) that risk.
// fetch_api also refuses to auto-follow redirects: each hop is re-validated.

// [network, prefix length] for blocked IPv4 ranges.
var BLOCKED_IPV4_RANGES_ = [
  [0x00000000, 8],    // "this" network / unspecified
  [0x0A000000, 8],    // 10.0.0.0/8       RFC 1918
  [0x64400000, 10],   // 100.64.0.0/10    carrier-grade NAT (incl. 100.100.100.200 cloud metadata)
  [0x7F000000, 8],    // 127.0.0.0/8      loopback
  [0xA9FE0000, 16],   // 169.254.0.0/16   link-local, cloud metadata
  [0xAC100000, 12],   // 172.16.0.0/12    RFC 1918
  [0xC0000000, 24],   // 192.0.0.0/24     IETF protocol assignments
  [0xC0A80000, 16],   // 192.168.0.0/16   RFC 1918
  [0xC6120000, 15],   // 198.18.0.0/15    benchmarking
  [0xE0000000, 4],    // 224.0.0.0/4      multicast
  [0xF0000000, 4]     // 240.0.0.0/4      reserved + broadcast
];

var BLOCKED_HOST_SUFFIXES_ = [
  '.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa',
  // wildcard-DNS services that resolve <anything>.<ip>.<domain> to <ip>
  '.nip.io', '.sslip.io', '.xip.io', '.localtest.me', '.lvh.me', '.traefik.me', '.1u.ms'
];
var BLOCKED_HOST_EXACT_ = { 'localhost': 1, 'localtest.me': 1, 'lvh.me': 1, 'nip.io': 1, 'sslip.io': 1 };

function ipv4InBlockedRange_(n) {
  for (var i = 0; i < BLOCKED_IPV4_RANGES_.length; i++) {
    var net = BLOCKED_IPV4_RANGES_[i][0], bits = BLOCKED_IPV4_RANGES_[i][1];
    var mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if (((n >>> 0) & mask) >>> 0 === net) return true;
  }
  return false;
}

/** inet_aton-style parse: returns the 32-bit address, or null if `host` is not a numeric IPv4 form. */
function parseIpv4Loose_(host) {
  var parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  var nums = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i], v;
    if (/^0x[0-9a-f]*$/i.test(p)) v = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) v = parseInt(p, 8) || 0;
    else if (/^[1-9][0-9]*$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (isNaN(v)) return null;
    nums.push(v);
  }
  var last = nums.pop();
  var maxLast = Math.pow(256, 4 - nums.length) - 1;
  for (var j = 0; j < nums.length; j++) if (nums[j] > 255) return null;
  if (last > maxLast) return null;
  var addr = last;
  for (var k = 0; k < nums.length; k++) addr += nums[k] * Math.pow(256, 3 - k);
  return addr >>> 0;
}

/** Parses an IPv6 literal (no brackets) into 8 16-bit groups, or null. */
function parseIpv6_(text) {
  if (text.indexOf('%') !== -1) return null; // zone ids are not allowed in URLs we accept
  var m = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    var tail4 = parseIpv4Loose_(m[2]);
    if (tail4 === null) return null;
    text = m[1] + ((tail4 >>> 16) & 0xFFFF).toString(16) + ':' + (tail4 & 0xFFFF).toString(16);
  }
  var halves = text.split('::');
  if (halves.length > 2) return null;
  function groups(str) { return str === '' ? [] : str.split(':'); }
  var head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  var all = head.concat(tail);
  for (var i = 0; i < all.length; i++) if (!/^[0-9a-f]{1,4}$/i.test(all[i])) return null;
  var out;
  if (halves.length === 2) {
    var fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    var zeros = [];
    for (var z = 0; z < fill; z++) zeros.push('0');
    out = head.concat(zeros, tail);
  } else {
    if (head.length !== 8) return null;
    out = head;
  }
  return out.map(function (g) { return parseInt(g, 16); });
}

function ipv6IsBlocked_(g) {
  function v4(hi, lo) { return ipv4InBlockedRange_(((hi << 16) | lo) >>> 0); }
  var zero = function (x) { return x === 0; };
  if (g.every(zero)) return true;                                                          // ::
  if (g.slice(0, 7).every(zero) && g[7] === 1) return true;                                // ::1
  if (g.slice(0, 5).every(zero) && (g[5] === 0xFFFF || g[5] === 0)) return v4(g[6], g[7]); // ::ffff:a.b.c.d and ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xFF9B && g.slice(2, 6).every(zero)) return v4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]);                                              // 6to4
  if ((g[0] & 0xFE00) === 0xFC00) return true;                                             // fc00::/7 unique-local (fd00:ec2::254 = AWS IMDS)
  if ((g[0] & 0xFFC0) === 0xFE80) return true;                                             // fe80::/10 link-local
  if ((g[0] & 0xFF00) === 0xFF00) return true;                                             // ff00::/8 multicast
  return false;
}

/** Splits a URL into { scheme, host, hasUserinfo } or null if it is not a plain absolute URL. */
function parseUrlHost_(url) {
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return null; // spaces, control chars, backslashes: URL parsers disagree on these (parser-differential risk)
  var m = url.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#\\]*)/);
  if (!m) return null;
  var authority = m[2];
  var at = authority.lastIndexOf('@');
  var hasUserinfo = at !== -1;
  if (hasUserinfo) authority = authority.slice(at + 1);
  var host;
  if (authority.charAt(0) === '[') {
    var close = authority.indexOf(']');
    if (close === -1) return null;
    host = authority.slice(0, close + 1);
    var after = authority.slice(close + 1);
    if (after !== '' && !/^:\d*$/.test(after)) return null;
  } else {
    var colon = authority.lastIndexOf(':');
    if (colon !== -1) {
      if (!/^\d*$/.test(authority.slice(colon + 1))) return null;
      host = authority.slice(0, colon);
    } else host = authority;
  }
  return { scheme: m[1].toLowerCase(), host: host, hasUserinfo: hasUserinfo };
}

function hostIsBlocked_(rawHost) {
  var host = rawHost.normalize('NFKC').replace(/[。．｡]/g, '.').toLowerCase();
  if (host.indexOf('%') !== -1) return 'percent-encoding in host';
  if (host.charAt(0) === '[') {
    var g = parseIpv6_(host.slice(1, -1));
    if (!g) return 'malformed IPv6 address';
    return ipv6IsBlocked_(g) ? 'IPv6 address in a private/loopback/link-local range' : null;
  }
  host = host.replace(/\.+$/, '');
  if (host === '') return 'empty host';
  var ip = parseIpv4Loose_(host);
  if (ip !== null) return ipv4InBlockedRange_(ip) ? 'IPv4 address in a private/loopback/link-local range' : null;
  if (BLOCKED_HOST_EXACT_[host]) return 'internal or wildcard-DNS hostname';
  if (host.indexOf('.') === -1) return 'single-label hostname';
  for (var i = 0; i < BLOCKED_HOST_SUFFIXES_.length; i++) {
    var suf = BLOCKED_HOST_SUFFIXES_[i];
    if (host.length > suf.length && host.slice(-suf.length) === suf) return 'internal or wildcard-DNS hostname';
  }
  return null;
}

// Run a URL through the validator before any fetch/POST. Called from
// ToolRegistry.js's fetch_api tool — the single path every agent's HTTP
// calls (GET or POST) go through under structured tool calling.
function validateUrl_(url) {
  if (!url || typeof url !== 'string') {
    throw createError_(ErrorType.SECURITY_ERROR, 'No URL provided.');
  }
  var parts = parseUrlHost_(url);
  if (!parts || (parts.scheme !== 'http' && parts.scheme !== 'https')) {
    throw createError_(ErrorType.SECURITY_ERROR, 'URL must be a plain http:// or https:// address.');
  }
  if (parts.hasUserinfo) {
    logWarn_('Security', 'Blocked URL with embedded credentials', { url: url });
    throw createError_(ErrorType.SECURITY_ERROR, 'Blocked: URLs with embedded credentials are not allowed.');
  }
  var reason = hostIsBlocked_(parts.host);
  if (reason) {
    logWarn_('Security', 'Blocked SSRF attempt', { url: url, reason: reason });
    throw createError_(ErrorType.SECURITY_ERROR, 'Blocked: URL points to a private or internal network address (' + reason + ').');
  }
  return url;
}

/** Resolves a redirect Location against the URL it came from. */
function absolutizeUrl_(location, base) {
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(location)) return location;
  var origin = String(base).match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\/?#]*/);
  if (!origin) return location;
  if (location.indexOf('//') === 0) return base.split(':')[0] + ':' + location;
  if (location.charAt(0) === '/') return origin[0] + location;
  return origin[0] + '/' + location;
}

// ============================================
// FORMULA VERIFICATION
// ============================================

// Known Google Sheets function names (520). Source: the official function list at
// support.google.com/docs/table/25273 (retrieved 2026-10-02, 513 functions) plus
// HOUR, XMATCH, TAKE, DROP, EXPAND, EFFECT, NUMBERVALUE, which exist in Sheets but are missing from that table.
// Unknown names are only a hard error when they are a near-miss of a real
// function (a typo like SUMIFF); otherwise they are a warning, because the
// user may have custom Apps Script functions.
var KNOWN_SHEET_FUNCTIONS_ = [
  'ABS', 'ACCRINT', 'ACCRINTM', 'ACOS', 'ACOSH', 'ACOT', 'ACOTH', 'ADD', 'ADDRESS', 'AI', 'AMORLINC', 'AND',
  'ARABIC', 'ARRAYFORMULA', 'ARRAY_CONSTRAIN', 'ASC', 'ASIN', 'ASINH', 'ATAN', 'ATAN2', 'ATANH', 'AVEDEV',
  'AVERAGE', 'AVERAGE.WEIGHTED', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS', 'BASE', 'BETA.DIST', 'BETA.INV',
  'BETADIST', 'BETAINV', 'BIN2DEC', 'BIN2HEX', 'BIN2OCT', 'BINOM.DIST', 'BINOM.INV', 'BINOMDIST', 'BITAND',
  'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'BYCOL', 'BYROW', 'CEILING', 'CEILING.MATH', 'CEILING.PRECISE',
  'CELL', 'CHAR', 'CHIDIST', 'CHIINV', 'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT',
  'CHISQ.TEST', 'CHITEST', 'CHOOSE', 'CHOOSECOLS', 'CHOOSEROWS', 'CLEAN', 'CODE', 'COLUMN', 'COLUMNS',
  'COMBIN', 'COMBINA', 'COMPLEX', 'CONCAT', 'CONCATENATE', 'CONFIDENCE', 'CONFIDENCE.NORM', 'CONFIDENCE.T',
  'CONVERT', 'CORREL', 'COS', 'COSH', 'COT', 'COTH', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS',
  'COUNTUNIQUE', 'COUPDAYBS', 'COUPDAYS', 'COUPDAYSNC', 'COUPNCD', 'COUPNUM', 'COUPPCD', 'COVAR',
  'COVARIANCE.P', 'COVARIANCE.S', 'CRITBINOM', 'CSC', 'CSCH', 'CUMIPMT', 'CUMPRINC', 'DATE', 'DATEDIF',
  'DATEVALUE', 'DAVERAGE', 'DAY', 'DAYS', 'DAYS360', 'DB', 'DCOUNT', 'DCOUNTA', 'DDB', 'DEC2BIN', 'DEC2HEX',
  'DEC2OCT', 'DECIMAL', 'DEGREES', 'DELTA', 'DETECTLANGUAGE', 'DEVSQ', 'DGET', 'DISC', 'DIVIDE', 'DMAX',
  'DMIN', 'DOLLAR', 'DOLLARDE', 'DOLLARFR', 'DPRODUCT', 'DROP', 'DSTDEV', 'DSTDEVP', 'DSUM', 'DURATION',
  'DVAR', 'DVARP', 'EDATE', 'EFFECT', 'ENCODEURL', 'EOMONTH', 'EPOCHTODATE', 'EQ', 'ERF', 'ERF.PRECISE',
  'ERFC', 'ERFC.PRECISE', 'ERROR.TYPE', 'EVEN', 'EXACT', 'EXP', 'EXPAND', 'EXPON.DIST', 'EXPONDIST', 'F.DIST',
  'F.DIST.RT', 'F.INV', 'F.INV.RT', 'F.TEST', 'FACT', 'FACTDOUBLE', 'FALSE', 'FDIST', 'FILTER', 'FIND',
  'FINDB', 'FINV', 'FISHER', 'FISHERINV', 'FIXED', 'FLATTEN', 'FLOOR', 'FLOOR.MATH', 'FLOOR.PRECISE',
  'FORECAST', 'FORECAST.LINEAR', 'FORMULATEXT', 'FREQUENCY', 'FTEST', 'FV', 'FVSCHEDULE', 'GAMMA',
  'GAMMA.DIST', 'GAMMA.INV', 'GAMMADIST', 'GAMMAINV', 'GAMMALN', 'GAMMALN.PRECISE', 'GAUSS', 'GCD', 'GEOMEAN',
  'GESTEP', 'GETPIVOTDATA', 'GOOGLEFINANCE', 'GOOGLETRANSLATE', 'GROWTH', 'GT', 'GTE', 'HARMEAN', 'HEX2BIN',
  'HEX2DEC', 'HEX2OCT', 'HLOOKUP', 'HOUR', 'HSTACK', 'HYPERLINK', 'HYPGEOM.DIST', 'HYPGEOMDIST', 'IF',
  'IFERROR', 'IFNA', 'IFS', 'IMABS', 'IMAGE', 'IMAGINARY', 'IMARGUMENT', 'IMCONJUGATE', 'IMCOS', 'IMCOSH',
  'IMCOT', 'IMCOTH', 'IMCSC', 'IMCSCH', 'IMDIV', 'IMEXP', 'IMLN', 'IMLOG', 'IMLOG10', 'IMLOG2', 'IMPORTDATA',
  'IMPORTFEED', 'IMPORTHTML', 'IMPORTRANGE', 'IMPORTXML', 'IMPOWER', 'IMPRODUCT', 'IMREAL', 'IMSEC', 'IMSECH',
  'IMSIN', 'IMSINH', 'IMSQRT', 'IMSUB', 'IMSUM', 'IMTAN', 'IMTANH', 'INDEX', 'INDIRECT', 'INT', 'INTERCEPT',
  'INTRATE', 'IPMT', 'IRR', 'ISBETWEEN', 'ISBLANK', 'ISDATE', 'ISEMAIL', 'ISERR', 'ISERROR', 'ISEVEN',
  'ISFORMULA', 'ISLOGICAL', 'ISNA', 'ISNONTEXT', 'ISNUMBER', 'ISO.CEILING', 'ISODD', 'ISOWEEKNUM', 'ISPMT',
  'ISREF', 'ISTEXT', 'ISURL', 'JOIN', 'KURT', 'LAMBDA', 'LARGE', 'LCM', 'LEFT', 'LEFTB', 'LEN', 'LENB', 'LET',
  'LINEST', 'LN', 'LOG', 'LOG10', 'LOGEST', 'LOGINV', 'LOGNORM.DIST', 'LOGNORM.INV', 'LOGNORMDIST', 'LOOKUP',
  'LOWER', 'LT', 'LTE', 'MAKEARRAY', 'MAP', 'MARGINOFERROR', 'MATCH', 'MAX', 'MAXA', 'MAXIFS', 'MDETERM',
  'MDURATION', 'MEDIAN', 'MID', 'MIDB', 'MIN', 'MINA', 'MINIFS', 'MINUS', 'MINUTE', 'MINVERSE', 'MIRR',
  'MMULT', 'MOD', 'MODE', 'MODE.MULT', 'MODE.SNGL', 'MONTH', 'MROUND', 'MULTINOMIAL', 'MULTIPLY', 'MUNIT',
  'N', 'NA', 'NE', 'NEGBINOM.DIST', 'NEGBINOMDIST', 'NETWORKDAYS', 'NETWORKDAYS.INTL', 'NOMINAL', 'NORM.DIST',
  'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'NORMDIST', 'NORMINV', 'NORMSDIST', 'NORMSINV', 'NOT', 'NOW',
  'NPER', 'NPV', 'NUMBERVALUE', 'OCT2BIN', 'OCT2DEC', 'OCT2HEX', 'ODD', 'OFFSET', 'OR', 'PDURATION',
  'PEARSON', 'PERCENTILE', 'PERCENTILE.EXC', 'PERCENTILE.INC', 'PERCENTRANK', 'PERCENTRANK.EXC',
  'PERCENTRANK.INC', 'PERMUT', 'PERMUTATIONA', 'PHI', 'PI', 'PMT', 'POISSON', 'POISSON.DIST', 'POW', 'POWER',
  'PPMT', 'PRICE', 'PRICEDISC', 'PRICEMAT', 'PROB', 'PRODUCT', 'PROPER', 'PV', 'QUARTILE', 'QUARTILE.EXC',
  'QUARTILE.INC', 'QUERY', 'QUOTIENT', 'RADIANS', 'RAND', 'RANDARRAY', 'RANDBETWEEN', 'RANK', 'RANK.AVG',
  'RANK.EQ', 'RATE', 'RECEIVED', 'REDUCE', 'REGEXEXTRACT', 'REGEXMATCH', 'REGEXREPLACE', 'REPLACE',
  'REPLACEB', 'REPT', 'RIGHT', 'RIGHTB', 'ROMAN', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'ROW', 'ROWS', 'RRI',
  'RSQ', 'SCAN', 'SEARCH', 'SEARCHB', 'SEC', 'SECH', 'SECOND', 'SEQUENCE', 'SERIESSUM', 'SHEET', 'SHEETS',
  'SIGN', 'SIN', 'SINH', 'SKEW', 'SKEW.P', 'SLN', 'SLOPE', 'SMALL', 'SORT', 'SORTN', 'SPARKLINE', 'SPLIT',
  'SQRT', 'SQRTPI', 'STANDARDIZE', 'STDEV', 'STDEV.P', 'STDEV.S', 'STDEVA', 'STDEVP', 'STDEVPA', 'STEYX',
  'SUBSTITUTE', 'SUBTOTAL', 'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ', 'SUMX2MY2', 'SUMX2PY2',
  'SUMXMY2', 'SWITCH', 'SYD', 'T', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV', 'T.INV.2T', 'T.TEST', 'TAKE',
  'TAN', 'TANH', 'TBILLEQ', 'TBILLPRICE', 'TBILLYIELD', 'TDIST', 'TEXT', 'TEXTJOIN', 'TIME', 'TIMEVALUE',
  'TINV', 'TOCOL', 'TODAY', 'TOROW', 'TO_DATE', 'TO_DOLLARS', 'TO_PERCENT', 'TO_PURE_NUMBER', 'TO_TEXT',
  'TRANSPOSE', 'TREND', 'TRIM', 'TRIMMEAN', 'TRUE', 'TRUNC', 'TTEST', 'TYPE', 'UMINUS', 'UNARY_PERCENT',
  'UNICHAR', 'UNICODE', 'UNIQUE', 'UPLUS', 'UPPER', 'VALUE', 'VAR', 'VAR.P', 'VAR.S', 'VARA', 'VARP', 'VARPA',
  'VDB', 'VLOOKUP', 'VSTACK', 'WEEKDAY', 'WEEKNUM', 'WEIBULL', 'WEIBULL.DIST', 'WORKDAY', 'WORKDAY.INTL',
  'WRAPCOLS', 'WRAPROWS', 'XIRR', 'XLOOKUP', 'XMATCH', 'XNPV', 'XOR', 'YEAR', 'YEARFRAC', 'YIELD',
  'YIELDDISC', 'YIELDMAT', 'Z.TEST', 'ZTEST'
];

var KNOWN_FUNCTION_SET_ = null;
function knownFunctionSet_() {
  if (!KNOWN_FUNCTION_SET_) {
    KNOWN_FUNCTION_SET_ = {};
    KNOWN_SHEET_FUNCTIONS_.forEach(function (f) { KNOWN_FUNCTION_SET_[f] = true; });
  }
  return KNOWN_FUNCTION_SET_;
}

// [minArgs, maxArgs] for functions whose arity is stable across Sheets.
// Out-of-range argument counts make Sheets return a parse error, so they are
// hard errors. Entries here are deliberately conservative: when unsure the
// function is left out rather than risk rejecting a valid formula.
var FUNCTION_ARITY_ = {
  SUM: [1, 255], AVERAGE: [1, 255], MAX: [1, 255], MIN: [1, 255], COUNT: [1, 255], COUNTA: [1, 255], MEDIAN: [1, 255],
  IF: [2, 3], IFS: [2, 254], IFERROR: [1, 2], IFNA: [2, 2], AND: [1, 255], OR: [1, 255], NOT: [1, 1],
  VLOOKUP: [3, 4], HLOOKUP: [3, 4], XLOOKUP: [3, 6], INDEX: [1, 3], MATCH: [2, 3],
  SUMIF: [2, 3], SUMIFS: [3, 255], COUNTIF: [2, 2], COUNTIFS: [2, 254], AVERAGEIF: [2, 3], AVERAGEIFS: [3, 255],
  MAXIFS: [3, 255], MINIFS: [3, 255], SUMPRODUCT: [1, 255],
  LARGE: [2, 2], SMALL: [2, 2], ROUND: [1, 2], ROUNDUP: [1, 2], ROUNDDOWN: [1, 2], ABS: [1, 1], MOD: [2, 2], POWER: [2, 2], SQRT: [1, 1],
  INT: [1, 1], LEN: [1, 1], LEFT: [1, 2], RIGHT: [1, 2], MID: [3, 3], TRIM: [1, 1], UPPER: [1, 1], LOWER: [1, 1], PROPER: [1, 1],
  CONCATENATE: [1, 255], TEXTJOIN: [3, 255], SUBSTITUTE: [3, 4], TEXT: [2, 2],
  DATE: [3, 3], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], TODAY: [0, 0], NOW: [0, 0], EDATE: [2, 2], EOMONTH: [2, 2],
  UNIQUE: [1, 3], FILTER: [2, 255], QUERY: [2, 3], ARRAYFORMULA: [1, 1], TRANSPOSE: [1, 1], COUNTUNIQUE: [1, 255],
  RANK: [2, 3], PERCENTILE: [2, 2], SPLIT: [2, 4], JOIN: [2, 255],
  ISBLANK: [1, 1], ISNUMBER: [1, 1], ISTEXT: [1, 1], ISERROR: [1, 1], ISNA: [1, 1],
  CHOOSE: [2, 255], SWITCH: [3, 255], REGEXMATCH: [2, 2], REGEXEXTRACT: [2, 2], REGEXREPLACE: [3, 3],
  ROWS: [1, 1], COLUMNS: [1, 1], VALUE: [1, 1], SEARCH: [2, 3], FIND: [2, 3], HYPERLINK: [1, 2],
  IMPORTRANGE: [2, 2], RAND: [0, 0], RANDBETWEEN: [2, 2], LN: [1, 1], EXP: [1, 1]
};

// Functions whose (criteria_range, criterion) pairs / value ranges the grounding
// layer inspects. pairsFrom = argument index of the first criteria_range;
// valueArg = index of the range being aggregated (-1 = none; 'pairs0' = the
// criteria range itself when the optional sum_range is omitted).
var CRITERIA_FUNCTIONS_ = {
  COUNTIF:    { pairsFrom: 0, valueArg: -1 },
  COUNTIFS:   { pairsFrom: 0, valueArg: -1 },
  SUMIF:      { pairsFrom: 0, pairsMax: 1, valueArg: 2 },
  AVERAGEIF:  { pairsFrom: 0, pairsMax: 1, valueArg: 2 },
  SUMIFS:     { pairsFrom: 1, valueArg: 0 },
  AVERAGEIFS: { pairsFrom: 1, valueArg: 0 },
  MAXIFS:     { pairsFrom: 1, valueArg: 0 },
  MINIFS:     { pairsFrom: 1, valueArg: 0 }
};

var NUMERIC_AGGREGATES_ = { SUM: 1, AVERAGE: 1, MAX: 1, MIN: 1, MEDIAN: 1, LARGE: 1, SMALL: 1, STDEV: 1, VAR: 1, SUMPRODUCT: 1 };

var VERIFY_SCAN_ROWS_ = 500; // rows of a column read for type / value grounding

/**
 * ═══════════════════════════════════════════════════════════════════════
 * VERIFICATION PIPELINE
 *
 * Every LLM formula passes through deterministic, workbook-grounded layers
 * before it is shown or written. Layers fire in order; hard errors block the
 * formula and drive the repair loop, warnings are shown to the user.
 *
 *  1. Structural   leading "=", balanced quotes, injection patterns, and a
 *                  real parse of the formula (see FormulaParser.js)
 *  2. Symbols      sheets that do not exist, bare identifiers that are neither
 *                  functions nor named ranges (a column header used as a
 *                  reference), near-miss function names, hallucinated QUERY
 *                  column letters
 *  3. Bounds       references that fall wholly outside the used range of the
 *                  sheet they point at (sheet-aware, unlike a single global
 *                  size check); partial overshoot is just headroom
 *  4. Shape        argument counts, VLOOKUP column indexes beyond the range,
 *                  mismatched range sizes in *IF(S)/SUMPRODUCT
 *  5. Grounding    numeric aggregates over text columns; criteria and lookup
 *                  keys that never occur in the column they search
 *                  (reported as "suspicious": plausible but probably wrong)
 *  6. Circularity  the target cell appears inside a referenced range, or in a
 *                  dependency chain through other formulas
 *
 * The verifier cannot know whether a formula answers the user's question
 * ("SUM of the wrong numeric column" is valid and wrong); it only rejects what
 * the workbook itself proves impossible or implausible.
 *
 * RETRY STRATEGY
 *  Attempt 1 temperature 0.2; attempt 2 adds structured diagnostics from this
 *  file and drops to 0.1; attempt 3 adds hard column/function constraints at
 *  0.0. If every attempt fails the best result is returned with a warning
 *  badge — something imperfect is better than nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */

function verificationLayerEnabled_(name) {
  var layers = CONFIG.VERIFICATION && CONFIG.VERIFICATION.LAYERS;
  return !layers || layers[name] !== false;
}

/**
 * Master verification function.
 * @param {string} formula
 * @param {object} context  buildDeepContext() result
 * @returns {{valid:boolean, errors:string[], warnings:string[], hints:string[], notes:string[], suspicious:string[], layers:object}}
 *   `warnings` contains every non-blocking finding (including `suspicious` ones);
 *   `notes` are advisory and never count as a finding (e.g. range headroom).
 */
function verifyFormula_(formula, context) {
  var result = { valid: true, errors: [], warnings: [], hints: [], notes: [], suspicious: [], layers: {} };

  if (!formula || typeof formula !== 'string') {
    result.valid = false;
    result.errors.push('Output is not a valid string.');
    return result;
  }
  formula = formula.trim();

  function absorb(layerName, r) {
    result.layers[layerName] = r;
    if (r.errors && r.errors.length) { result.valid = false; result.errors = result.errors.concat(r.errors); }
    if (r.warnings) result.warnings = result.warnings.concat(r.warnings);
    if (r.hints) result.hints = result.hints.concat(r.hints);
    if (r.notes) result.notes = result.notes.concat(r.notes);
    if (r.suspicious) { result.suspicious = result.suspicious.concat(r.suspicious); result.warnings = result.warnings.concat(r.suspicious); }
  }

  // ─── LAYER 1: STRUCTURAL ─────────────────────────────────────────────────
  var parsed = null;
  if (verificationLayerEnabled_('structural')) {
    var layer1 = verifyStructural_(formula);
    result.layers.structural = layer1;
    if (!layer1.valid) {
      result.valid = false;
      result.errors = result.errors.concat(layer1.errors);
      return result; // fundamental — skip remaining layers
    }
  }
  parsed = parseFormulaAst_(formula);
  if (!parsed.ok) {
    if (verificationLayerEnabled_('structural')) {
      result.valid = false;
      result.errors.push('Syntax error: ' + parsed.error);
    }
    return result; // the deeper layers all need an AST
  }
  var ast = parsed.ast;

  if (context) {
    var vc = makeVerifyContext_(context);

    // ─── LAYER 2: SYMBOLS ──────────────────────────────────────────────────
    if (verificationLayerEnabled_('symbols')) absorb('symbols', verifySymbolsAst_(ast, vc));
    if (verificationLayerEnabled_('query')) {
      var queryCheck = verifyQueryColumns_(formula, context);
      result.layers.queryColumns = queryCheck;
      if (queryCheck.errors.length > 0) { result.valid = false; result.errors = result.errors.concat(queryCheck.errors); }
      result.warnings = result.warnings.concat(queryCheck.warnings);
      result.hints = result.hints.concat(queryCheck.hints);
    }

    // ─── LAYER 3: BOUNDS ───────────────────────────────────────────────────
    if (verificationLayerEnabled_('bounds')) absorb('bounds', verifyBoundsAst_(ast, vc));

    // ─── LAYER 4: SHAPE ────────────────────────────────────────────────────
    if (verificationLayerEnabled_('shape')) absorb('shape', verifyShapeAst_(ast, vc));

    // ─── LAYER 5: GROUNDING ────────────────────────────────────────────────
    if (verificationLayerEnabled_('grounding')) absorb('grounding', verifyGroundingAst_(ast, vc));

    // ─── LAYER 6: CIRCULARITY ──────────────────────────────────────────────
    if (verificationLayerEnabled_('circular')) {
      var circ = verifyCircularReference_(formula, context);
      result.layers.circularReference = circ;
      if (circ.errors.length > 0) { result.valid = false; result.errors = result.errors.concat(circ.errors); }
    }
  }

  // Unknown-function warnings that need no workbook (context-free callers)
  if (!context) absorb('functions', verifySymbolsAst_(ast, makeVerifyContext_(null)));

  return result;
}

/**
 * Returns a copy of `context` that says where the formula will actually be
 * written. Most callers write to the active cell (the default); tools that
 * write to an explicit cell/sheet pass it here so circularity is judged
 * against the real destination.
 */
function targetContext_(context, sheetName, cell) {
  var copy = {};
  Object.keys(context || {}).forEach(function (k) { copy[k] = context[k]; });
  if (sheetName) copy.targetSheet = sheetName;
  if (cell) copy.targetCell = String(cell).replace(/\$/g, '');
  return copy;
}

/** True when the agent loop should treat this result as a failed attempt. */
function verificationNeedsRepair_(verification) {
  if (!verification.valid) return true;
  return !!(CONFIG.VERIFICATION && CONFIG.VERIFICATION.REPAIR_ON_SUSPICIOUS && verification.suspicious && verification.suspicious.length > 0);
}

/**
 * LAYER 1: Structural verification (pure string analysis).
 * Parentheses are counted outside string literals, so =IF(A1="(",1,2) is fine.
 */
function verifyStructural_(formula) {
  if (!formula.startsWith('=')) {
    return { valid: false, errors: ['Formula must start with "=". Got: ' + formula.substring(0, 30)] };
  }

  var injectionPatterns = [
    { pattern: /=\s*DDE\s*\(/i,           reason: 'DDE() is a data execution attack vector.' },
    { pattern: /\+\s*DDE\s*\(/i,          reason: 'DDE() is a data execution attack vector.' },
    { pattern: /javascript\s*:/i,          reason: 'javascript: URIs are blocked.' },
    { pattern: /vbscript\s*:/i,            reason: 'vbscript: URIs are blocked.' },
    { pattern: /=\s*HYPERLINK\s*\(\s*["']javascript/i, reason: 'javascript: HYPERLINK is blocked.' }
  ];
  for (var p = 0; p < injectionPatterns.length; p++) {
    if (injectionPatterns[p].pattern.test(formula)) {
      return { valid: false, errors: ['Blocked pattern: ' + injectionPatterns[p].reason] };
    }
  }

  var doubleQuotes = (formula.match(/"/g) || []).length;
  if (doubleQuotes % 2 !== 0) {
    return { valid: false, errors: ['Unbalanced double quotes in formula.'] };
  }

  var stripped = formula.replace(/"(?:[^"]|"")*"/g, '""');
  var depth = 0;
  for (var i = 0; i < stripped.length; i++) {
    if (stripped[i] === '(') depth++;
    if (stripped[i] === ')') depth--;
    if (depth < 0) return { valid: false, errors: ['Unbalanced parentheses: unexpected ")" at position ' + i + '.'] };
  }
  if (depth !== 0) return { valid: false, errors: ['Unbalanced parentheses: ' + depth + ' unclosed "(".'] };

  return { valid: true, errors: [] };
}

// ─── Verification context: lazily-read, per-call workbook facts ─────────────

function makeVerifyContext_(context) {
  var vc = { context: context || null, ss: null, sheetNames: {}, dims: {}, profiles: {}, available: false };
  if (!context) return vc;
  try {
    vc.ss = SpreadsheetApp.getActiveSpreadsheet();
    vc.ss.getSheets().forEach(function (s) { vc.sheetNames[s.getName().toLowerCase()] = s.getName(); });
    vc.available = true;
  } catch (e) { /* workbook facts unavailable: workbook-dependent checks are skipped */ }
  return vc;
}

/** Actual sheet name a reference points at (case-insensitive, as in Sheets), or null if it does not exist. */
function refSheetName_(vc, ref) {
  // an unqualified reference points at the sheet the formula will be written to
  // (see targetContext_), which is the active sheet unless a tool says otherwise
  var name = ref.sheet || (vc.context && (vc.context.targetSheet || vc.context.sheetName));
  if (!name) return null;
  if (!vc.available) return name;
  return vc.sheetNames[String(name).toLowerCase()] || null;
}

function sheetDims_(vc, sheetName) {
  if (vc.dims[sheetName]) return vc.dims[sheetName];
  var dims = null;
  if (vc.context && sheetName === vc.context.sheetName && vc.context.dimensions) {
    dims = { rows: vc.context.dimensions.rows, cols: vc.context.dimensions.cols };
  } else if (vc.available) {
    try {
      var sheet = vc.ss.getSheetByName(sheetName);
      if (sheet) dims = { rows: sheet.getLastRow(), cols: sheet.getLastColumn() };
    } catch (e) { /* leave null */ }
  }
  vc.dims[sheetName] = dims;
  return dims;
}

/** Type/value profile of one column (rows 2..N): numeric fraction, distinct values, header. */
function columnProfile_(vc, sheetName, col) {
  var key = sheetName + '#' + col;
  if (vc.profiles[key] !== undefined) return vc.profiles[key];
  var prof = null;
  try {
    var sheet = vc.ss.getSheetByName(sheetName);
    var lastRow = sheet.getLastRow();
    if (sheet && lastRow >= 2 && col >= 1 && col <= sheet.getLastColumn()) {
      var n = Math.min(lastRow - 1, VERIFY_SCAN_ROWS_);
      var vals = sheet.getRange(2, col, n, 1).getValues();
      var nonEmpty = 0, numeric = 0, distinctCount = 0, distinct = {}, sample = [];
      vals.forEach(function (row) {
        var v = row[0];
        if (v === '' || v === null || v === undefined) return;
        nonEmpty++;
        if (typeof v === 'number' || Object.prototype.toString.call(v) === '[object Date]') numeric++;
        var k = String(v).trim().toLowerCase();
        if (!distinct[k]) { distinct[k] = true; distinctCount++; if (sample.length < 8) sample.push(String(v)); }
      });
      var header = sheet.getRange(1, col, 1, 1).getValue();
      prof = { header: header, nonEmpty: nonEmpty, numericFrac: nonEmpty ? numeric / nonEmpty : 0, distinct: distinct, distinctCount: distinctCount, sample: sample, scannedAll: (lastRow - 1) <= n };
    }
  } catch (e) { /* profile stays null */ }
  vc.profiles[key] = prof;
  return prof;
}

function colName_(col) { return colIndexToLetter_(col); }

function refDisplay_(ref) {
  return (ref.sheet ? ref.sheet + '!' : '') + ref.a + (ref.b ? ':' + ref.b : '');
}

// ─── LAYER 2: SYMBOLS ───────────────────────────────────────────────────────

function nearestFunction_(name) {
  var limit = name.length >= 6 ? 2 : 1;
  var best = null, bestD = limit + 1;
  KNOWN_SHEET_FUNCTIONS_.forEach(function (f) {
    var d = editDistance_(name, f, limit);
    if (d < bestD) { bestD = d; best = f; }
  });
  return bestD <= limit ? best : null;
}

function normalizeIdentifier_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * INDIRECT("Sheet!A1") names a sheet in text. When the first argument is a text literal, or a concatenation that
 * starts with one, and that leading text has the form Sheet! or 'Sheet name'!, the sheet can be checked statically.
 * Names built from cell values or ranges are left alone: the check cannot know them.
 */
function indirectSheetCheck_(call, vc, context, seen, errors, hints) {
  if (!call.args.length) return;
  var node = call.args[0];
  while (node && node.t === 'bin' && node.op === '&') node = node.l;
  if (!node || node.t !== 'str') return;
  var m = node.v.match(/^\s*(?:'((?:[^']|'')+)'|([^'!:\s][^'!:]*?))\s*!/);
  if (!m) return;
  var name = (m[1] || m[2]).replace(/''/g, "'");
  var key = name.toLowerCase();
  if (seen['indirect:' + key]) return;
  seen['indirect:' + key] = true;
  if (vc.sheetNames[key] || (context.sheetName && key === String(context.sheetName).toLowerCase())) return;
  errors.push('INDIRECT refers to sheet "' + name + '", which does not exist.');
  hints.push('Available sheets: ' + Object.keys(vc.sheetNames).map(function (k) { return '"' + vc.sheetNames[k] + '"'; }).join(', '));
}

function verifySymbolsAst_(ast, vc) {
  var errors = [], warnings = [], hints = [];
  var context = vc.context || {};
  var known = knownFunctionSet_();
  var seenSheets = {}, seenFns = {}, seenNames = {}, seenErrs = {};

  var namedRanges = {};
  (context.namedRanges || []).forEach(function (r) { namedRanges[String(r.name).toLowerCase()] = true; });

  // variables bound by LET(name, value, ...) and LAMBDA(x, ..., body) are not references
  var bound = {};
  walkFormulaAst_(ast, function (n) {
    if (n.t !== 'call') return;
    if (n.name === 'LET') n.args.forEach(function (a, i) { if (i % 2 === 0 && i < n.args.length - 1 && a.t === 'name') bound[a.v.toLowerCase()] = true; });
    if (n.name === 'LAMBDA') n.args.forEach(function (a, i) { if (i < n.args.length - 1 && a.t === 'name') bound[a.v.toLowerCase()] = true; });
  });

  walkFormulaAst_(ast, function (n) {
    if (n.t === 'ref' && n.sheet && vc.available) {
      var key = n.sheet.toLowerCase();
      if (seenSheets[key]) return;
      seenSheets[key] = true;
      if (!vc.sheetNames[key] && !(context.sheetName && key === String(context.sheetName).toLowerCase())) {
        errors.push('Sheet "' + n.sheet + '" does not exist.');
        var all = Object.keys(vc.sheetNames).map(function (k) { return '"' + vc.sheetNames[k] + '"'; });
        hints.push('Available sheets: ' + all.join(', '));
      }
    } else if (n.t === 'err' && (n.v === '#REF!' || n.v === '#NAME?')) {
      // an error literal left in the formula: a deleted reference (#REF!) or an unrecognised name (#NAME?)
      if (seenErrs[n.v]) return;
      seenErrs[n.v] = true;
      if (n.v === '#REF!') {
        errors.push('The formula contains #REF!: a reference in it points to a cell, range or sheet that was deleted.');
        hints.push('Re-enter the deleted reference (retype the range) instead of leaving #REF! in the formula.');
      } else {
        errors.push('The formula contains #NAME?: a name in it was not recognised.');
        hints.push('Replace the unrecognised name with a valid reference or function.');
      }
    } else if (n.t === 'name' && !n.sheet) {
      var lower = n.v.toLowerCase();
      if (seenNames[lower] || namedRanges[lower] || bound[lower]) return;
      seenNames[lower] = true;
      errors.push('"' + n.v + '" is not a function, named range or cell reference.');
      var norm = normalizeIdentifier_(n.v);
      var headers = context.headers || [];
      for (var i = 0; i < headers.length; i++) {
        if (headers[i] !== '' && normalizeIdentifier_(headers[i]) === norm) {
          hints.push('"' + headers[i] + '" is a column header (column ' + colName_(i + 1) + '). Reference it by cell range, e.g. ' + colName_(i + 1) + '2:' + colName_(i + 1) + (context.dimensions ? context.dimensions.rows : '') + ', not by name.');
          break;
        }
      }
      var nrNames = (context.namedRanges || []).map(function (r) { return r.name; });
      if (nrNames.length) hints.push('Defined named ranges: ' + nrNames.join(', '));
    } else if (n.t === 'call') {
      if (n.name === 'INDIRECT' && vc.available) indirectSheetCheck_(n, vc, context, seenSheets, errors, hints);
      if (seenFns[n.name] || known[n.name]) return;
      seenFns[n.name] = true;
      var suggestion = nearestFunction_(n.name);
      if (suggestion) {
        errors.push('Unknown function "' + n.name + '".');
        hints.push('Did you mean ' + suggestion + '?');
      } else {
        warnings.push('Unknown function "' + n.name + '". Verify it exists in Google Sheets.');
      }
    }
  });

  return { errors: errors, warnings: warnings, hints: hints };
}

/** Backwards-compatible entry point: sheet-existence / hallucinated-symbol check on a raw formula. */
function verifyHallucinations_(formula, context) {
  var parsed = parseFormulaAst_(formula);
  if (!parsed.ok) return { valid: true, errors: [], hints: [], warnings: [] };
  var r = verifySymbolsAst_(parsed.ast, makeVerifyContext_(context));
  return { valid: r.errors.length === 0, errors: r.errors, hints: r.hints, warnings: r.warnings };
}

// QUERY-language keywords/functions that are NOT column-letter references,
// even though bare 1-3 uppercase-letter tokens (e.g. "BY" in "GROUP BY", "IS"
// in "IS NULL") could otherwise look like one. Prevents false positives.
var QUERY_LANGUAGE_KEYWORDS_ = {
  SELECT: 1, WHERE: 1, GROUP: 1, BY: 1, ORDER: 1, LIMIT: 1, OFFSET: 1, LABEL: 1, FORMAT: 1,
  PIVOT: 1, AND: 1, OR: 1, NOT: 1, IS: 1, NULL: 1, ASC: 1, DESC: 1, LIKE: 1, CONTAINS: 1,
  MATCHES: 1, STARTS: 1, ENDS: 1, WITH: 1, SUM: 1, COUNT: 1, AVG: 1, MAX: 1, MIN: 1,
  TODAY: 1, NOW: 1, YEAR: 1, MONTH: 1, DAY: 1, DATE: 1, TRUE: 1, FALSE: 1
};

/**
 * Validates column-letter references inside a QUERY() formula's query-string
 * argument (`=QUERY(A1:C10,"SELECT B WHERE C > 5")` — columns are referenced
 * by bare letter, relative to the range, NOT by header name). Quoted string
 * values inside the query are ignored.
 */
function verifyQueryColumns_(formula, context) {
  var errors = [];
  var warnings = [];
  var hints = [];

  var queryStringPattern = /QUERY\s*\([^,]+,\s*"((?:[^"\\]|\\.)*)"/gi;
  var queryStringMatch;
  while ((queryStringMatch = queryStringPattern.exec(formula)) !== null) {
    var queryStr = queryStringMatch[1].replace(/'[^']*'/g, "''");
    var tokens = queryStr.match(/\b[A-Z]{1,3}\b/g) || [];
    var seen = {};

    tokens.forEach(function (token) {
      if (QUERY_LANGUAGE_KEYWORDS_[token] || seen[token]) return;
      seen[token] = true;

      var colNum = 0;
      for (var c = 0; c < token.length; c++) colNum = colNum * 26 + (token.charCodeAt(c) - 64);

      if (context.dimensions && colNum > context.dimensions.cols) {
        errors.push('QUERY references column ' + token + ' but the range only has ' + context.dimensions.cols + ' columns.');
        hints.push('Available QUERY columns: A through ' + colIndexToLetter_(context.dimensions.cols));
      } else if (context.headers && context.headers[colNum - 1] === '') {
        warnings.push('QUERY references column ' + token + ', which has no header — verify this is intentional.');
      }
    });
  }

  return { errors: errors, warnings: warnings, hints: hints };
}

// ─── LAYER 3: BOUNDS (sheet-aware) ──────────────────────────────────────────

// COUNTA/COUNTBLANK/ISBLANK exist to test whether cells are empty, so pointing
// them at an empty region is intentional, not a hallucinated column.
var EMPTINESS_FUNCTIONS_ = { COUNTA: 1, COUNTBLANK: 1, ISBLANK: 1 };

function boundsCheckedRefs_(ast) {
  var refs = [];
  walkFormulaAst_(ast, function (n, parent) {
    if (n.t !== 'ref') return;
    if (parent && parent.t === 'call' && EMPTINESS_FUNCTIONS_[parent.name]) return;
    refs.push(n);
  });
  return refs;
}

function verifyBoundsAst_(ast, vc) {
  var errors = [], warnings = [], hints = [], notes = [];
  if (!vc.available) return { errors: errors, warnings: warnings, hints: hints, notes: notes };
  var seen = {};

  boundsCheckedRefs_(ast).forEach(function (ref) {
    var sheetName = refSheetName_(vc, ref);
    if (!sheetName) return; // unknown sheet: reported by the symbols layer
    var dims = sheetDims_(vc, sheetName);
    if (!dims || dims.rows === 0 || dims.cols === 0) return;
    var shown = refDisplay_(ref);
    if (seen[shown]) return;
    seen[shown] = true;

    // columns wholly beyond the used range
    if (ref.c1 !== null && ref.c1 > dims.cols) {
      var msg = 'Column ' + colName_(ref.c1) + ' in ' + shown + ' is beyond the used range of "' + sheetName + '" (columns A-' + colName_(dims.cols) + ').';
      if (ref.kind === 'cell') warnings.push(msg);
      else { errors.push(msg); hints.push('Sheet "' + sheetName + '" only has data in columns A-' + colName_(dims.cols) + '.'); }
      return;
    }
    // rows
    if (ref.r1 !== null && ref.r1 > dims.rows) {
      warnings.push(shown + ' starts below the last row of data in "' + sheetName + '" (row ' + dims.rows + ') — it covers no data.');
    } else if (ref.r2 !== null && ref.r2 > dims.rows && ref.kind !== 'cell') {
      notes.push(shown + ' extends past the last data row (' + dims.rows + ') — treated as headroom for future rows.');
    }
  });

  return { errors: errors, warnings: warnings, hints: hints, notes: notes };
}

/** Backwards-compatible entry point: bounds check on a raw formula + context. */
function verifyRangeBounds_(formula, context) {
  var parsed = parseFormulaAst_(formula);
  if (!parsed.ok) return { warnings: [], errors: [], hints: [], notes: [] };
  var r = verifyBoundsAst_(parsed.ast, makeVerifyContext_(context));
  // callers of this legacy entry point only read .warnings; surface hard findings there too
  return { warnings: r.warnings.concat(r.errors), errors: r.errors, hints: r.hints, notes: r.notes };
}

// ─── LAYER 4: SHAPE ─────────────────────────────────────────────────────────

function isBoundedRange_(ref) { return ref.t === 'ref' && ref.kind === 'range' && ref.r2 !== null; }

function refRows_(ref) { return ref.r2 !== null && ref.r1 !== null ? ref.r2 - ref.r1 + 1 : null; }
function refCols_(ref) { return ref.c2 !== null && ref.c1 !== null ? ref.c2 - ref.c1 + 1 : null; }

function verifyShapeAst_(ast, vc) {
  var errors = [], warnings = [], hints = [];

  walkFormulaAst_(ast, function (n) {
    if (n.t !== 'call') return;
    var fn = n.name;
    var args = n.args;

    // arity
    var arity = FUNCTION_ARITY_[fn];
    if (arity && (args.length < arity[0] || args.length > arity[1])) {
      var expected = arity[0] === arity[1] ? String(arity[0]) : arity[0] + '-' + arity[1];
      errors.push(fn + ' expects ' + expected + ' argument' + (expected === '1' ? '' : 's') + ' but got ' + args.length + '.');
    }

    // VLOOKUP / HLOOKUP column (row) index must fall inside the lookup range
    if ((fn === 'VLOOKUP' || fn === 'HLOOKUP') && args.length >= 3 && args[1].t === 'ref' && args[2].t === 'num') {
      var span = fn === 'VLOOKUP' ? refCols_(args[1]) : refRows_(args[1]);
      var dim = fn === 'VLOOKUP' ? 'columns' : 'rows';
      var idx = args[2].v;
      if (idx < 1 || (span !== null && idx > span)) {
        errors.push(fn + ' index ' + idx + ' is outside the lookup range ' + refDisplay_(args[1]) + (span !== null ? ' (' + span + ' ' + dim + ')' : '') + '.');
        if (span !== null) hints.push('Use an index between 1 and ' + span + '.');
      }
    }

    // INDEX(range, row, col) with literal positions beyond a bounded range
    if (fn === 'INDEX' && args.length >= 2 && isBoundedRange_(args[0])) {
      var rows = refRows_(args[0]), cols = refCols_(args[0]);
      if (args[1].t === 'num' && args[1].v > rows) errors.push('INDEX row ' + args[1].v + ' is outside ' + refDisplay_(args[0]) + ' (' + rows + ' rows).');
      if (args[2] && args[2].t === 'num' && args[2].v > cols) errors.push('INDEX column ' + args[2].v + ' is outside ' + refDisplay_(args[0]) + ' (' + cols + ' columns).');
    }

    // aligned ranges must have equal size
    var aligned = null;
    if (CRITERIA_FUNCTIONS_[fn]) {
      var spec = CRITERIA_FUNCTIONS_[fn];
      aligned = [];
      if (spec.valueArg === 0) aligned.push(args[0]);
      for (var i = spec.pairsFrom; i < args.length; i += 2) {
        if (spec.pairsMax !== undefined && i > spec.pairsMax) break;
        aligned.push(args[i]);
      }
      if (spec.valueArg > 0 && args[spec.valueArg]) aligned.push(args[spec.valueArg]);
    } else if (fn === 'SUMPRODUCT' && args.length > 1) {
      aligned = args.slice();
    }
    if (aligned) {
      var sizes = [];
      aligned.forEach(function (a) {
        if (a && a.t === 'ref' && a.kind === 'range' && a.r2 !== null) sizes.push({ ref: a, rows: refRows_(a), cols: refCols_(a) });
      });
      for (var j = 1; j < sizes.length; j++) {
        if (sizes[j].rows !== sizes[0].rows || sizes[j].cols !== sizes[0].cols) {
          errors.push(fn + ' ranges have different sizes: ' + refDisplay_(sizes[0].ref) + ' is ' + sizes[0].rows + 'x' + sizes[0].cols + ' but ' + refDisplay_(sizes[j].ref) + ' is ' + sizes[j].rows + 'x' + sizes[j].cols + '.');
          hints.push('All ranges passed to ' + fn + ' must cover the same number of rows and columns.');
          break;
        }
      }
    }
  });

  return { errors: errors, warnings: warnings, hints: hints };
}

// ─── LAYER 5: GROUNDING (data-aware, reported as "suspicious") ──────────────

function singleColumnOf_(ref) {
  if (ref.t !== 'ref' || (ref.kind !== 'range' && ref.kind !== 'col') || ref.c1 === null || ref.c1 !== ref.c2) return null;
  return ref.c1;
}

function verifyGroundingAst_(ast, vc) {
  var suspicious = [], hints = [];
  if (!vc.available) return { errors: [], suspicious: suspicious, hints: hints };

  function profileFor(ref) {
    var col = singleColumnOf_(ref);
    if (col === null) return null;
    var sheetName = refSheetName_(vc, ref);
    return sheetName ? columnProfile_(vc, sheetName, col) : null;
  }

  function checkNumeric(fn, ref) {
    var prof = profileFor(ref);
    if (prof && prof.nonEmpty >= 3 && prof.numericFrac < 0.1) {
      suspicious.push(fn + ' is applied to ' + refDisplay_(ref) + ', a column of text' + (prof.header ? ' ("' + prof.header + '")' : '') + ' — the result will be 0 or an error.');
    }
  }

  function checkLiteral(ref, literal, role) {
    if (!literal || literal.t !== 'str') return;
    var value = literal.v.trim();
    if (value === '' || /^[<>=]/.test(value) || /[*?~]/.test(value) || isFinite(Number(value))) return;
    var prof = profileFor(ref);
    if (!prof || prof.nonEmpty < 3 || prof.numericFrac >= 0.5) return;
    if (!(prof.scannedAll || prof.distinctCount <= 25)) return;
    if (prof.distinct[value.toLowerCase()]) return;
    var near = null, best = 3;
    prof.sample.forEach(function (s) { var d = editDistance_(value.toLowerCase(), s.toLowerCase(), 2); if (d < best) { best = d; near = s; } });
    suspicious.push(role + ' "' + literal.v + '" never occurs in ' + refDisplay_(ref) + (prof.header ? ' ("' + prof.header + '")' : '') + '.');
    hints.push('Values in that column include: ' + prof.sample.join(', ') + (prof.distinctCount > prof.sample.length ? ', ...' : '') + (near ? '. Closest match: "' + near + '".' : '.'));
  }

  walkFormulaAst_(ast, function (n) {
    if (n.t !== 'call') return;
    var fn = n.name, args = n.args;

    // numeric aggregates over text columns
    if (NUMERIC_AGGREGATES_[fn]) {
      args.forEach(function (a) { if (a.t === 'ref') checkNumeric(fn, a); });
    }
    var spec = CRITERIA_FUNCTIONS_[fn];
    if (spec) {
      var valueRef = spec.valueArg >= 0 ? args[spec.valueArg] : null;
      if (spec.valueArg === 2 && !valueRef) valueRef = args[0]; // SUMIF/AVERAGEIF default sum_range
      if (valueRef && valueRef.t === 'ref' && fn !== 'COUNTIF' && fn !== 'COUNTIFS') checkNumeric(fn, valueRef);

      for (var i = spec.pairsFrom; i + 1 < args.length; i += 2) {
        if (spec.pairsMax !== undefined && i > spec.pairsMax) break;
        if (args[i].t === 'ref') checkLiteral(args[i], args[i + 1], 'Criterion');
      }
    }
    // lookup keys: literal key vs. the column it searches
    if ((fn === 'VLOOKUP' || fn === 'XLOOKUP') && args.length >= 2 && args[1].t === 'ref' && args[0].t === 'str') {
      var keyRef = Object.assign({}, args[1], { c2: args[1].c1 });
      checkLiteral(keyRef, args[0], 'Lookup key');
    }
    if (fn === 'MATCH' && args.length >= 2 && args[1].t === 'ref' && args[0].t === 'str') {
      checkLiteral(args[1], args[0], 'Lookup key');
    }
  });

  return { errors: [], suspicious: suspicious, hints: hints };
}

// ─── LAYER 6: CIRCULARITY (range-aware) ─────────────────────────────────────

function refContainsCell_(ref, row, col) {
  if (ref.c1 === null && ref.r1 === null) return false;
  var colOk = ref.c1 === null || (col >= ref.c1 && col <= ref.c2);
  var rowOk = ref.r1 === null || (row >= ref.r1 && (ref.r2 === null || row <= ref.r2));
  return colOk && rowOk;
}

function sameSheet_(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

// ROW/ROWS/COLUMN/COLUMNS read only the position or size of their reference,
// never its values, so =ROWS(B$2:B83) typed into B83 is not circular.
var GEOMETRY_ONLY_FUNCTIONS_ = { ROW: 1, ROWS: 1, COLUMN: 1, COLUMNS: 1 };

/** References a formula actually depends on (values read), in source order. */
function dependencyRefs_(ast) {
  var refs = [];
  (function walk(node) {
    if (!node) return;
    if (node.t === 'ref') { refs.push(node); return; }
    if (node.t === 'call') {
      if (GEOMETRY_ONLY_FUNCTIONS_[node.name]) return;
      node.args.forEach(walk);
    } else if (node.t === 'bin') { walk(node.l); walk(node.r); }
    else if (node.t === 'un' || node.t === 'pct') walk(node.e);
    else if (node.t === 'array') node.rows.forEach(function (row) { row.forEach(walk); });
  })(ast);
  return refs;
}

/**
 * Detects circular references: does this formula, placed at the active cell,
 * depend on its own cell? Checks, in order:
 *   1. a reference to the cell itself;
 *   2. a range or whole-column reference that CONTAINS the cell (the classic
 *      totals-row mistake: =SUM(F2:F81) typed into F81, or =SUM(F:F) into F5);
 *   3. a chain through other formulas in the workbook, where a range
 *      dependency is expanded to every formula cell inside it.
 */
function verifyCircularReference_(formula, context) {
  var errors = [];
  if (!context || !context.sheetName || !context.activeCell) return { errors: errors };

  // the cell the formula will be written to (see targetContext_); defaults to the active cell
  var targetCellA1 = context.targetCell || context.activeCell;
  var target = splitCellRef_(targetCellA1);
  var parsed = parseFormulaAst_(formula);
  if (!target || !parsed.ok) return { errors: errors };
  var refs = dependencyRefs_(parsed.ast);
  var activeSheet = context.targetSheet || context.sheetName;

  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    if (r.sheet && !sameSheet_(r.sheet, activeSheet)) continue;
    if (refContainsCell_(r, target.row, target.col)) {
      if (r.kind === 'cell') errors.push('Formula directly references its own cell (' + targetCellA1 + ') — a circular reference.');
      else errors.push('Formula range ' + refDisplay_(r) + ' includes its own cell (' + targetCellA1 + ') — a circular reference.');
      return { errors: errors };
    }
  }

  try {
    var lightweightWorkbook = {
      sheets: SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
        return { name: s.getName(), rowCount: s.getLastRow(), colCount: s.getLastColumn() };
      })
    };
    var graph = buildFormulaGraph_(lightweightWorkbook);

    // index formula cells by sheet for range expansion
    var cellsBySheet = {};
    graph.nodes.forEach(function (node) {
      var sep = node.indexOf('!');
      var sheet = node.slice(0, sep).toLowerCase();
      var pos = splitCellRef_(node.slice(sep + 1));
      if (!pos) return;
      (cellsBySheet[sheet] = cellsBySheet[sheet] || []).push({ node: node, row: pos.row, col: pos.col });
    });

    function depToRef(dep) {
      var b = parseRefBounds_(dep.ref);
      if (!b) return null;
      return { sheet: dep.sheet, c1: b.startCol, c2: b.endCol, r1: b.startRow, r2: b.endRow >= 1000000 ? null : b.endRow };
    }

    // dependencies of an existing formula cell: AST-based (skips geometry-only
    // functions); falls back to the regex graph if the formula does not parse
    function formulaDeps(info, node) {
      var p = parseFormulaAst_(info.formula);
      if (!p.ok) return info.dependencies.map(depToRef);
      var home = node.slice(0, node.indexOf('!'));
      return dependencyRefs_(p.ast).map(function (r) { return { sheet: r.sheet || home, c1: r.c1, c2: r.c2, r1: r.r1, r2: r.r2 }; });
    }

    var visited = {};
    var found = false;
    function visit(depRefs) {
      for (var d = 0; d < depRefs.length && !found; d++) {
        var ref = depRefs[d];
        if (!ref) continue;
        if (sameSheet_(ref.sheet, activeSheet) && refContainsCell_(ref, target.row, target.col)) { found = true; return; }
        var cells = cellsBySheet[String(ref.sheet).toLowerCase()] || [];
        for (var k = 0; k < cells.length && !found; k++) {
          var cell = cells[k];
          if (visited[cell.node] || !refContainsCell_(ref, cell.row, cell.col)) continue;
          visited[cell.node] = true;
          var info = graph.formulas[cell.node];
          visit(info ? formulaDeps(info, cell.node) : []);
        }
      }
    }
    visit(refs.map(function (r) {
      return { sheet: r.sheet || activeSheet, c1: r.c1, c2: r.c2, r1: r.r1, r2: r.r2 };
    }));

    if (found) {
      errors.push('Formula would create a circular reference chain back to ' + targetCellA1 + ' through other formulas in the workbook.');
    }
  } catch (e) {
    logWarn_('Verification', 'Circular reference deep-check skipped: ' + e.message);
  }

  return { errors: errors };
}

/**
 * Legacy function-existence check on a raw formula (warnings only). The master
 * verifier now folds this into the symbols layer; kept for direct callers.
 */
function verifyFunctions_(formula) {
  var parsed = parseFormulaAst_(formula);
  if (!parsed.ok) return { warnings: [] };
  var r = verifySymbolsAst_(parsed.ast, makeVerifyContext_(null));
  return { warnings: r.errors.concat(r.warnings).filter(function (m) { return /^Unknown function/.test(m); }).map(function (m) { return m.replace(/\.$/, '') + '. Verify it exists in Google Sheets.'; }) };
}

/**
 * Build the retry prompt for attempt N.
 * This is the structured error feedback that makes retry attempt 2 succeed
 * where attempt 1 failed — the LLM sees exactly what was wrong.
 *
 * @param {string} badFormula        - The formula that failed verification
 * @param {object} verificationResult - The VerificationResult from verifyFormula_()
 * @param {number} attemptNumber      - 1-indexed attempt number (for escalation)
 * @param {object} context            - Spreadsheet context
 * @returns {string}                  - The feedback to append to the retry prompt
 */
function buildRetryFeedback_(badFormula, verificationResult, attemptNumber, context) {
  var lines = [
    'Your formula failed verification on attempt ' + attemptNumber + ':',
    'Formula: ' + badFormula,
    ''
  ];

  if (verificationResult.errors.length > 0) {
    lines.push('HARD ERRORS (must fix):');
    verificationResult.errors.forEach(function(e) { lines.push('  ✗ ' + e); });
  }

  if (verificationResult.warnings.length > 0) {
    lines.push('WARNINGS (should fix):');
    verificationResult.warnings.forEach(function(w) { lines.push('  ⚠ ' + w); });
  }

  if (verificationResult.hints.length > 0) {
    lines.push('CORRECTION HINTS:');
    verificationResult.hints.forEach(function(h) { lines.push('  → ' + h); });
  }

  // Attempt 3: add hard constraints to eliminate hallucination surface
  if (attemptNumber >= 3 && context && context.headers) {
    var validCols = context.headers
      .map(function(h, i) { return h === '' ? '' : colIndexToLetter_(i + 1) + '="' + h + '"'; })
      .filter(Boolean)
      .join(', ');
    lines.push('');
    lines.push('HARD CONSTRAINTS FOR THIS ATTEMPT:');
    lines.push('  • Only use column letters from this list: ' + validCols);
    lines.push('  • The sheet has exactly ' + context.dimensions.rows + ' data rows');
    lines.push('  • Output the formula only — no explanation, no markdown');
  }

  return lines.join('\n');
}

// Quick sanity check on 2D data arrays before we write them to the sheet.
// Catches the case where some API returns rows with different column counts,
// which would cause setValues() to throw a cryptic error.
function verifyDataShape_(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return { valid: false, error: 'Data is empty or not an array.' };
  }
  if (!Array.isArray(data[0])) {
    return { valid: false, error: 'Data rows must be arrays.' };
  }
  var colCount = data[0].length;
  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i]) || data[i].length !== colCount) {
      return { valid: false, error: 'Row ' + (i + 1) + ' has inconsistent column count.' };
    }
  }
  return { valid: true };
}
