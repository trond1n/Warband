// Browse a ledger CSV page by page from the terminal.
//
// Usage: node cli.js LEDGER.csv [--page N] [--per-page N] [--payee TEXT]
//
// A page number past the end shows the last page, so "--page 999" is a
// quick way to see the newest entries.
const { readFileSync } = require('node:fs');
const { DEFAULT_PER_PAGE, clampPage, pageLabel, paginate } = require('./lib/pager.js');

/** Rows whose payee contains `payee` (case-insensitive); all if empty. */
function matching(rows, payee) {
  if (!payee) return rows;
  const needle = payee.toLowerCase();
  return rows.filter((row) => row.payee.toLowerCase().includes(needle));
}

function main(argv) {
  const [ledger, ...rest] = argv;
  if (!ledger) {
    console.error('usage: node cli.js LEDGER.csv [--page N] [--per-page N] [--payee TEXT]');
    return 1;
  }
  const option = (name, fallback) => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest[at + 1] : fallback;
  };
  const perPage = Number(option('--per-page', DEFAULT_PER_PAGE));
  const [, ...lines] = readFileSync(ledger, 'utf8').trim().split(/\r?\n/);
  const rows = matching(
    lines.map((line) => {
      const [date, payee, amount] = line.split(',');
      return { date, payee, amount };
    }),
    option('--payee', ''),
  );
  const page = clampPage(Number(option('--page', 1)), rows.length, perPage);
  for (const row of paginate(rows, page, perPage)) console.log(`${row.date}  ${row.payee}  ${row.amount}`);
  console.log(pageLabel(page, rows.length, perPage));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { matching };
