// Tab completion for the line-mode REPL: slash commands and `@file` mentions.
import type { Host } from "../host/host.js";
import { completeMention, mentionAtEnd, type ListDir } from "./pathCompletion.js";

type Completion = [string[], string];

/**
 * Build a Node `readline` completer. A last word that starts with `@`
 * completes as a file path. Otherwise a line that is the start of a slash
 * command completes over the palette. Any other line gets no suggestions.
 * Standard readline behavior: a single hit auto-completes inline; multiple
 * hits display the list.
 */
export function buildCompleter(
  entries: [string, string][],
  listDir: ListDir,
): (line: string, done: (err: Error | null, result: Completion) => void) => void {
  const keys = entries.map(([k]) => k);
  const complete = async (line: string): Promise<Completion> => {
    // The mention comes first, so a file can be named in a command's
    // arguments: `/review @lib/ag`.
    const mention = mentionAtEnd(line);
    if (mention !== null) {
      return [await completeMention(mention, listDir), mention];
    }
    const namesACommand = line.startsWith("/") && !line.includes(" ");
    if (!namesACommand) {
      return [[], line];
    }
    const hits = keys.filter((k) => k.startsWith(line));
    return [hits.length > 0 ? hits : keys, line];
  };
  return (line, done) => {
    complete(line).then(
      (result) => done(null, result),
      (err) => done(err, [[], line]),
    );
  };
}

/** One level of a directory under the host's working directory, for file
 *  completion. */
export function listDirUnder(host: Host): ListDir {
  return async (dir) => {
    try {
      const { files } = host;
      const absolute = dir.startsWith("/") ? dir : `${host.system.cwd()}/${dir}`;
      return await files.list(await files.root(absolute), ".");
    } catch {
      // Not an error to report: a half-typed path names no directory yet.
      return [];
    }
  };
}
