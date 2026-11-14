// The two readers over saved tool output, and the save `safeBash` makes.
// The store itself is lib/runtime/toolOutputStore.ts: text kept in the
// run's globals, so it travels with every checkpoint.
import { currentRun } from "../runtime/asyncContext.js";
import {
  DEFAULT_READERS,
  findOutput,
  missingOutputMessage,
  storeOutput,
  tailNotice,
} from "../runtime/toolOutputStore.js";
import { sliceLines } from "./builtins.js";
import { compileGrepQuery } from "./grepQuery.js";
import { firstMatchingLines, type GrepMatch } from "./shell.js";

/** How much of a command's output comes back inline: this many characters
 *  and `MAX_STDOUT_LINES` lines, whichever is reached first. Anything
 *  longer is saved, and its last lines come back. */
export const MAX_STDOUT_LEN = 50_000;
export const MAX_STDOUT_LINES = 2_000;

function lineCount(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

/** What the model gets back for a command's output: short output as
 *  printed, long output saved under `source` (the command that ran) and
 *  replaced by its last lines and a notice. An empty source means none
 *  was given. */
export function _keepOutput(text: string, exitCode: number | null, source: string = ""): string {
  if (text.length <= MAX_STDOUT_LEN && lineCount(text) <= MAX_STDOUT_LINES) return text;
  const name = storeOutput(currentRun(), text, source);
  return tailNotice(text, name, exitCode, DEFAULT_READERS, MAX_STDOUT_LINES, MAX_STDOUT_LEN);
}

function saved(name: string): string {
  const text = findOutput(currentRun(), name);
  if (text === null) throw new Error(missingOutputMessage(name));
  return text;
}

/** The saved output, whole or a slice of lines; the same offset and limit
 *  rules as `read`. */
export function _readSpill(name: string, offset: number, limit: number): string {
  return sliceLines(saved(name), offset, limit);
}

/** One pattern's matches, when a search names several. */
export type PatternMatches = { pattern: string; matches: GrepMatch[] };

function grepOne(text: string, pattern: string, name: string, maxResults: number): GrepMatch[] {
  const plan = compileGrepQuery({
    pattern,
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: false,
    invert: false,
  });
  return firstMatchingLines(text, plan, maxResults).map((hit) => ({ file: name, ...hit }));
}

/** Lines matching `pattern` in one saved output. With `morePatterns`,
 *  every pattern is searched and the matches come back grouped by pattern,
 *  `maxResults` for each, so one call can cover several topics. */
export function _grepSpill(
  pattern: string,
  name: string,
  maxResults: number,
  morePatterns: string[] = [],
): GrepMatch[] | PatternMatches[] {
  const text = saved(name);
  if (morePatterns.length === 0) {
    return grepOne(text, pattern, name, maxResults);
  }
  return [pattern, ...morePatterns].map((each) => ({
    pattern: each,
    matches: grepOne(text, each, name, maxResults),
  }));
}
