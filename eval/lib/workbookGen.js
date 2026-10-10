'use strict';
/**
 * Seeded synthetic workbook generator.
 *
 * Every workbook has a main data sheet (header row + N data rows), a lookup
 * sheet keyed on one categorical column, and a small summary sheet with a few
 * live formulas (so the formula graph is non-trivial). Domains, column names,
 * category values and numeric ranges are fixed lists; everything stochastic
 * (row count, values, which optional columns appear, named ranges) is drawn
 * from a seeded RNG, so a (domain, seed) pair always yields the same workbook.
 */
const { makeRng } = require('./rng');

const PEOPLE = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Harper', 'Jordan', 'Kai', 'Logan', 'Morgan', 'Nico'];

// kind: id | cat | int | money. `syn` = natural-language paraphrases used by the
// task generator (never shown to the verifier).
const DOMAINS = {
  sales: {
    sheet: 'Orders',
    columns: [
      { h: 'Order ID', kind: 'id', prefix: 'ORD-', syn: ['order number', 'order reference'] },
      { h: 'Region', kind: 'cat', vals: ['East', 'West', 'North', 'South', 'Central'], syn: ['territory', 'area', 'sales zone'] },
      { h: 'Product', kind: 'cat', vals: ['Widget', 'Gadget', 'Gizmo', 'Doohickey', 'Sprocket', 'Flange'], syn: ['item', 'merchandise'] },
      { h: 'Quantity', kind: 'int', lo: 1, hi: 60, syn: ['units sold', 'number of units'] },
      { h: 'Unit Price', kind: 'money', lo: 5, hi: 250, syn: ['price each', 'per-unit price'] },
      { h: 'Revenue', kind: 'money', lo: 50, hi: 9000, syn: ['sales', 'income', 'turnover'] },
      { h: 'Salesperson', kind: 'cat', vals: PEOPLE.slice(0, 6), syn: ['rep', 'seller'] },
      { h: 'Channel', kind: 'cat', vals: ['Online', 'Retail', 'Partner'], syn: ['sales channel', 'route to market'] }
    ],
    lookup: { sheet: 'Products', key: 'Product', cols: [{ h: 'Unit Cost', kind: 'money', lo: 2, hi: 120, syn: ['cost per unit'] }, { h: 'Category', kind: 'cat', vals: ['Hardware', 'Software', 'Accessory'], syn: ['product line'] }] }
  },
  hr: {
    sheet: 'Employees',
    columns: [
      { h: 'Employee ID', kind: 'id', prefix: 'E', syn: ['staff number', 'badge id'] },
      { h: 'Department', kind: 'cat', vals: ['Engineering', 'Sales', 'Marketing', 'Finance', 'Support', 'Legal'], syn: ['team', 'division'] },
      { h: 'Title', kind: 'cat', vals: ['Analyst', 'Manager', 'Director', 'Associate', 'Lead'], syn: ['job title', 'role'] },
      { h: 'Salary', kind: 'money', lo: 40000, hi: 180000, syn: ['pay', 'compensation', 'wage'] },
      { h: 'Age', kind: 'int', lo: 21, hi: 64, syn: ['years old'] },
      { h: 'Tenure', kind: 'int', lo: 0, hi: 30, syn: ['years of service', 'seniority'] },
      { h: 'Location', kind: 'cat', vals: ['Pune', 'Austin', 'Berlin', 'Toronto', 'Lagos'], syn: ['office', 'site'] },
      { h: 'Rating', kind: 'int', lo: 1, hi: 5, syn: ['performance score', 'review score'] }
    ],
    lookup: { sheet: 'Departments', key: 'Department', cols: [{ h: 'Budget', kind: 'money', lo: 100000, hi: 5000000, syn: ['allocation'] }, { h: 'Manager', kind: 'cat', vals: PEOPLE.slice(6), syn: ['head', 'owner'] }] }
  },
  inventory: {
    sheet: 'Stock',
    columns: [
      { h: 'SKU', kind: 'id', prefix: 'SKU', syn: ['stock code', 'part number'] },
      { h: 'Warehouse', kind: 'cat', vals: ['Dallas', 'Rotterdam', 'Osaka', 'Mumbai'], syn: ['depot', 'storage site'] },
      { h: 'Category', kind: 'cat', vals: ['Tools', 'Textiles', 'Electronics', 'Food', 'Toys'], syn: ['product group', 'class'] },
      { h: 'Units On Hand', kind: 'int', lo: 0, hi: 900, syn: ['stock level', 'quantity in stock'] },
      { h: 'Reorder Level', kind: 'int', lo: 10, hi: 200, syn: ['reorder point', 'minimum stock'] },
      { h: 'Unit Cost', kind: 'money', lo: 1, hi: 400, syn: ['cost each', 'purchase price'] },
      { h: 'Supplier', kind: 'cat', vals: ['Acme', 'Borealis', 'Cobalt', 'Dynamo'], syn: ['vendor', 'provider'] },
      { h: 'Lead Time', kind: 'int', lo: 1, hi: 60, syn: ['delivery days', 'days to restock'] }
    ],
    lookup: { sheet: 'Suppliers', key: 'Supplier', cols: [{ h: 'Reliability', kind: 'int', lo: 50, hi: 100, syn: ['dependability score'] }, { h: 'Country', kind: 'cat', vals: ['USA', 'Netherlands', 'Japan', 'India'], syn: ['nation'] }] }
  },
  education: {
    sheet: 'Grades',
    columns: [
      { h: 'Student ID', kind: 'id', prefix: 'S', syn: ['pupil number', 'enrolment id'] },
      { h: 'Class', kind: 'cat', vals: ['9A', '9B', '10A', '10B', '11A'], syn: ['section', 'form group'] },
      { h: 'Subject', kind: 'cat', vals: ['Math', 'Physics', 'History', 'Biology', 'Art'], syn: ['course', 'discipline'] },
      { h: 'Score', kind: 'int', lo: 30, hi: 100, syn: ['marks', 'grade points', 'result'] },
      { h: 'Attendance', kind: 'int', lo: 50, hi: 100, syn: ['days present', 'presence rate'] },
      { h: 'Credits', kind: 'int', lo: 1, hi: 5, syn: ['credit hours'] },
      { h: 'Teacher', kind: 'cat', vals: PEOPLE.slice(0, 5), syn: ['instructor', 'tutor'] },
      { h: 'Term', kind: 'cat', vals: ['Fall', 'Spring', 'Summer'], syn: ['semester', 'session'] }
    ],
    lookup: { sheet: 'Subjects', key: 'Subject', cols: [{ h: 'Weight', kind: 'money', lo: 0.5, hi: 2, syn: ['importance factor'] }, { h: 'Faculty', kind: 'cat', vals: ['Science', 'Humanities', 'Arts'], syn: ['school'] }] }
  },
  finance: {
    sheet: 'Transactions',
    columns: [
      { h: 'Txn ID', kind: 'id', prefix: 'TX', syn: ['transaction number', 'payment id'] },
      { h: 'Account', kind: 'cat', vals: ['Operating', 'Payroll', 'Reserve', 'Escrow'], syn: ['ledger', 'bank account'] },
      { h: 'Category', kind: 'cat', vals: ['Travel', 'Software', 'Rent', 'Supplies', 'Marketing'], syn: ['expense type', 'spend class'] },
      { h: 'Amount', kind: 'money', lo: 5, hi: 5000, syn: ['value', 'payment size', 'sum paid'] },
      { h: 'Fee', kind: 'money', lo: 0, hi: 60, syn: ['charge', 'processing cost'] },
      { h: 'Currency', kind: 'cat', vals: ['USD', 'EUR', 'INR', 'GBP'], syn: ['money type'] },
      { h: 'Status', kind: 'cat', vals: ['Settled', 'Pending', 'Failed'], syn: ['state', 'outcome'] },
      { h: 'Branch', kind: 'cat', vals: ['Downtown', 'Airport', 'Campus', 'Harbor'], syn: ['office', 'outlet'] }
    ],
    lookup: { sheet: 'Accounts', key: 'Account', cols: [{ h: 'Limit', kind: 'money', lo: 1000, hi: 90000, syn: ['ceiling', 'cap'] }, { h: 'Owner', kind: 'cat', vals: PEOPLE.slice(2, 8), syn: ['holder'] }] }
  },
  projects: {
    sheet: 'Tasks',
    columns: [
      { h: 'Task ID', kind: 'id', prefix: 'T-', syn: ['ticket number', 'work item id'] },
      { h: 'Project', kind: 'cat', vals: ['Atlas', 'Beacon', 'Citadel', 'Delta'], syn: ['initiative', 'programme'] },
      { h: 'Owner', kind: 'cat', vals: PEOPLE.slice(0, 7), syn: ['assignee', 'responsible person'] },
      { h: 'Status', kind: 'cat', vals: ['Open', 'In Progress', 'Blocked', 'Done'], syn: ['state', 'progress stage'] },
      { h: 'Priority', kind: 'cat', vals: ['High', 'Medium', 'Low'], syn: ['urgency', 'importance'] },
      { h: 'Estimate', kind: 'int', lo: 1, hi: 80, syn: ['planned hours', 'effort estimate'] },
      { h: 'Actual', kind: 'int', lo: 1, hi: 120, syn: ['hours spent', 'logged hours'] },
      { h: 'Sprint', kind: 'cat', vals: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], syn: ['iteration', 'cycle'] }
    ],
    lookup: { sheet: 'ProjectInfo', key: 'Project', cols: [{ h: 'Budget', kind: 'money', lo: 10000, hi: 900000, syn: ['funding'] }, { h: 'Lead', kind: 'cat', vals: PEOPLE.slice(4), syn: ['sponsor'] }] }
  }
};

const DOMAIN_NAMES = Object.keys(DOMAINS);

function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function genValue(col, rng, i) {
  switch (col.kind) {
    case 'id': return col.prefix + (1000 + i);
    case 'cat': {
      // mildly skewed so some categories are rarer (more realistic than uniform)
      const idx = Math.min(col.vals.length - 1, Math.floor(Math.pow(rng.next(), 1.35) * col.vals.length));
      return col.vals[idx];
    }
    case 'int': return rng.int(col.lo, col.hi);
    case 'money': return Math.round((col.lo + rng.next() * (col.hi - col.lo)) * 100) / 100;
    default: return '';
  }
}

/**
 * @param {string} domain one of DOMAIN_NAMES
 * @param {number} seed
 * @param {object} [opts] { rows, withNamedRanges }
 */
function generateWorkbook(domain, seed, opts) {
  opts = opts || {};
  const spec = DOMAINS[domain];
  const rng = makeRng(seed * 7919 + DOMAIN_NAMES.indexOf(domain) * 104729 + 13);
  const nRows = opts.rows || rng.int(24, 120);

  const columns = spec.columns.map((c, i) => Object.assign({}, c, { letter: colLetter(i + 1), index: i + 1 }));
  const header = columns.map((c) => c.h);
  const data = [header];
  for (let r = 0; r < nRows; r++) data.push(columns.map((c) => genValue(c, rng, r)));

  const lastRow = nRows + 1;
  const lastCol = columns.length;

  // Lookup sheet: one row per distinct key value of the key column
  const keyCol = columns.find((c) => c.h === spec.lookup.key);
  const lookupCols = spec.lookup.cols.map((c, i) => Object.assign({}, c, { letter: colLetter(i + 2), index: i + 2 }));
  const lookupHeader = [spec.lookup.key].concat(lookupCols.map((c) => c.h));
  const lookupData = [lookupHeader];
  keyCol.vals.forEach((k) => lookupData.push([k].concat(lookupCols.map((c) => genValue(c, rng, 0)))));

  // Summary sheet with live formulas over the main sheet
  const numCols = columns.filter((c) => c.kind === 'int' || c.kind === 'money');
  const summaryData = [['Metric', 'Value']];
  const existingFormulas = [];
  numCols.slice(0, 3).forEach((c, i) => {
    const f = `=SUM(${spec.sheet}!${c.letter}2:${c.letter}${lastRow})`;
    summaryData.push([`Total ${c.h}`, f]);
    existingFormulas.push({ sheet: 'Summary', cell: `B${i + 2}`, formula: f });
  });

  const namedRanges = [];
  if (opts.withNamedRanges !== false && rng.chance(0.4)) {
    const nc = rng.pick(numCols);
    namedRanges.push({ name: nc.h.replace(/\s+/g, '') + 'Range', sheet: spec.sheet, a1: `${nc.letter}2:${nc.letter}${lastRow}` });
  }

  return {
    id: `${domain}-${seed}`,
    domain, seed,
    main: spec.sheet,
    sheets: { [spec.sheet]: data, [spec.lookup.sheet]: lookupData, Summary: summaryData },
    sheetOrder: [spec.sheet, spec.lookup.sheet, 'Summary'],
    columns,
    nRows, lastRow, lastCol,
    lookup: { sheet: spec.lookup.sheet, key: spec.lookup.key, keyCol, cols: lookupCols, keys: keyCol.vals.slice(), lastRow: keyCol.vals.length + 1 },
    namedRanges,
    existingFormulas,
    // an empty cell one blank column to the right of the table, like a user would pick
    activeCell: colLetter(lastCol + 2) + '2',
    activeCol: lastCol + 2
  };
}

function rangeOf(col, wb, sheet) {
  const last = sheet === wb.lookup.sheet ? wb.lookup.lastRow : wb.lastRow;
  return `${col.letter}2:${col.letter}${last}`;
}

module.exports = { DOMAINS, DOMAIN_NAMES, generateWorkbook, colLetter, rangeOf };
