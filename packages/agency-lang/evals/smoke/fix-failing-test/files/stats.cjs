// A tiny statistics helper. One of these functions is wrong.

/** The middle value of a list of numbers (the mean of the middle two when the
 *  list has an even length). */
function median(numbers) {
  if (numbers.length === 0) {
    throw new Error("median of an empty list is undefined");
  }
  const sorted = [...numbers].sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** The arithmetic mean of a list of numbers. */
function mean(numbers) {
  if (numbers.length === 0) {
    throw new Error("mean of an empty list is undefined");
  }
  return numbers.reduce((total, n) => total + n, 0) / numbers.length;
}

module.exports = { median, mean };
