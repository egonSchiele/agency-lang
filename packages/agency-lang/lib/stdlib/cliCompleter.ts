// Tab completion for the line-mode REPL: slash commands and `@file` mentions.
import * as path from "path";
import { list, root } from "../host/node/nodeFiles.js";
import { completeMention, mentionAtEnd, type ListDir } from "./pathCompletion.js";

type Completion = [string[], string];

/**
 * Build a Node `readline` completer. A line that starts with `/` completes
 * over the slash-command palette. Otherwise a last word that starts with
 * `@` completes as a file path. Any other line gets no suggestions.
 * Standard readline behavior: a single hit auto-completes inline; multiple
 * hits display the list.
 */
export function buildCompleter(
  entries: [string, string][],
  listDir: ListDir,
): (line: string, done: (err: Error | null, result: Completion) => void) => void {
  const keys = entries.map(([k]) => k);
  const complete = async (line: string): Promise<Completion> => {
    if (line.startsWith("/")) {
      const hits = keys.filter((k) => k.startsWith(line));
      return [hits.length > 0 ? hits : keys, line];
    }
    const mention = mentionAtEnd(line);
    if (mention === null) {
      return [[], line];
    }
    return [await completeMention(mention, listDir), mention];
  };
  return (line, done) => {
    complete(line).then(
      (result) => done(null, result),
      (err) => done(err, [[], line]),
    );
  };
}

/** One level of a directory under `cwd`, for file completion. */
export function listDirUnder(cwd: string): ListDir {
  return async (dir) => {
    try {
      return list(root(path.resolve(cwd, dir)), ".");
    } catch {
      // Not an error to report: a half-typed path names no directory yet.
      return [];
    }
  };
}
