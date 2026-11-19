// What a terminal agent found when it scanned its folder for the user's
// own files: `.claude/commands`, and the Claude skills.
//
// A terminal runs one session, and scans before it installs its policy
// handler, since a scan made during a turn would be put to the user. It
// keeps the result here for the life of the process. This is not in a
// checkpoint, so a resumed session scans again.
//
// A process that holds many sessions does not use this: see
// `oneSessionInThisProcess` in the agent's sessionFolder.agency.

const scans: Record<string, unknown> = {};

function keyFor(kind: string, folder: string): string {
  return `${kind}\n${folder}`;
}

/** The scan of this kind kept for the folder, or null when this process
 *  has not made one. */
export function _folderScan(kind: string, folder: string): unknown {
  const key = keyFor(kind, folder);
  return Object.hasOwn(scans, key) ? scans[key] : null;
}

// Every caller, and every session in the folder, is handed the same value.
// Frozen, as the statics were, so none of them can change it for the rest.
function frozen(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) {
    frozen(child);
  }
  return Object.freeze(value);
}

export function _keepFolderScan(kind: string, folder: string, value: unknown): void {
  scans[keyFor(kind, folder)] = frozen(value);
}
