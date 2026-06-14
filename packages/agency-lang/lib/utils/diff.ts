import DiffMatchPatch from "diff-match-patch";
import { color } from "./termcolors.js";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

const dmp = new DiffMatchPatch();

type Diff = [number, string];

/**
 * Split a run of whole lines (as produced by the line-mode diff) into
 * individual lines. The trailing empty string left by a final newline is an
 * artifact of the split, not a real line, so we drop it.
 */
function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Compute a line-level diff. By diffing on a per-line basis (rather than the
 * character/word level), each chunk of output is a whole line, so a single
 * logical line is never broken across multiple output lines.
 *
 * Uses diff-match-patch's line-mode recipe: encode each unique line as a
 * single char, diff the encoded strings, then decode back to lines. We do
 * NOT run `diff_cleanupSemantic` here — that operates on the encoded
 * sentinel chars and would corrupt the decoding.
 */
function lineModeDiff(expected: string, actual: string): Diff[] {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(expected, actual);
  const diffs = dmp.diff_main(chars1, chars2, false) as Diff[];
  dmp.diff_charsToLines_(diffs, lineArray);
  return diffs;
}

/**
 * Render one line of a replacement (a deleted line paired with an inserted
 * line) with the changed words highlighted. A word-level diff between the two
 * lines decides which spans changed: unchanged words are dimmed, and the
 * words specific to `side` are painted red (deletions) or green (insertions).
 *
 * `side` is DIFF_DELETE to render the old line, DIFF_INSERT for the new one.
 */
function highlightLine(oldLine: string, newLine: string, side: number): string {
  const prefix = side === DIFF_DELETE ? "- " : "+ ";
  const sideColor = side === DIFF_DELETE ? color.red : color.green;
  const wordDiffs = dmp.diff_main(oldLine, newLine) as Diff[];
  dmp.diff_cleanupSemantic(wordDiffs);

  let body = "";
  for (const [op, text] of wordDiffs) {
    if (op === DIFF_EQUAL) {
      body += color.dim(text);
    } else if (op === side) {
      body += sideColor(text);
    }
    // Segments belonging to the other side are omitted from this line.
  }
  return sideColor(prefix) + body;
}

/**
 * Render a replacement block: `del` lines (removed) paired against `ins`
 * lines (added). Following unified-diff convention, all `-` lines are emitted
 * first, then all `+` lines. When colorized, paired lines get intra-line word
 * highlighting (see `highlightLine`); unpaired extras and the plain-text mode
 * fall back to whole-line coloring.
 */
function renderReplacement(out: string[], del: string[], ins: string[], colorize: boolean): void {
  const paired = Math.min(del.length, ins.length);
  for (let k = 0; k < del.length; k++) {
    if (colorize && k < paired) out.push(highlightLine(del[k], ins[k], DIFF_DELETE));
    else out.push(colorize ? color.red(`- ${del[k]}`) : `- ${del[k]}`);
  }
  for (let k = 0; k < ins.length; k++) {
    if (colorize && k < paired) out.push(highlightLine(del[k], ins[k], DIFF_INSERT));
    else out.push(colorize ? color.green(`+ ${ins[k]}`) : `+ ${ins[k]}`);
  }
}

/**
 * Formats a line-based diff between two strings.
 *
 * The diff is computed at line granularity, so a single logical line is never
 * split across multiple output lines. Deleted lines are shown with a "-"
 * prefix (red), inserted lines with a "+" prefix (green), and unchanged lines
 * with a "  " prefix (dim). When a deleted line is immediately replaced by an
 * inserted one, the specific words that changed are highlighted within each
 * line while the rest of the line is dimmed.
 *
 * Colorized by default; pass `colorize: false` for plain text suitable for
 * files and artifacts (in that mode replacements degrade to whole `-`/`+`
 * lines with no word-level highlighting and no ANSI codes).
 */
export function formatDiff(
  expected: string,
  actual: string,
  opts: { colorize?: boolean } = {},
): string {
  const colorize = opts.colorize ?? true;
  const paint = (fn: (text: string) => string, text: string): string =>
    colorize ? fn(text) : text;

  const diffs = lineModeDiff(expected, actual);
  const out: string[] = [];

  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i];
    if (op === DIFF_EQUAL) {
      for (const line of splitLines(text)) out.push(paint(color.dim, `  ${line}`));
    } else if (op === DIFF_DELETE) {
      const next = diffs[i + 1];
      if (next && next[0] === DIFF_INSERT) {
        // A deletion immediately followed by an insertion is a replacement:
        // render them together so changed words can be highlighted in place.
        renderReplacement(out, splitLines(text), splitLines(next[1]), colorize);
        i++; // consume the paired INSERT
      } else {
        for (const line of splitLines(text)) out.push(paint(color.red, `- ${line}`));
      }
    } else {
      // A standalone insertion (not preceded by a consumed deletion).
      for (const line of splitLines(text)) out.push(paint(color.green, `+ ${line}`));
    }
  }

  return out.join("\n");
}
