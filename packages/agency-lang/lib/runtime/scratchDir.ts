// A run's scratch folder: `<temp>/agency-scratch-<user id>/<id>`, where the
// id comes from the run's id. The path is computed, never stored, so a run
// finds the same folder after an interrupt and resume, a subprocess shares
// its parent's, and code that answers an interrupt outside the run can
// work it out from the interrupt. See docs/dev/runtime/scratch-dir.md.
import type { Host } from "../host/host.js";
import { sha256Text } from "../utils/hash.js";
import { ensureUserTempFolder, userTempFolder } from "./userTempFolder.js";

/** The start of the scratch parent folder's name; the user id follows. */
export const SCRATCH_FOLDER_PREFIX = "agency-scratch-";

/** The name of a run's folder under the scratch parent. A run id can be
 *  chosen by whoever starts the run and may hold any characters, so it is
 *  hashed: no run id can name a path outside the parent. */
export function scratchId(runId: string): string {
  return sha256Text(`agency-scratch:${runId}`).slice(0, 16);
}

/** The scratch folder of the run `runId`, with the temp folder spelled as
 *  the host gives it. */
export function scratchDirPath(host: Host, runId: string): string {
  return `${userTempFolder(host, SCRATCH_FOLDER_PREFIX)}/${scratchId(runId)}`;
}

/** Create the run's scratch folder if it is missing and return its path. */
export async function ensureScratchDir(host: Host, runId: string): Promise<string> {
  const parent = userTempFolder(host, SCRATCH_FOLDER_PREFIX);
  let made: Awaited<ReturnType<typeof ensureUserTempFolder>>;
  try {
    made = await ensureUserTempFolder(host, SCRATCH_FOLDER_PREFIX);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${why} The scratch folder cannot be used until ${parent} is deleted, so delete it and try again.`,
    );
  }
  await host.files.privateDir(made.temp, `${made.folder}/${scratchId(runId)}`);
  return scratchDirPath(host, runId);
}
