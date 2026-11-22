// The two readers over saved tool output, and the save `safeBash` makes.
// The store itself is lib/runtime/toolOutputStore.ts: text kept in the
// run's globals, so it travels with every checkpoint.
import type { Host } from "../host/host.js";
import { currentRun } from "../runtime/asyncContext.js";
import {
  SPILL_FOLDER_PREFIX,
  findOutput,
  inSpillFolder,
  missingOutputMessage,
  spillFolder,
  spillPath,
  spillPathParts,
  savedPathsInText,
  storeOutput,
  tailNotice,
  type SavedPath,
} from "../runtime/toolOutputStore.js";
import { sliceLines } from "./builtins.js";
import { compileGrepQuery, type GrepQuery } from "./grepQuery.js";
import { firstMatchingLines, type GrepMatch, type GrepResults } from "./shell.js";

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
  const run = currentRun();
  const name = storeOutput(run, text, source);
  const path = spillPath(run.ctx.host, name);
  return tailNotice(text, path, exitCode, MAX_STDOUT_LINES, MAX_STDOUT_LEN);
}

/** A path from the root, on Unix or Windows. */
const ABSOLUTE_PATH = /^([A-Za-z]:)?[\\/]/;

/** The saved text for a name, or for the path a notice gave. */
function saved(nameOrPath: string): string {
  const name = spillPathParts(nameOrPath)?.name ?? nameOrPath;
  const text = findOutput(currentRun(), name);
  if (text === null) {
    throw new Error(missingOutputMessage(name));
  }
  return text;
}

/** The saved output, whole or a slice of lines; the same offset and limit
 *  rules as `read`. Takes the name or the path from the notice. */
export function _readSpill(name: string, offset: number, limit: number): string {
  return sliceLines(saved(name), offset, limit);
}

/** Room kept under `MAX_STDOUT_LEN` for the line that ends a cut page. */
const PAGE_NOTE_CHARS = 500;

/**
 * What `read` returns for a saved output: the lines `offset` and `limit`
 * choose, the whole page under `MAX_STDOUT_LEN` characters, with a last
 * line saying where to read on when it stopped short of the end. A page
 * stays under the tool loop's spill threshold, so the loop does not save
 * it again. A first line too long for the page is cut, and the note says
 * how to read the rest of it.
 */
export function _readSavedOutput(name: string, offset: number, limit: number): string {
  const lines = saved(name).split("\n");
  const budget = MAX_STDOUT_LEN - PAGE_NOTE_CHARS;
  const start = offset > 0 ? offset - 1 : 0;
  const end = limit > 0 ? Math.min(lines.length, start + limit) : lines.length;
  if (start < end && lines[start].length > budget) {
    const line = lines[start];
    const path = spillPath(currentRun().ctx.host, name);
    return `${line.slice(0, budget)}\n... [line ${start + 1} is cut at ${budget} of ${line.length} characters; read the rest of it with a shell command such as: head -n ${start + 1} '${path}' | tail -n 1 | cut -c ${budget + 1}-]`;
  }
  let used = 0;
  let stop = start;
  // A newline is counted only between lines, so a first line of exactly
  // `budget` characters fits, and every page shows at least one line.
  while (stop < end) {
    const cost = lines[stop].length + (stop > start ? 1 : 0);
    if (used + cost > budget) {
      break;
    }
    used += cost;
    stop++;
  }
  const shown = lines.slice(start, stop).join("\n");
  if (stop >= lines.length) {
    return shown;
  }
  return `${shown}\n... [truncated: showing ${start + 1}-${stop} of ${lines.length} lines; read on with offset ${stop + 1}]`;
}

/** One pattern's matches, when a search names several. */
export type PatternMatches = { pattern: string; matches: GrepMatch[] };

function grepOne(text: string, pattern: string, name: string, maxResults: number): GrepMatch[] {
  const query = {
    pattern,
    flags: "",
    ignoreCase: false,
    wholeWord: false,
    filesOnly: false,
    invert: false,
  };
  return searchText(text, name, query, maxResults) as GrepMatch[];
}

/** One text searched the way the grep tool searches one file, with the
 *  same result shape: matches, or the name alone for a files-only query. */
function searchText(text: string, name: string, query: GrepQuery, maxResults: number): GrepResults {
  const plan = compileGrepQuery(query);
  const limit = plan.filesOnly ? 1 : maxResults;
  const matches = firstMatchingLines(text, plan, limit).map((hit) => ({ file: name, ...hit }));
  return plan.filesOnly ? matches.map((match) => match.file) : matches;
}

/** safeBash's in-process grep of a saved output: the same search as
 *  `grepSpill`, with the full query a grep command can carry. */
export function _grepSaved(name: string, query: GrepQuery, maxResults: number): GrepResults {
  return searchText(saved(name), name, query, maxResults);
}

/** safeBash's grep of the text a pipeline stage hands to the next one:
 *  the same search, of a text that has no name, with no limit. */
export function _grepPipedText(text: string, query: GrepQuery): GrepResults {
  return searchText(text, "", query, Number.MAX_SAFE_INTEGER);
}

/** `spillPathParts`, `inSpillFolder` and `savedPathsInText` from the store,
 *  for safeBash's Agency code, which imports only from stdlib-lib. */
export function _spillPathParts(path: string): SavedPath | null {
  return spillPathParts(path);
}

export function _inSpillFolder(path: string): boolean {
  return inSpillFolder(path);
}

export function _savedPathsInText(text: string): SavedPath[] {
  return savedPathsInText(text, spillFolder(currentRun().ctx.host));
}

/** The saved-output name `read(filename, dir)` points at, or null: the
 *  whole path given as `filename`, or the folder given as `dir`. */
export function _savedOutputAt(dir: string, filename: string): string | null {
  const parts =
    spillPathParts(filename) ?? spillPathParts(`${dir.replace(/\/+$/, "")}/${filename}`);
  return parts === null ? null : parts.name;
}

/**
 * Write the copies a shell line names, just before the shell starts. Each
 * copy is rewritten from the store, so what the shell reads is the store's
 * text whatever was on disk before. Throws, and the line does not run, for
 * a name no longer in the store, a path in another machine's folder, or a
 * folder that is not this user's alone.
 */
export async function _prepareSpillFiles(paths: SavedPath[]): Promise<void> {
  const run = currentRun();
  const host = run.ctx.host;
  const here = spillFolder(host);
  for (const { folder, name } of paths) {
    const text = findOutput(run, name);
    if (text === null) {
      throw new Error(missingOutputMessage(name));
    }
    // The copy is written against the process's folder and the shell runs
    // in the agent's, so a relative path could name two different files.
    if (!ABSOLUTE_PATH.test(here)) {
      throw new Error(
        `The temp folder ${here} is not an absolute path, so a copy of saved output written there may not be the file the command reads. Set TMPDIR to an absolute path.`,
      );
    }
    if (folder !== here) {
      throw new Error(`Saved output ${name} is at ${here}${name} on this machine.`);
    }
    await writeCopy(host, name, text);
  }
}

/** The folder is checked every time: another user on the machine could
 *  have made it first, and could then swap a copy for a link between the
 *  write and the shell's read. */
async function writeCopy(host: Host, name: string, text: string): Promise<void> {
  const temp = await host.files.root(host.system.tempDir());
  const folder = `${SPILL_FOLDER_PREFIX}${host.system.userId()}`;
  await host.files.privateDir(temp, folder);
  await host.files.writeText(temp, `${folder}/${name}`, text, {
    mode: "overwrite",
    fileMode: 0o600,
  });
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
