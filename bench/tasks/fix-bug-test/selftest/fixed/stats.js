// Small statistics helpers with no third-party dependencies.

/** Return the arithmetic mean of a non-empty array of numbers. */
function mean(values) {
  if (values.length === 0) throw new RangeError('mean() needs at least one value');
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Return the median of a non-empty array of numbers.
 *
 * For an odd number of values this is the middle value. For an even number
 * of values it is the average of the two middle values.
 */
function median(values) {
  if (values.length === 0) throw new RangeError('median() needs at least one value');
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return ordered[mid];
  return (ordered[mid - 1] + ordered[mid]) / 2;
}

/** Return max - min for a non-empty array of numbers. */
function valueRange(values) {
  if (values.length === 0) throw new RangeError('valueRange() needs at least one value');
  return Math.max(...values) - Math.min(...values);
}

module.exports = { mean, median, valueRange };
