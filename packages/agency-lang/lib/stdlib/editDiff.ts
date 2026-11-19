// An edit's diff as data for a front-end to draw: `_diffTokens` with the
// options an approval needs, limits on how much it will diff, and tokens
// that never split a character. The session core emits one for every edit
// (`session.editDiff`), and a front-end makes the one on an approval with
// this same function.
import { _diffTokens } from "./syntax.js";

/** A piece of a line. `scope` is null: the diff is made with no language,
 *  and a client colors the lines itself. `changed` marks a word that
 *  changed from the line it replaced. */
export type EditToken = { text: string; scope: string | null; changed: boolean };

/** One line of a diff: unchanged ("context"), removed or added, with its
 *  number on each side it exists on, counting from 1. */
export type EditLine = {
  kind: "context" | "delete" | "insert";
  oldNumber: number | null;
  newNumber: number | null;
  tokens: EditToken[];
};

/** A run of changed lines and the unchanged lines around them. */
export type EditHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: EditLine[];
};

/** The longest pair of texts diffed. A caller may run on a thread that
 *  every session of an app shares. */
export const MAX_DIFF_INPUT_CHARS = 200_000;
/** The longest line diffed. Each replaced line gets a word diff whose
 *  cleanup has no time limit, so one long line (a minified bundle, a
 *  lockfile) could hold the thread for seconds. */
export const MAX_DIFF_LINE_CHARS = 5_000;

/** The most word-diff work for one edit: the sum, over the lines only one
 *  side has, of each line's length squared. Each replaced line gets a word
 *  diff whose cost grows about with the square of its length, so many long
 *  changed lines (rewritten paragraphs) are slow even when each is under
 *  MAX_DIFF_LINE_CHARS. At this budget a diff takes about 100 ms at worst. */
export const MAX_DIFF_WORD_WORK = 16_000_000;

/** 3 lines of context, as `agency agent` shows an approval's diff, and
 *  every change, whitespace included, as it does from agency-lang#1504. An
 *  approval must show what it approves, and spacing changes what code does
 *  in Python and YAML, and inside strings. */
const CONTEXT_LINES = 3;
const IGNORE_WHITESPACE = false;
/** No language: a client colors the lines itself. */
const NO_LANGUAGE = "";

const CRLF = /\r\n/g;

function longestLine(text: string): number {
  return text.split("\n").reduce((longest, line) => Math.max(longest, line.length), 0);
}

/** How many times `line` occurs, from `counts`. A line is any text, so it
 *  can be named like an Object.prototype key (`constructor`); only the
 *  object's own keys count, or an inherited function would make the work
 *  NaN, and NaN passes every budget. */
function countOf(counts: Record<string, number>, line: string): number {
  return Object.hasOwn(counts, line) ? (counts[line] ?? 0) : 0;
}

/** How many times each line occurs in a text. */
function lineCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of text.split("\n")) {
    counts[line] = countOf(counts, line) + 1;
  }
  return counts;
}

/** The word-diff work of the lines `text` has more of than `other`. */
function changedWork(text: Record<string, number>, other: Record<string, number>): number {
  return Object.entries(text).reduce((work, [line, count]) => {
    const extra = Math.max(0, count - countOf(other, line));
    return work + extra * line.length * line.length;
  }, 0);
}

function isTooBig(before: string, after: string): boolean {
  if (longestLine(before) > MAX_DIFF_LINE_CHARS || longestLine(after) > MAX_DIFF_LINE_CHARS) {
    return true;
  }
  const oldCounts = lineCounts(before);
  const newCounts = lineCounts(after);
  return changedWork(oldCounts, newCounts) + changedWork(newCounts, oldCounts) > MAX_DIFF_WORD_WORK;
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The tokens with no character cut in two. Agency's word diff works on
 *  UTF-16 units and can end a token with the first half of an emoji; that
 *  half moves to the next token, which holds the second. */
function wholeCharacters(tokens: EditToken[]): EditToken[] {
  const whole: EditToken[] = [];
  let carried = "";
  for (const token of tokens) {
    const text = carried + token.text;
    carried = HIGH_SURROGATE.test(text) ? text.slice(-1) : "";
    const kept = carried === "" ? text : text.slice(0, -1);
    if (kept !== "") {
      whole.push({ ...token, text: kept });
    }
  }
  return carried === "" ? whole : [...whole, { text: carried, scope: null, changed: false }];
}

/** A hunk the app can decode: every token a well-formed string. */
function isWellFormed(hunk: EditHunk): boolean {
  return hunk.lines.every((line) => line.tokens.every((token) => !LONE_SURROGATE.test(token.text)));
}

/** Agency's diff, or none when it throws (past 65,535 distinct lines). */
function agencyDiff(oldText: string, newText: string): ReturnType<typeof _diffTokens> {
  try {
    return _diffTokens(oldText, newText, CONTEXT_LINES, IGNORE_WHITESPACE, NO_LANGUAGE);
  } catch {
    return [];
  }
}

/** The hunks of an edit, or none when there is nothing to show: no
 *  change, an edit that won't apply (both texts empty), texts that
 *  aren't texts, texts too big to diff here, or a diff Agency can't
 *  compute. With no hunks, a front-end shows the edit's raw details
 *  instead. Windows line endings are read as plain ones, so a `\r` doesn't
 *  show escaped at the end of every line. */
export function editDiff(before: unknown, after: unknown): EditHunk[] {
  if (typeof before !== "string" || typeof after !== "string") {
    return [];
  }
  if (before.length + after.length > MAX_DIFF_INPUT_CHARS) {
    return [];
  }
  const oldText = before.replace(CRLF, "\n");
  const newText = after.replace(CRLF, "\n");
  if (isTooBig(oldText, newText)) {
    return [];
  }
  const hunks = agencyDiff(oldText, newText).map((hunk): EditHunk => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map((line) => ({
      kind: line.kind,
      oldNumber: line.oldNumber,
      newNumber: line.newNumber,
      tokens: wholeCharacters(
        line.tokens.map((token) => ({
          text: token.text,
          scope: token.scope,
          changed: token.changed,
        })),
      ),
    })),
  }));
  // A token still not well formed would make the app drop the whole diff,
  // while the card has left the edit's details out for it. No hunks shows
  // the details instead.
  return hunks.every(isWellFormed) ? hunks : [];
}
