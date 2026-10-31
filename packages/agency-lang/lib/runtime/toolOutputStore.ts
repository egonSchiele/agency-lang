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

/** One saved output. `source` is what produced it, for a human: the command
 *  that ran, or the tool and its first string argument. Entries saved before
 *  the field existed have none. */
export type SavedOutput = { name: string; text: string; source?: string };

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
 *  output. Two of these plus the notice around them stay near 2000, under
 *  `safeBash`'s own limit. A tool loop with a smaller `maxToolResultChars`
 *  passes it to `outputNotice`, which shrinks the preview to fit. */
export const PREVIEW_CHARS = 700;

/** Longest line the preview shows before cutting it. */
export const PREVIEW_LINE_LEN = 200;

/** Longest source kept beside a saved output. */
export const SPILL_SOURCE_CHARS = 80;

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

/** The source as the store keeps it and the notice shows it; null when the
 *  caller gave none (an empty string). */
export function spillSourceLabel(source: string | null): string | null {
  if (source === null || source === "") return null;
  return source.slice(0, SPILL_SOURCE_CHARS);
}

/** Keep `text` whole under a fresh name and return the name. The oldest
 *  entries go first until the new one fits; an entry larger than the whole
 *  cap is kept alone, because the notice will already have promised it. */
export function storeOutput(run: Run, text: string, source: string): string {
  const store = readStore(run);
  while (store.entries.length > 0 && storedChars(store) + text.length > MAX_STORE_CHARS) {
    store.entries.shift();
  }
  const name = freshName(run);
  const label = spillSourceLabel(source);
  store.entries.push(label === null ? { name, text } : { name, text, source: label });
  return name;
}

function findEntry(run: Run, name: string): SavedOutput | null {
  if (!isOutputName(name)) return null;
  return readStore(run).entries.find((entry) => entry.name === name) ?? null;
}

/** The saved text, or null when the name is not in the store: evicted, saved
 *  before a checkpoint this run resumed from, or saved by another run. */
export function findOutput(run: Run, name: string): string | null {
  return findEntry(run, name)?.text ?? null;
}

/** What produced the saved output, or null when the name is not in the
 *  store or the entry was saved before sources were kept. */
export function findOutputSource(run: Run, name: string): string | null {
  return findEntry(run, name)?.source ?? null;
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

/** Lines from the start until `budget` characters are spent. At the
 *  default budget the first line always fits, because `cutLine` keeps it
 *  under `PREVIEW_LINE_LEN`, so a single enormous line still shows its
 *  beginning. Under a small budget the preview can be empty. */
function previewHead(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const shown = cutLine(line);
    if (used + shown.length + 1 > budget) return out;
    out.push(shown);
    used += shown.length + 1;
  }
  return out;
}

/** Lines from the end until `budget` characters are spent, never reaching
 *  back into the lines the head already showed. */
function previewTail(lines: string[], skip: number, budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= skip; index--) {
    const shown = cutLine(lines[index]);
    if (used + shown.length + 1 > budget) return out;
    out.unshift(shown);
    used += shown.length + 1;
  }
  return out;
}

/**
 * The preview that stands in for a long output: what happened, a glimpse of
 * both ends, the name it was saved under, and how to read the rest with
 * `readers`. `exitCode` is null for a tool result that is not a command's
 * output. The preview shrinks so the notice fits in `maxChars`; only when
 * the text around the preview is longer than that on its own does the
 * notice come out longer, and the caller cuts it. `source` names what
 * produced the output in the first line.
 */
export function outputNotice(
  text: string,
  name: string,
  exitCode: number | null,
  readers: SpillReaders,
  maxChars: number = Infinity,
  source: string | null = null,
): string {
  const lines = text.split("\n");
  const label = spillSourceLabel(source);
  const of = label === null ? "" : ` of "${label}"`;
  const exit = exitCode === null ? "" : ` Command exited with code ${exitCode}.`;
  const search =
    readers.grep === null
      ? " It needs no approval."
      : ` To search it, use ${readers.grep}(pattern, filename: "${name}"). Neither needs approval.`;
  const notice = (head: string[], tail: string[], headCount: number, tailCount: number) =>
    [
      `[Output${of} too long to return in full: ${lines.length} lines, ${text.length} characters.${exit}]`,
      `--- first ${headCount} lines ---`,
      head.join("\n"),
      `--- last ${tailCount} lines ---`,
      tail.join("\n"),
      `--- full output saved as ${name} ---`,
      `To read it, use the ${readers.read} tool: ${readers.read}(filename: "${name}"), with offset and limit to take a slice.${search}`,
    ].join("\n");
  // The line counts are not known until the preview is built, so the text
  // around it is measured with both at their largest.
  const around = notice([], [], lines.length, lines.length).length;
  const budget = Math.min(PREVIEW_CHARS, Math.floor((maxChars - around) / 2));
  const head = previewHead(lines, budget);
  const tail = previewTail(lines, head.length, budget);
  return notice(head, tail, head.length, tail.length);
}
