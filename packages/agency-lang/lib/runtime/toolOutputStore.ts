/**
 * Saved tool output: text too long to hand the model in one tool result,
 * kept whole in the run's globals under a name the model can read it back
 * by. It lives beside the fetch cache under the `__internal` module, so it
 * is per run, carried by every checkpoint, copied into a fork branch, and
 * shared by a tool call. See docs/dev/stdlib/spill.md.
 */
import type { Host } from "../host/host.js";
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

/** The start of the saved-output folder's name; the user id follows. */
export const SPILL_FOLDER_PREFIX = "agency-spill-";

const SPILL_FOLDER_NAME = new RegExp(`^${SPILL_FOLDER_PREFIX}[0-9]+$`);

/** A saved output named by path: the folder part as written, with its
 *  trailing separator, and the saved name. */
export type SavedPath = { folder: string; name: string };

/** The folder a run's saved outputs are copied into: the temp folder, then
 *  `agency-spill-<user id>`, with a trailing separator. The spelling is the
 *  temp folder as the host gives it, never a real path, so the notices and
 *  the check in `prepareSpillFiles` compare the same text. */
export function spillFolder(host: Host): string {
  const temp = host.system.tempDir().replace(/\/+$/, "");
  return `${temp}/${SPILL_FOLDER_PREFIX}${host.system.userId()}/`;
}

/** The saved output a path names, or null. The whole path must end in an
 *  `agency-spill-<id>` folder and a saved-output name, whatever comes
 *  before, so a path written on another machine is recognized too. */
export function spillPathParts(path: string): SavedPath | null {
  const parts = path.split("/");
  if (parts.length < 2) {
    return null;
  }
  const name = parts[parts.length - 1];
  if (!isOutputName(name) || !SPILL_FOLDER_NAME.test(parts[parts.length - 2])) {
    return null;
  }
  return { folder: path.slice(0, path.length - name.length), name };
}

/** Whether a path is an `agency-spill-<id>` folder or anything below one,
 *  judged by its parts, so a real spelling such as `/private/var/…` counts. */
export function inSpillFolder(path: string): boolean {
  return path.split("/").some((part) => SPILL_FOLDER_NAME.test(part));
}

/** A character that ends a word in shell text. */
const SHELL_SEPARATOR = /[\s'"`;|&<>()]/;

/** Every saved-output path in raw command text: each word that holds the
 *  folder prefix, taken whole between shell separators, so a longer path
 *  that starts the same way does not count. Each word is scanned once,
 *  so a long line costs time in proportion to its length. */
export function spillPathsIn(text: string): SavedPath[] {
  const found: SavedPath[] = [];
  let at = text.indexOf(SPILL_FOLDER_PREFIX);
  while (at !== -1) {
    let start = at;
    while (start > 0 && !SHELL_SEPARATOR.test(text[start - 1])) {
      start--;
    }
    let end = at;
    while (end < text.length && !SHELL_SEPARATOR.test(text[end])) {
      end++;
    }
    const parts = spillPathParts(text.slice(start, end));
    if (parts !== null) {
      found.push(parts);
    }
    at = text.indexOf(SPILL_FOLDER_PREFIX, end);
  }
  return found;
}

/** How the last line of `outputNotice` starts; the trace finds the end of
 *  a notice by it. */
export const SPILL_NOTICE_LAST_LINE = "--- full output saved as a file: ";

/** The path a notice gives for a saved output on this run's host. */
export function spillPath(host: Host, name: string): string {
  return `${spillFolder(host)}${name}`;
}

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
  // Reading a saved output back (`cat` of its path, or `read`) would
  // otherwise save it again, and a second copy of a large output pushes
  // the first one out.
  const same = store.entries.find((entry) => entry.text === text);
  if (same !== undefined) return same.name;
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
    return `'${name}' is not a saved output: expected the path or the name from a "saved as a file" notice`;
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
 * What stands in for a command's long output: its last lines, up to
 * `maxLines` lines and `maxChars` characters, then one line saying which
 * lines those are and the path the whole output can be read at. The notice
 * names no tool: each reader says in its own description that it takes the
 * path. The end is kept because a command that prints a lot says how it
 * went in its last lines: a test summary, a compiler's error count.
 * `exitCode` is null when there is none to show.
 */
export function tailNotice(
  text: string,
  path: string,
  exitCode: number | null,
  maxLines: number,
  maxChars: number,
): string {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let start = lines.length;
  let used = 0;
  while (start > 0 && lines.length - start < maxLines) {
    const next = lines[start - 1].length + 1;
    if (used + next > maxChars) break;
    used += next;
    start--;
  }
  const exit = exitCode === null ? "" : ` Command exited with code ${exitCode}.`;
  // The path is followed by a space, so it can be copied without punctuation.
  const rest = `The full output is saved as a file: ${path} (read it like any file).${exit}`;
  const total = lines.length;
  if (start === total) {
    // The last line alone is longer than the limit, so show its end.
    return `${lines[total - 1].slice(-maxChars)}\n\n[Showing the last ${maxChars} characters of line ${total} of ${total}. ${rest}]`;
  }
  return `${lines.slice(start).join("\n")}\n\n[Showing lines ${start + 1}-${total} of ${total}. ${rest}]`;
}

/**
 * The preview that stands in for a long output: what happened, a glimpse of
 * both ends, and the path the whole output can be read at. `exitCode` is
 * null for a tool result that is not a command's output. The preview
 * shrinks so the notice fits in `maxChars`; only when the text around the
 * preview is longer than that on its own does the notice come out longer,
 * and the caller cuts it. `source` names what produced the output in the
 * first line.
 */
export function outputNotice(
  text: string,
  path: string,
  exitCode: number | null,
  maxChars: number = Infinity,
  source: string | null = null,
): string {
  const lines = text.split("\n");
  const label = spillSourceLabel(source);
  const of = label === null ? "" : ` of "${label}"`;
  const exit = exitCode === null ? "" : ` Command exited with code ${exitCode}.`;
  const notice = (head: string[], tail: string[], headCount: number, tailCount: number) =>
    [
      `[Output${of} too long to return in full: ${lines.length} lines, ${text.length} characters.${exit}]`,
      `--- first ${headCount} lines ---`,
      head.join("\n"),
      `--- last ${tailCount} lines ---`,
      tail.join("\n"),
      `${SPILL_NOTICE_LAST_LINE}${path} (read it like any file) ---`,
    ].join("\n");
  // The line counts are not known until the preview is built, so the text
  // around it is measured with both at their largest.
  const around = notice([], [], lines.length, lines.length).length;
  const budget = Math.min(PREVIEW_CHARS, Math.floor((maxChars - around) / 2));
  const head = previewHead(lines, budget);
  const tail = previewTail(lines, head.length, budget);
  return notice(head, tail, head.length, tail.length);
}
