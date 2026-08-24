import type { Tag } from "../types/tag.js";

export const HIDDEN_TAG = "hidden";

/** `@hidden` keeps a declaration out of `agency doc` and out of
 *  `std::agency`'s `describe()`. Reads tags the preprocessor attached. */
export function isHidden(tags: Tag[] | undefined): boolean {
  return tags?.some((tag) => tag.name === HIDDEN_TAG) === true;
}
