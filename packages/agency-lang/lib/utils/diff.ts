import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

/**
 * Formats a colored, line-based diff between two strings.
 * Deletions (expected) are shown in red with a "-" prefix.
 * Insertions (actual) are shown in green with a "+" prefix.
 * Equal lines are shown dimmed with a "  " prefix.
 */
export function formatDiff(expected: string, actual: string): string {
  const diffs = dmp.diff_main(expected, actual);
  dmp.diff_cleanupSemantic(diffs);

  const lines: string[] = [];
  for (const [op, text] of diffs) {
    // Split text into individual lines to get per-line prefixes
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (op === DIFF_DELETE) {
        lines.push(color.red(`- ${part}`));
      } else if (op === DIFF_INSERT) {
        lines.push(color.green(`+ ${part}`));
      } else {
        lines.push(color.dim(`  ${part}`));
      }
    }
  }
  return lines.join("\n");
}
