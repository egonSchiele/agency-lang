import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { DeepReadonly } from "./types.js";

const LOCK_BASENAME = ".lock";
const LOCK_TOKEN_LENGTH = 16;

export type LockHolder = {
  pid: number;
  token: string;
  acquiredAt: string;
};

export type AcquireStoreLockArgs = {
  datasetDir: string;
  reportWarning(message: string): void;
};

export type DatasetLock = {
  holder: DeepReadonly<LockHolder>;
  release(): void;
};

/**
 * One writer at a time for a label dataset.
 *
 * This is integrity protection, not collaboration. Sign-off touches several
 * files in an order that matters, and two sessions interleaving could publish
 * two revisions racing for the same version number. "There is only one
 * annotator" does not stop that annotator opening two terminals.
 *
 * A stale lock is never taken over automatically. Guessing that a holder is
 * dead and stealing the dataset is exactly the move that turns a crash into
 * corrupted data, so an abandoned lock is reported and left for a person.
 */
export function acquireDatasetLock(args: AcquireStoreLockArgs): DatasetLock {
  fs.mkdirSync(args.datasetDir, { recursive: true });
  const lockFile = path.join(args.datasetDir, LOCK_BASENAME);
  const holder: LockHolder = {
    pid: process.pid,
    token: nanoid(LOCK_TOKEN_LENGTH),
    acquiredAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(lockFile, `${JSON.stringify(holder, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    throw new Error(describeExistingHolder(lockFile));
  }

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    releaseOwnedLock(lockFile, holder, args.reportWarning);
  };

  // Registered so a crash still frees the dataset, and removed on release so a
  // long-lived process does not accumulate listeners per session.
  const onExit = (): void => {
    release();
  };
  process.once("exit", onExit);

  return {
    holder,
    release(): void {
      process.removeListener("exit", onExit);
      release();
    },
  };
}

function describeExistingHolder(lockFile: string): string {
  const existing = readHolder(lockFile);
  if (existing === undefined) {
    return `Another labelling session holds ${lockFile}, but the file is unreadable. ` +
      `If no session is running, delete it.`;
  }
  const liveness = processState(existing.pid) === "alive"
    ? `That process is still running.`
    : `That process is no longer running; if you are sure no session is active, delete the file.`;
  return `Another labelling session holds ${lockFile} (pid ${existing.pid}, acquired ` +
    `${existing.acquiredAt}). ${liveness}`;
}

/**
 * Remove the lock only after proving we still hold it.
 *
 * `safeDelete` is not used here: it is oriented at the project root, and a
 * dataset can be configured anywhere. Instead this checks the exact basename and
 * the recorded ownership token, so the only file it can ever unlink is a lock
 * this process wrote.
 */
function releaseOwnedLock(
  lockFile: string,
  holder: LockHolder,
  reportWarning: (message: string) => void,
): void {
  if (path.basename(lockFile) !== LOCK_BASENAME) {
    reportWarning(`Refusing to remove ${lockFile}: not a lock file`);
    return;
  }
  const existing = readHolder(lockFile);
  if (existing === undefined) {
    return;
  }
  if (existing.token !== holder.token) {
    reportWarning(
      `Not releasing ${lockFile}: it is now held by pid ${existing.pid}, not this session. ` +
      `Something removed our lock while we were running.`,
    );
    return;
  }
  fs.rmSync(lockFile, { force: true });
}

function readHolder(lockFile: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.token !== "string") {
      return undefined;
    }
    return parsed as LockHolder;
  } catch {
    return undefined;
  }
}

/** Only ESRCH means the process is gone. EPERM means it exists and belongs to
 *  someone else, which is very much alive. */
function processState(pid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return "gone";
    }
    if (code === "EPERM") {
      return "alive";
    }
    return "unknown";
  }
}
