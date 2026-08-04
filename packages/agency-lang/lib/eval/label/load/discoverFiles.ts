import * as fs from "fs";
import * as path from "path";

import { IngestSourceError } from "./types.js";

/** One candidate file, already classified. Symlinks are carried through rather
 *  than dropped so the loader can report them as skips: silently omitting a
 *  file is how a batch ends up quietly short. */
export type DiscoveredFile = {
  absolutePath: string;
  /** Path relative to `root`, with forward slashes on every platform, so the
   *  same folder ingested from two working directories yields the same key. */
  itemKey: string;
  isSymlink: boolean;
};

export type FileSelection = {
  /** The single base every `itemKey` is relative to. */
  root: string;
  files: readonly DiscoveredFile[];
};

const GLOB_CHARACTERS = /[*?[\]]/;

export function looksLikeGlob(source: string): boolean {
  return GLOB_CHARACTERS.test(source);
}

/**
 * Turn a directory or a quoted glob into one root and a sorted file list.
 *
 * Supported syntax is deliberately small: `*` (any run of characters within one
 * segment), `?` (one character), `[abc]` character classes, and `**` (any depth
 * of directories). Brace expansion is NOT supported — claiming it and then
 * mishandling `{a,b}` would be worse than refusing it.
 */
export function resolveFileSelection(source: string, recursive: boolean): FileSelection {
  if (!looksLikeGlob(source)) {
    const root = path.resolve(source);
    if (!fs.existsSync(root)) {
      throw new IngestSourceError(`Source not found: ${source}`);
    }
    if (!fs.statSync(root).isDirectory()) {
      throw new IngestSourceError(
        `${source} is a file, not a directory. Pass a directory, a quoted glob such as ` +
        `"answers/*.txt", or a .json file.`,
      );
    }
    return { root, files: walk(root, root, recursive) };
  }

  const { root, pattern } = splitPattern(source);
  if (!fs.existsSync(root)) {
    throw new IngestSourceError(
      `The directory the pattern starts from does not exist: ${root}`,
    );
  }
  // A `**` anywhere in the pattern implies descending regardless of --recursive:
  // the pattern already said so, and honouring one and not the other would be
  // two ways to express the same intent that disagree.
  const descend = recursive || pattern.includes("**");
  const matcher = globToRegExp(pattern);
  const files = walk(root, root, descend).filter((file) => matcher.test(file.itemKey));
  if (files.length === 0) {
    throw new IngestSourceError(
      `No files matched ${source}. Remember to quote the pattern so the shell passes it ` +
      "through unexpanded.",
    );
  }
  return { root, files };
}

/**
 * Rewrite a pattern's separators to `/`.
 *
 * Only on Windows. A backslash is a legal character in a POSIX filename, so
 * normalizing everywhere would corrupt a pattern that deliberately contains
 * one. `platformSeparator` is a parameter so the Windows behaviour is testable
 * from any machine.
 */
export function normalizePatternSeparators(
  source: string,
  platformSeparator: string = path.sep,
): string {
  return platformSeparator === "\\" ? source.split("\\").join("/") : source;
}

/**
 * Split "answers/**\/*.txt" into the deepest literal directory and the rest.
 *
 * Exported for tests, which pass a separator rather than requiring Windows.
 */
export function splitPattern(
  rawSource: string,
  platformSeparator: string = path.sep,
): { root: string; pattern: string } {
  const source = normalizePatternSeparators(rawSource, platformSeparator);
  const segments = source.split("/");
  const literal: string[] = [];
  let index = 0;
  while (index < segments.length && !GLOB_CHARACTERS.test(segments[index])) {
    literal.push(segments[index]);
    index += 1;
  }
  // Joining with "/" keeps a drive letter ("C:/answers") and a UNC prefix
  // ("//server/share") intact; Node accepts forward slashes on Windows, and
  // `path.resolve` turns either into a proper absolute root.
  const rootPart = literal.join("/");
  return {
    root: path.resolve(rootPart.length === 0 ? "." : rootPart),
    pattern: segments.slice(index).join("/"),
  };
}

function escapeLiteral(text: string): string {
  return text.replace(/[.+^${}()|\\]/g, "\\$&");
}

/**
 * Compile the supported subset to an anchored regular expression.
 *
 * `**` is handled before `*` so the greedy case wins, and `*` never crosses a
 * `/` — otherwise `a/*.txt` would match `a/b/c.txt`, which is the difference
 * between recursive and not.
 */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` should also match zero directories, so `a/**/b.txt` finds `a/b.txt`.
      if (pattern[index + 2] === "/") {
        out += "(?:.*/)?";
        index += 3;
        continue;
      }
      out += ".*";
      index += 2;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        out += "\\[";
        index += 1;
        continue;
      }
      out += `[${pattern.slice(index + 1, close)}]`;
      index = close + 1;
      continue;
    }
    out += escapeLiteral(char);
    index += 1;
  }
  return new RegExp(`^${out}$`);
}

/** Sorted so ingest is deterministic: the order rows are written in is the
 *  order a labelling session presents them. */
function walk(root: string, dir: string, recursive: boolean): DiscoveredFile[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((left, right) => compareNames(left.name, right.name));

  const found: DiscoveredFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      found.push({ absolutePath, itemKey: keyOf(root, absolutePath), isSymlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      if (recursive) {
        found.push(...walk(root, absolutePath, recursive));
      }
      continue;
    }
    if (entry.isFile()) {
      found.push({ absolutePath, itemKey: keyOf(root, absolutePath), isSymlink: false });
    }
  }
  return found;
}

/** Byte order, not locale order: `localeCompare` varies by machine, and ingest
 *  order decides the order a labelling session presents records in. */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function keyOf(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}
