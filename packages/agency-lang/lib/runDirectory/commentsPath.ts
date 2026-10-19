import * as path from "path";

import { runDirPaths } from "./runDir.js";

/**
 * Where a log's comments live, decided by how the log was opened. A run
 * directory keeps them beside `notes.md` and `annotations.jsonl`; a loose
 * statelog file gets a sidecar next to it. Stdin and remote logs have no
 * comments in this version. The CLI records the chosen path in the session
 * registry, because it cannot be told from the statelog path alone.
 */
export type CommentsSource = { kind: "runDir"; dir: string } | { kind: "file"; path: string };

export function commentsPathFor(source: CommentsSource): string {
  if (source.kind === "runDir") {
    return runDirPaths(source.dir).comments;
  }
  return `${source.path}.comments.jsonl`;
}

/** The source for a statelog path the viewer was handed: a run directory's
 *  `statelog.jsonl` keeps comments in the directory; any other file gets a
 *  sidecar. */
export function commentsSourceForStatelog(statelogPath: string): CommentsSource {
  const dir = path.dirname(statelogPath);
  if (runDirPaths(dir).statelog === statelogPath) {
    return { kind: "runDir", dir };
  }
  return { kind: "file", path: statelogPath };
}

/** The lock a write to this comments file takes: a run directory's own `.lock`,
 *  or `<sidecar>.lock` for a loose file, so no `.lock` is left in whatever
 *  folder holds the statelog. */
export function commentsLockFor(commentsPath: string): string {
  const dir = path.dirname(commentsPath);
  if (runDirPaths(dir).comments === commentsPath) {
    return runDirPaths(dir).lock;
  }
  return `${commentsPath}.lock`;
}
