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
// command the user added since. See docs/dev/agents/session-core.md.

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

export function _keepFolderScan(kind: string, folder: string, value: unknown): void {
  scans[keyFor(kind, folder)] = value;
}

/** Forget every scan. For tests, which reuse one process. */
export function _forgetFolderScans(): void {
  for (const key of Object.keys(scans)) {
    delete scans[key];
  }
}
