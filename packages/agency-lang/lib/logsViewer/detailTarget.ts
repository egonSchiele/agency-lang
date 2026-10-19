import { forestOutline, storyOutline, type StoryRow } from "./story.js";
import type { TreeNode } from "./types.js";

/** One row of one trace by id, admin and machinery rows included, so a row
 *  the trace screen is hiding still resolves. The comment anchor, the
 *  session's `navigate`, and the CLI's `show` all use this. */
export function findRow(trace: TreeNode, rowId: string): StoryRow | undefined {
  return resolveDetailRow([trace], rowId);
}

/** Resolve the original id on every parse; event leaf numbers can shift. */
export function resolveDetailRow(roots: TreeNode[], rowId: string): StoryRow | undefined {
  for (const trace of roots) {
    const story = storyOutline(trace, { admin: true }).find((row) => row.id === rowId);
    if (story) {
      return story;
    }
    const raw = forestOutline(trace, { admin: true }).find((row) => row.id === rowId);
    if (raw) {
      return raw;
    }
  }
  return undefined;
}
