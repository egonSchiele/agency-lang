// What the agent found when it scanned a folder for the user's own files:
// `.claude/commands`, and the Claude skills. Kept per process, by folder.
//
// The scans used to be statics of the agent's modules, read from the
// process's folder when the modules loaded. An app's engine holds sessions
// from many folders in one process, so the scan is now made for a
// session's own folder, the first time that process needs it.
//
// This is process state on purpose, like an MCP connection. It is never in
// a checkpoint, so a process that resumes a session scans again and sees a
// command the user added since.
//
// A terminal keeps a scan for its whole life, as it kept the statics: a
// scan made during a turn would run under its policy handler and be put to
// the user. The session core forgets its folder's scans before each turn,
// so an app that stays open for days sees a command added an hour ago.
// See docs/dev/agents/session-core.md.

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

/** Forget every scan kept for a folder, so the next read of each scans
 *  again. */
export function _forgetFolderScans(folder: string): void {
  const suffix = keyFor("", folder);
  for (const key of Object.keys(scans)) {
    if (key.endsWith(suffix)) {
      delete scans[key];
    }
  }
}
