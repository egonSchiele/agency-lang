// Tab completion for a file mention such as `@lib/ag` at the end of a REPL
// line. The listing is passed in, so the rules are tested without a disk.
import type { Entry } from "../host/host.js";

/** One level of a directory, relative to the REPL's working directory.
 *  Returns an empty list for a directory that cannot be read. */
export type ListDir = (dir: string) => Promise<Entry[]>;

const MENTION_MARK = "@";

/** The mention the cursor is in: the last word of `line` when it starts
 *  with `@`, or null. A word ends at a space. */
export function mentionAtEnd(line: string): string | null {
  const word = line.slice(line.lastIndexOf(" ") + 1);
  return word.startsWith(MENTION_MARK) ? word : null;
}

type SplitPath = { dir: string; prefix: string };

/** `lib/ag` is the directory `lib/` and the name prefix `ag`. */
function splitPath(partial: string): SplitPath {
  const slash = partial.lastIndexOf("/");
  return { dir: partial.slice(0, slash + 1), prefix: partial.slice(slash + 1) };
}

/** Dot files are offered only once the user has typed the dot. */
function offered(entry: Entry, prefix: string): boolean {
  if (!entry.name.startsWith(prefix)) {
    return false;
  }
  return prefix.startsWith(".") || !entry.name.startsWith(".");
}

/** The completions for `mention`, each a whole mention. A directory ends
 *  with `/` so the next Tab completes inside it. */
export async function completeMention(mention: string, listDir: ListDir): Promise<string[]> {
  const { dir, prefix } = splitPath(mention.slice(MENTION_MARK.length));
  const entries = await listDir(dir === "" ? "." : dir);
  return entries
    .filter((entry) => offered(entry, prefix))
    .map((entry) => `${MENTION_MARK}${dir}${entry.name}${entry.type === "dir" ? "/" : ""}`)
    .sort();
}
