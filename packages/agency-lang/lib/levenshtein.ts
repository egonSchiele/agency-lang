/** Classic Levenshtein edit distance (deterministic, dependency-free). */
export function levenshtein(left: string, right: string): number {
  const columnCount = right.length + 1;
  let previousRow = Array.from({ length: columnCount }, (_unused, columnIndex) => columnIndex);
  for (let rowIndex = 1; rowIndex <= left.length; rowIndex += 1) {
    const currentRow = [rowIndex];
    for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
      const cost = left[rowIndex - 1] === right[columnIndex - 1] ? 0 : 1;
      currentRow[columnIndex] = Math.min(
        previousRow[columnIndex] + 1,
        currentRow[columnIndex - 1] + 1,
        previousRow[columnIndex - 1] + cost,
      );
    }
    previousRow = currentRow;
  }
  return previousRow[columnCount - 1];
}
