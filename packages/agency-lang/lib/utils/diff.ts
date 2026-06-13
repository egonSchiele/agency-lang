import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

/**
 * Formats a line-based diff between two strings.
 * Deletions (expected) are shown with a "-" prefix, insertions (actual)
 * with a "+" prefix, and equal lines with a "  " prefix.
 * Colorized (red/green/dim) by default; pass `colorize: false` for plain
 * text suitable for files and artifacts.
 */
export function formatDiff(
  expected: string,
  actual: string,
  opts: { colorize?: boolean } = {},
): string {
  const colorize = opts.colorize ?? true;
  const paint = (fn: (text: string) => string, text: string): string =>
    colorize ? fn(text) : text;
  const diffs = dmp.diff_main(expected, actual);
  dmp.diff_cleanupSemantic(diffs);

  const lines: string[] = [];
  for (const [op, text] of diffs) {
    // Split text into individual lines to get per-line prefixes
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (op === DIFF_DELETE) {
        lines.push(paint(color.red, `- ${part}`));
      } else if (op === DIFF_INSERT) {
        lines.push(paint(color.green, `+ ${part}`));
      } else {
        lines.push(paint(color.dim, `  ${part}`));
      }
    }
  }
  return lines.join("\n");
}
