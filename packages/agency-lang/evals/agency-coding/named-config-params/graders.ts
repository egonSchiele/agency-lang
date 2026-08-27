import { formatted } from "../lib/formatted.js";
// The holdout scores behaviour. This judge says in words what the holdout
// only shows as "Unknown named argument", so the optimizer learns why.
import { idiomJudge } from "../lib/idiomJudge.js";

export default [
  formatted(),
  idiomJudge({
    name: "settings-are-named-parameters",
    standard: `
    Here is a function whose settings are named parameters with defaults:

    export def search(query: string, limit: number = 10, offset: number = 0, order: string = "none", includeArchived: boolean = false): string[] {
      ...
    }

    Callers pass any setting by name and leave the rest at their defaults, and they can fix a setting with partial application:

    search("blue", order: "year", limit: 2)
    const searchAll = search.partial(includeArchived: true)

    An options object, such as \`search(query: string, options: SearchOptions)\`, supports neither. A named argument for a setting fails with "Unknown named argument", and \`.partial()\` cannot bind a field inside an object.

    Make sure that:
    1. each of limit, offset, order, and includeArchived is its own parameter of search, with the default the assignment gives.
    2. no options object, record type, or configuration parameter carries the settings.

    Both points count equally towards the final score. If the file is not valid Agency, meaning the parser would refuse it, the score is 0.`,
    reference: `import { allRecords } from "./records.agency"

export def search(query: string, limit: number = 10, offset: number = 0, order: string = "none", includeArchived: boolean = false): string[] {
  """
  Search the catalog by title.
  @param query - text the title must contain, case-insensitive
  @param limit - at most this many titles
  @param offset - skip this many matches first
  @param order - "none", "title", or "year"
  @param includeArchived - also return archived records
  """
  const q = query.toLowerCase()
  let matches = [r for r in allRecords() if r.title.toLowerCase().includes(q) && (includeArchived || !r.archived)]
  if (order == "title") { matches = sortBy(matches) as r { return r.title } }
  if (order == "year") { matches = sortBy(matches) as r { return r.year } }
  return [r.title for r in matches].slice(offset, offset + limit)
}`,
  }),
];
