import type { FileStat, Host, Located } from "../host/host.js";
import { currentHost } from "../runtime/currentHost.js";

type ApprovedFile = {
  located: Located;
  resolved: string;
  info: FileStat;
};

/** The approved spelling, held with `fixedPath` and checked to name a
 *  regular file. Shared by the two functions below. */
async function approvedFile(host: Host, spelling: string): Promise<ApprovedFile> {
  const located = await host.files.fixedPath(spelling);
  const resolved = await host.files.resolvePath(located.root, located.target);
  const info = await host.files.stat(located.root, located.target);
  if (info === null) {
    throw new Error(`no such file: ${resolved}`);
  }
  if (info.kind !== "file") {
    throw new Error(`not a regular file: ${resolved}`);
  }
  return { located, resolved, info };
}

/** The post-approval half of a file read whose bytes are read by someone
 *  else (the reply pipeline, the llm message builder). `spelling` is the
 *  string the approver saw in the interrupt payload. `fixedPath` refuses
 *  a symlink that appeared while the prompt was pending; `stat` reports a
 *  link at the final name as missing and refuses anything that is not a
 *  regular file. What is left is the check-then-open window that
 *  docs/dev/stdlib/contained-files.md leaves to process containment.
 *  Same shape as the preflight in speech.ts before a transcribe. */
export async function approvedFilePath(host: Host, spelling: string): Promise<string> {
  const { resolved } = await approvedFile(host, spelling);
  return resolved;
}

/** The post-approval read of a file whose bytes are sent to another
 *  process, such as the vision server, so that process never opens a
 *  path itself. The same checks as `approvedFilePath`, then one read
 *  through a validated descriptor. Refuses a file over `maxBytes` before
 *  reading it. */
export async function approvedFileBytes(
  host: Host,
  spelling: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { located, resolved, info } = await approvedFile(host, spelling);
  if (info.size > maxBytes) {
    throw new Error(
      `${resolved} is ${info.size.toLocaleString("en-US")} bytes; the most this reads is ${maxBytes.toLocaleString("en-US")}.`,
    );
  }
  return host.files.readBytes(located.root, located.target);
}

/** The same check under the underscore name the `.agency` wrappers
 *  import, so `viewFile` and `readTextWithModel` read the way every
 *  other stdlib helper call reads. */
export async function _approvedFilePath(spelling: string): Promise<string> {
  const host = currentHost();
  return approvedFilePath(host, spelling);
}
