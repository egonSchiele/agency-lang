import * as fs from "fs";
import * as path from "path";

import { nanoid } from "nanoid";

import type { DeepReadonly } from "@/eval/label/types.js";

const LOCK_BASENAME = ".lock";
const LOCK_TOKEN_LENGTH = 16;

export type LockHolder = {
  pid: number;
  token: string;
  acquiredAt: string;
};

export type AcquireRunDirLockArgs = {
  dir: string;
  reportWarning(message: string): void;
};

export type RunDirLock = {
  holder: DeepReadonly<LockHolder>;
  release(): void;
};

/**
 * One writer at a time for a run directory.
 *
 * This is integrity protection, not collaboration. Sign-off touches several
 * files in an order that matters, and two writers interleaving could publish
 * two revisions racing for the same version number. "There is only one
 * annotator" does not stop that annotator opening two terminals.
 *
 * A stale lock is never taken over automatically. Guessing that a holder is
 * dead and stealing the directory is exactly the move that turns a crash into
 * corrupted data, so an abandoned lock is reported and left for a person.
 */
export function acquireRunDirLock(args: AcquireRunDirLockArgs): RunDirLock {
  return acquireOwnedFileLock({
    lockFile: path.join(args.dir, LOCK_BASENAME),
    reportWarning: args.reportWarning,
  });
}

export type AcquireOwnedFileLockArgs = {
  lockFile: string;
  reportWarning(message: string): void;
};

export type OwnedFileLock = RunDirLock;

/**
 * @internal Acquire exactly `lockFile` (created `wx`, so an existing file is
 * another holder); release removes only that same file, after proving the
 * ownership token inside it is still ours. The run-directory lock and the
 * labeling locks (one per session draft, one per lineage publication) are
 * this one primitive at different paths.
 */
export function acquireOwnedFileLock(args: AcquireOwnedFileLockArgs): OwnedFileLock {
  const { lockFile } = args;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
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

  // Registered so a crash still frees the file, and removed on release so a
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
    return (
      `Another writer holds ${lockFile}, but the file is unreadable. ` +
      `If no writer is running, delete it.`
    );
  }
  const liveness =
    processState(existing.pid) === "alive"
      ? `That process is still running.`
      : `That process is no longer running; if you are sure no writer is active, delete the file.`;
  return (
    `Another writer holds ${lockFile} (pid ${existing.pid}, acquired ` +
    `${existing.acquiredAt}). ${liveness}`
  );
}

/**
 * Remove the lock only after proving we still hold it.
 *
 * `safeDelete` is not used here: it is oriented at the project root, and a
 * run directory can be anywhere. Instead this unlinks only the exact path
 * this process acquired, and only when the ownership token inside it is
 * still ours, so the one file it can ever remove is a lock this process wrote.
 */
function releaseOwnedLock(
  lockFile: string,
  holder: LockHolder,
  reportWarning: (message: string) => void,
): void {
  if (!fs.existsSync(lockFile)) {
    return;
  }
  const existing = readHolder(lockFile);
  if (existing === undefined) {
    reportWarning(
      `Not releasing ${lockFile}: it exists but is unreadable, so this session cannot prove it ` +
        `still owns it. If no writer is running, delete the file.`,
    );
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
