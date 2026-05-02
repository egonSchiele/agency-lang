import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

/**
 * Formats expected vs actual for failed test output.
 *
 * Always prints both full strings (labelled) so the failure is readable
 * regardless of how the inline diff renders. If the strings differ, an
 * inline diff is appended below with `[-deleted-]` / `{+inserted+}` markers.
 */
export function formatDiff(expected: string, actual: string): string {
  const out: string[] = [];
  out.push(color.dim("  Expected: ") + expected);
  out.push(color.dim("  Actual:   ") + actual);

  const diffs = dmp.diff_main(expected, actual);
  dmp.diff_cleanupSemantic(diffs);

  const hasChange = diffs.some(([op]) => op !== DIFF_EQUAL);
  if (!hasChange) return out.join("\n");

  out.push(color.dim("  Diff:"));
  let inline = "  ";
  for (const [op, text] of diffs) {
    if (op === DIFF_DELETE) {
      inline += color.red(`[-${text}-]`);
    } else if (op === DIFF_INSERT) {
      inline += color.green(`{+${text}+}`);
    } else {
      inline += color.dim(text);
    }
  }
  out.push(inline);
  return out.join("\n");
}
