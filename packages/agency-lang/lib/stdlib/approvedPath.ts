import {
  fixedPath,
  resolveUnder,
  stat as statUnder,
  readStream,
  readBytes,
  type Located,
} from "./contained.js";
type ApprovedFile = {
  located: Located;
  resolved: string;
  info: NonNullable<ReturnType<typeof statUnder>>;
};

/** The approved spelling, held with `fixedPath` and checked to name a
 *  regular file. Shared by the two functions below. */
function approvedFile(spelling: string): ApprovedFile {
  const located = fixedPath(spelling);
  const resolved = resolveUnder(located.root, located.target);
  const info = statUnder(located.root, located.target);
  if (info === null) {
    throw new Error(`no such file: ${resolved}`);
  }
  if (!info.isFile()) {
    throw new Error(`not a regular file: ${resolved}`);
  }
  return { located, resolved, info };
}

/** The post-approval half of a file read whose bytes are read by someone
 *  else (the reply pipeline, the llm message builder). `spelling` is the
 *  string the approver saw in the interrupt payload. `fixedPath` refuses
 *  a symlink that appeared while the prompt was pending; the descriptor
 *  open refuses a link at the final name and anything that is not a
 *  regular file. What is left is the check-then-open window that
 *  docs/dev/stdlib/contained-files.md leaves to process containment.
 *  Same shape as the preflight in speech.ts before a transcribe. */
export function approvedFilePath(spelling: string): string {
  const { located, resolved } = approvedFile(spelling);
  readStream(located.root, located.target).destroy();
  return resolved;
}

/** The post-approval read of a file whose bytes are sent to another
 *  process, such as the vision server, so that process never opens a
 *  path itself. The same checks as `approvedFilePath`, then one read
 *  through a validated descriptor. Refuses a file over `maxBytes` before
 *  reading it. */
export function approvedFileBytes(spelling: string, maxBytes: number): Buffer {
  const { located, resolved, info } = approvedFile(spelling);
  if (info.size > maxBytes) {
    throw new Error(
      `${resolved} is ${info.size.toLocaleString("en-US")} bytes; the most this reads is ${maxBytes.toLocaleString("en-US")}.`,
    );
  }
  return readBytes(located.root, located.target);
}

/** The same function under the underscore name the `.agency` wrappers
 *  import, so `viewFile` and `readTextWithModel` read the way every
 *  other stdlib helper call reads. */
export const _approvedFilePath = approvedFilePath;
