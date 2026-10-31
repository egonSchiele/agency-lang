// The two readers over saved tool output, and the save `safeBash` makes.
// The store itself is lib/runtime/toolOutputStore.ts: text kept in the
// run's globals, so it travels with every checkpoint.
import { currentRun } from "../runtime/asyncContext.js";
import {
  DEFAULT_READERS,
  findOutput,
  missingOutputMessage,
  outputNotice,
  storeOutput,
} from "../runtime/toolOutputStore.js";
import { sliceLines } from "./builtins.js";
import { compileGrepQuery } from "./grepQuery.js";
import { firstMatchingLines, type GrepMatch } from "./shell.js";

/** How much of a command's output comes back inline. Anything longer is
 *  saved and replaced by a preview. */
export const MAX_STDOUT_LEN = 2000;

/** What the model gets back for a command's output: short output as
 *  printed, long output saved under `source` (the command that ran) and
 *  replaced by the notice. An empty source means none was given. */
export function _keepOutput(text: string, exitCode: number, source: string = ""): string {
  if (text.length <= MAX_STDOUT_LEN) return text;
  const run = currentRun();
  const name = storeOutput(run, text, source);
  // The notice fits the same cap as inline output, so a long source never
  // pushes it past what a short command would have returned.
  return outputNotice(text, name, exitCode, DEFAULT_READERS, MAX_STDOUT_LEN, source);
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
