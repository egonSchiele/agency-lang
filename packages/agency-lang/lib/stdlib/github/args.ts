// Argument checks the Agency functions run BEFORE raising their interrupt,
// so the payload a handler judges is exactly what goes on the wire.

/** GitHub rejects per_page above 100. */
export const GITHUB_MAX_PER_PAGE = 100;

function wholeNumberAtLeastOne(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(Math.floor(value), 1);
}

/** perPage clamped into [1, GITHUB_MAX_PER_PAGE]. */
export function _ghClampPerPage(perPage: number): number {
  return Math.min(wholeNumberAtLeastOne(perPage), GITHUB_MAX_PER_PAGE);
}

/** page clamped to a whole number of at least 1. */
export function _ghClampPage(page: number): number {
  return wholeNumberAtLeastOne(page);
}

/** Paging as the query fields GitHub expects. Endpoint declarations spread
 *  this into their query objects. */
export function pagingQuery(perPage: number, page: number): Record<string, string> {
  return { per_page: String(_ghClampPerPage(perPage)), page: String(_ghClampPage(page)) };
}

/** Throws unless `number` is a positive whole number: an issue or pull
 *  request number. The tool schema only checks that it is a number. */
export function _ghCheckNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Expected a positive whole issue or pull request number, got ${number}`);
  }
}
