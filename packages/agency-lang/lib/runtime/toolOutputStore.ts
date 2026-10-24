/**
 * Saved tool output: text too long to hand the model in one tool result,
 * kept whole in the run's globals under a name the model can read it back
 * by. It lives beside the fetch cache under the `__internal` module, so it
 * is per run, carried by every checkpoint, copied into a fork branch, and
 * shared by a tool call. See docs/dev/stdlib/spill.md.
 */
import type { Run } from "./asyncContext.js";
import { GlobalStore } from "./state/globalStore.js";
import { toHex } from "../utils/hash.js";

/** One saved output. */
export type SavedOutput = { name: string; text: string };

/** The store: entries oldest first, so eviction drops from the front. */
export type ToolOutputStore = { entries: SavedOutput[] };

const STORE_KEY = "__toolOutput";

/** Characters the store holds across every entry before the oldest goes.
 *  The store rides in every checkpoint, and a hosted resume posts every
 *  interrupt's checkpoint back in one body of at most 10 MB, which an
 *  isolated branch can double. One million characters leaves room for
 *  that, and still holds ten pages of 100 KB. */
export const MAX_STORE_CHARS = 1_000_000;

/** Characters of preview, newlines included, taken from each end of a long
 *  output. Two of these plus the notice around them stay near 2000, so a
 *  preview is never longer than the output it replaces would have been
 *  when cut. */
export const PREVIEW_CHARS = 700;

/** Longest line the preview shows before cutting it. */
export const PREVIEW_LINE_LEN = 200;

/** A saved name: a timestamp, a random suffix, `.log`. The read tools accept
 *  only this shape, which is what keeps a lookup from matching anything
 *  but a name the store issued. */
const OUTPUT_NAME = /^[0-9A-Za-z][0-9A-Za-z_-]*\.log$/;

export function isOutputName(name: string): boolean {
  return OUTPUT_NAME.test(name);
}

/** The two reader tools a model was offered, by the names it sees them
 *  under. `grep` is null when only `readSpill` was offered. */
export type SpillReaders = { read: string; grep: string | null };

/** The names `safeBash` puts in its notice. It does not know the call's
 *  tool list, and `shellTools()` hands the readers out beside it. */
export const DEFAULT_READERS: SpillReaders = { read: "readSpill", grep: "grepSpill" };

const SPILL_MODULE = "stdlib/spill.agency";

export type ToolIdentity = { name: string; module: string; registeredName: string };

/** Whether `tool` is `std::spill`'s reader `reader`. Matched on the module
 *  and the registered name, which a `.rename()` or `.partial()` keeps. */
function isReader(tool: ToolIdentity, reader: "readSpill" | "grepSpill"): boolean {
  return tool.module === SPILL_MODULE && tool.registeredName === reader;
}

/** Whether `tool` reads saved output back. Its own result is already in
 *  the store, so the loop never saves it a second time. */
export function isSpillReader(tool: ToolIdentity): boolean {
  return isReader(tool, "readSpill") || isReader(tool, "grepSpill");
}

/** The readers among `tools`, or null when `readSpill` is not one of
 *  them: then nothing the loop saved could be read back. */
export function spillReaders(tools: ToolIdentity[]): SpillReaders | null {
  const read = tools.find((tool) => isReader(tool, "readSpill"));
  if (read === undefined) return null;
  const grep = tools.find((tool) => isReader(tool, "grepSpill"));
  return { read: read.name, grep: grep === undefined ? null : grep.name };
}

function readStore(run: Run): ToolOutputStore {
  const existing = run.globals.get(GlobalStore.INTERNAL_MODULE, STORE_KEY) as
    ToolOutputStore | undefined;
  if (existing !== undefined) return existing;
  const fresh: ToolOutputStore = { entries: [] };
  run.globals.set(GlobalStore.INTERNAL_MODULE, STORE_KEY, fresh);
  return fresh;
}

function storedChars(store: ToolOutputStore): number {
  return store.entries.reduce((sum, entry) => sum + entry.text.length, 0);
}

function freshName(run: Run): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${toHex(run.ctx.host.random.bytes(3))}.log`;
}

/** Keep `text` whole under a fresh name and return the name. The oldest
 *  entries go first until the new one fits; an entry larger than the whole
 *  cap is kept alone, because the notice will already have promised it. */
export function storeOutput(run: Run, text: string): string {
  const store = readStore(run);
  while (store.entries.length > 0 && storedChars(store) + text.length > MAX_STORE_CHARS) {
    store.entries.shift();
  }
  const name = freshName(run);
  store.entries.push({ name, text });
  return name;
}

/** The saved text, or null when the name is not in the store: evicted, saved
 *  before a checkpoint this run resumed from, or saved by another run. */
export function findOutput(run: Run, name: string): string | null {
  if (!isOutputName(name)) return null;
  const hit = readStore(run).entries.find((entry) => entry.name === name);
  return hit === undefined ? null : hit.text;
}

/** What a reader says about a name it cannot find. One message for every
 *  cause, since the model can do the same thing about each. */
export function missingOutputMessage(name: string): string {
  if (!isOutputName(name)) {
    return `'${name}' is not a saved output name: expected the name from a "full output saved as" notice, with no directory part`;
  }
  return `Saved output ${name} is no longer available. Call the tool again if you need it.`;
}

function cutLine(line: string): string {
  return line.length > PREVIEW_LINE_LEN ? line.slice(0, PREVIEW_LINE_LEN) + "…" : line;
}

/** Lines from the start until the preview budget is spent. Always at least
 *  one line, so a single enormous line still shows its beginning. */
function previewHead(lines: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const shown = cutLine(line);
    if (out.length > 0 && used + shown.length + 1 > PREVIEW_CHARS) return out;
    out.push(shown);
    used += shown.length + 1;
  }
  return out;
}

/** Lines from the end until the preview budget is spent, never reaching
 *  back into the lines the head already showed. */
function previewTail(lines: string[], skip: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= skip; index--) {
    const shown = cutLine(lines[index]);
    if (out.length > 0 && used + shown.length + 1 > PREVIEW_CHARS) return out;
    out.unshift(shown);
    used += shown.length + 1;
  }
  return out;
}

/**
 * The preview that stands in for a long output: what happened, a glimpse of
 * both ends, the name it was saved under, and how to read the rest with
 * `readers`. `exitCode` is null for a tool result that is not a command's
 * output.
 */
export function outputNotice(
  text: string,
  name: string,
  exitCode: number | null,
  readers: SpillReaders,
): string {
  const lines = text.split("\n");
  const head = previewHead(lines);
  const tail = previewTail(lines, head.length);
  const exit = exitCode === null ? "" : ` Command exited with code ${exitCode}.`;
  const search =
    readers.grep === null
      ? " It needs no approval."
      : ` To search it, use ${readers.grep}(pattern, filename: "${name}"). Neither needs approval.`;
  return [
    `[Output too long to return in full: ${lines.length} lines, ${text.length} characters.${exit}]`,
    `--- first ${head.length} lines ---`,
    head.join("\n"),
    `--- last ${tail.length} lines ---`,
    tail.join("\n"),
    `--- full output saved as ${name} ---`,
    `To read it, use the ${readers.read} tool: ${readers.read}(filename: "${name}"), with offset and limit to take a slice.${search}`,
  ].join("\n");
}
