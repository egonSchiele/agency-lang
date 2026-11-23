// A folder in the temp folder that belongs to one user, named by a prefix
// and the user's id: `agency-spill-1000`, `agency-scratch-1000`. The temp
// folder is shared on some systems, so the folder is made with
// `privateDir`, which fails when another user made it first.
import type { Host } from "../host/host.js";

type TempRoot = Awaited<ReturnType<Host["files"]["root"]>>;

/** The folder's own name: the prefix, then the user id. */
export function userTempFolderName(host: Host, prefix: string): string {
  return `${prefix}${host.system.userId()}`;
}

/** The folder's path, with the temp folder spelled as the host gives it
 *  and no trailing separator. */
export function userTempFolder(host: Host, prefix: string): string {
  const temp = host.system.tempDir().replace(/\/+$/, "");
  return `${temp}/${userTempFolderName(host, prefix)}`;
}

/** Make the folder if it is missing, and check it is this user's alone.
 *  Returns the temp folder's root and the folder's name under it. */
export async function ensureUserTempFolder(
  host: Host,
  prefix: string,
): Promise<{ temp: TempRoot; folder: string }> {
  const temp = await host.files.root(host.system.tempDir());
  const folder = userTempFolderName(host, prefix);
  await host.files.privateDir(temp, folder);
  return { temp, folder };
}
