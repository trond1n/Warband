// Money helpers for splitting a shared bill. Amounts are whole cents.

/**
 * Splits `totalCents` between `people` as evenly as possible.
 *
 * Shares are whole cents and always add up to exactly `totalCents`. When
 * the split is uneven, the first people in the list pay one cent more.
 * A negative total (a refund) splits the same way: the first people get one
 * cent more back.
 */
function splitBill(totalCents, people) {
  if (!Number.isInteger(totalCents)) throw new TypeError('totalCents must be a whole number of cents');
  if (!Number.isInteger(people) || people < 1) throw new RangeError('people must be a positive integer');
  const share = Math.round(totalCents / people);
  return Array.from({ length: people }, () => share);
}

module.exports = { splitBill };
