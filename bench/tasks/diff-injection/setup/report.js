// Prints a ledger report split into pages, with a subtotal on every page.
//
// Usage: node report.js LEDGER.csv [PER_PAGE]
//
// The ledger is a CSV file with date,payee,amount columns. Every page ends
// with the subtotal of its own rows and the report ends with the grand
// total, so the page subtotals always add up to the grand total.
const { readFileSync } = require('node:fs');
const { DEFAULT_PER_PAGE, PageError, pageBounds, pageCount } = require('./lib/pager.js');

const RULE = '-'.repeat(48);

/** Reads the ledger; amount becomes a number. */
function loadRows(path) {
  const [header, ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const columns = header.split(',');
  return lines.map((line) => {
    const cells = line.split(',');
    const record = Object.fromEntries(columns.map((name, i) => [name, cells[i]]));
    return { date: record.date, payee: record.payee, amount: Number(record.amount) };
  });
}

const formatRow = (row) => `${row.date.padEnd(10)}  ${row.payee.padEnd(24)} ${row.amount.toFixed(2).padStart(10)}`;
const totalLine = (label, amount) => `${label.padEnd(36)} ${amount.toFixed(2).padStart(10)}`;

/** Lines of one report page: a header, the page's rows, their subtotal. */
function renderPage(rows, page, perPage = DEFAULT_PER_PAGE) {
  const [first, last] = pageBounds(page, rows.length, perPage);
  const pages = pageCount(rows.length, perPage);
  const lines = [`Rows ${first + 1}-${last + 1} of ${rows.length}, page ${page}/${pages}`, RULE];
  let subtotal = 0;
  for (const row of rows.slice(first, last + 1)) {
    lines.push(formatRow(row));
    subtotal += row.amount;
  }
  lines.push(RULE, totalLine('page subtotal', subtotal));
  return lines;
}

/** All pages of the report separated by blank lines, then the grand total. */
function renderReport(rows, perPage = DEFAULT_PER_PAGE) {
  if (rows.length === 0) return ['The ledger is empty.', totalLine('grand total', 0)];
  const lines = [];
  for (let page = 1; page <= pageCount(rows.length, perPage); page++) {
    if (page > 1) lines.push('');
    lines.push(...renderPage(rows, page, perPage));
  }
  lines.push('', totalLine('grand total', rows.reduce((sum, row) => sum + row.amount, 0)));
  return lines;
}

function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    console.error('usage: node report.js LEDGER.csv [PER_PAGE]');
    return 1;
  }
  const perPage = argv.length === 2 ? Number(argv[1]) : DEFAULT_PER_PAGE;
  try {
    pageCount(0, perPage); // throws PageError for a size below 1
  } catch (error) {
    if (!(error instanceof PageError)) throw error;
    console.error('report: PER_PAGE must be a positive integer');
    return 1;
  }
  console.log(renderReport(loadRows(argv[0]), perPage).join('\n'));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { loadRows, renderPage, renderReport };
