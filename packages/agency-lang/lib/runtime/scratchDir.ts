// A run's scratch folder: `<temp>/agency-scratch-<user id>/<id>`, where the
// id comes from the run's id. The path is computed, never stored, so a run
// finds the same folder after an interrupt and resume, a subprocess shares
// its parent's, and code that answers an interrupt outside the run can
// work it out from the interrupt. See docs/dev/runtime/scratch-dir.md.
import type { Host } from "../host/host.js";
import { AGENCY_CARRIER_ON, AGENCY_SCRATCH } from "../constants.js";
import { sha256Text } from "../utils/hash.js";
import { ensureUserTempFolder, userTempFolderName } from "./userTempFolder.js";

/** Whether this host gives its runs a scratch folder. Off unless the
 *  `AGENCY_SCRATCH` setting is on, so a plain script leaves nothing on
 *  disk. Whoever launches the run turns it on. */
export function scratchEnabled(host: Pick<Host, "settings">): boolean {
  return host.settings.read(AGENCY_SCRATCH) === AGENCY_CARRIER_ON;
}

/** The start of the scratch parent folder's name; the user id follows. */
export const SCRATCH_FOLDER_PREFIX = "agency-scratch-";

/** The name of a run's folder under the scratch parent. A run id can be
 *  chosen by whoever starts the run and may hold any characters, so it is
 *  hashed: no run id can name a path outside the parent. */
export function scratchId(runId: string): string {
  return sha256Text(`agency-scratch:${runId}`).slice(0, 16);
}

/** The folder every run's scratch folder is in, with the temp folder as a
 *  real path. File effects put real paths in their payloads, and a policy's
 *  reject message names this folder, so every place spells it one way. The
 *  temp folder exists, so it resolves whether or not the parent does yet. */
export function scratchParentPath(host: Host): string {
  const temp = host.system.realDir(host.system.tempDir()).replace(/\/+$/, "");
  return `${temp}/${userTempFolderName(host, SCRATCH_FOLDER_PREFIX)}`;
}

/** The scratch folder of the run `runId`, as a real path. */
export function scratchDirPath(host: Host, runId: string): string {
  return `${scratchParentPath(host)}/${scratchId(runId)}`;
}

/** Create the run's scratch folder if it is missing and return its path. */
export async function ensureScratchDir(host: Host, runId: string): Promise<string> {
  const parent = scratchParentPath(host);
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
