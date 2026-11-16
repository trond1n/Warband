// Paging helpers for the ledger tools.
//
// Pages are numbered from 1. The helpers only compute indexes into a
// sequence and never touch the data, so the same arithmetic serves arrays,
// files and database queries.

const DEFAULT_PER_PAGE = 20;

/** Thrown for a page number or a page size that makes no sense. */
class PageError extends RangeError {}

/**
 * How many pages `total` items fill, at least 1.
 *
 * An empty ledger still has one (empty) page, so "page 1 of 1" is always a
 * valid thing to print.
 */
function pageCount(total, perPage = DEFAULT_PER_PAGE) {
  if (perPage < 1) throw new PageError(`perPage must be positive, got ${perPage}`);
  if (total <= 0) return 1;
  return Math.ceil(total / perPage);
}

/** Throws PageError when `total` items have no page number `page`. */
function checkPage(page, total, perPage = DEFAULT_PER_PAGE) {
  const pages = pageCount(total, perPage);
  if (!(page >= 1 && page <= pages)) throw new PageError(`page ${page} is out of range 1..${pages}`);
}

/**
 * Returns [first, last]: the index of the first and of the last item on
 * `page`, both included.
 *
 * An empty ledger has a single page with no items, so last === first - 1.
 */
function pageBounds(page, total, perPage = DEFAULT_PER_PAGE) {
  checkPage(page, total, perPage);
  const first = (page - 1) * perPage;
  const end = Math.min(first + perPage, total);
  return [first, end - 1];
}

/** The items shown on `page`. */
function paginate(items, page, perPage = DEFAULT_PER_PAGE) {
  const [first, last] = pageBounds(page, items.length, perPage);
  return items.slice(first, last + 1);
}

/**
 * The existing page nearest to `page`. Interactive tools use it so that
 * "page 99" of a short ledger shows the last page instead of an error.
 */
function clampPage(page, total, perPage = DEFAULT_PER_PAGE) {
  return Math.max(1, Math.min(page, pageCount(total, perPage)));
}

/** A readable position such as "page 2 of 5". */
function pageLabel(page, total, perPage = DEFAULT_PER_PAGE) {
  checkPage(page, total, perPage);
  return `page ${page} of ${pageCount(total, perPage)}`;
}

module.exports = { DEFAULT_PER_PAGE, PageError, pageCount, checkPage, pageBounds, paginate, clampPage, pageLabel };
