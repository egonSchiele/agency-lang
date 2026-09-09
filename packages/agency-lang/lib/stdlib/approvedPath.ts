import { fixedPath, resolveUnder, stat as statUnder, readStream } from "./contained.js";

/** The post-approval half of a file read whose bytes are read by someone
 *  else (the reply pipeline, the llm message builder). `spelling` is the
 *  string the approver saw in the interrupt payload. `fixedPath` refuses
 *  a symlink that appeared while the prompt was pending; the descriptor
 *  open refuses a link at the final name and anything that is not a
 *  regular file. What is left is the check-then-open window that
 *  docs/dev/stdlib/contained-files.md leaves to process containment.
 *  Same shape as the preflight in speech.ts before a transcribe. */
export function approvedFilePath(spelling: string): string {
  const located = fixedPath(spelling);
  const resolved = resolveUnder(located.root, located.target);
  const info = statUnder(located.root, located.target);
  if (info === null) {
    throw new Error(`no such file: ${resolved}`);
  }
  if (!info.isFile()) {
    throw new Error(`not a regular file: ${resolved}`);
  }
  readStream(located.root, located.target).destroy();
  return resolved;
}

/** The same function under the underscore name the `.agency` wrappers
 *  import, so `viewFile` and `readTextWithModel` read the way every
 *  other stdlib helper call reads. */
export const _approvedFilePath = approvedFilePath;
