import type { Tag } from "../types/tag.js";

/** The tag name, shared so the check and the "you wrote it somewhere it
 *  cannot attach" warning cannot drift apart. */
export const HIDDEN_TAG = "hidden";

/**
 * `@hidden` keeps a declaration out of a module's reported public surface:
 * out of the pages `agency doc` renders, and out of what `std::agency`'s
 * `describe()` reports.
 *
 * It exists for declarations that are harmless to importers but are not
 * caller-facing — an eval entry node and the input type that only feeds it,
 * for example. Both consumers apply it, so they cannot disagree about what
 * a module's surface is.
 *
 * Reads the tags a declaration already carries, so callers must have run
 * `TypescriptPreprocessor.attachTags()` first.
 */
export function isHidden(tags: Tag[] | undefined): boolean {
  return tags?.some((tag) => tag.name === HIDDEN_TAG) === true;
}
