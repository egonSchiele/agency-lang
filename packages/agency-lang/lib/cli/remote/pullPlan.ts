// The pull filesystem boundary. Server filenames are untrusted, so planning is a
// non-mutating preflight (traversal/duplicate/non-regular checks, all conflicts
// collected before any write) and application publishes each file atomically
// with no-clobber semantics (fs.link for create, revalidate-then-rename for
// --force). Commands never touch `fs` directly.

import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import type { SourceFile } from "../statelog/projectClient.js";

export type PlannedPullFile = {
  name: string;
  destination: string;
  contents: string;
  replace: boolean;
};

export type PullPlan = {
  outputDir: string;
  files: PlannedPullFile[];
};

/** An application failure that names the destinations already committed (the
 *  bundle is not transactional) and any temp sibling left behind. */
export class PullApplyError extends Error {
  constructor(
    message: string,
    readonly committed: string[],
    readonly leftoverTemp?: string,
  ) {
    super(message);
    this.name = "PullApplyError";
  }
}

/** Preflight the whole pull. Completes before any mutation; throws on any
 *  violation so no file is written when a conflict or unsafe name exists. */
export function planSourcePull(
  files: SourceFile[],
  outputDir: string,
  force: boolean,
): PullPlan {
  const resolvedOut = path.resolve(outputDir);

  const outStat = lstatOrNull(resolvedOut);
  if (outStat !== null && !outStat.isDirectory()) {
    throw new Error(`--out ${outputDir} exists but is not a directory (symlinks are refused)`);
  }

  const seenKeys: Record<string, true> = Object.create(null);
  const planned: PlannedPullFile[] = [];
  const conflicts: string[] = [];

  for (const file of files) {
    if (!isFlatFilename(file.name)) {
      throw new Error(`unsafe deployed file name: ${JSON.stringify(file.name)}`);
    }
    const key = file.name.normalize("NFC").toLowerCase();
    if (seenKeys[key] === true) {
      throw new Error(`duplicate deployed file name (case-insensitive): ${file.name}`);
    }
    seenKeys[key] = true;

    const destination = path.join(resolvedOut, file.name);
    if (path.dirname(destination) !== resolvedOut) {
      throw new Error(`deployed file escapes the output directory: ${file.name}`);
    }

    const destStat = lstatOrNull(destination);
    let replace = false;
    if (destStat !== null) {
      if (!destStat.isFile()) {
        throw new Error(`refusing to write over a non-regular file: ${file.name}`);
      }
      if (force) {
        replace = true;
      } else {
        conflicts.push(file.name);
      }
    }
    planned.push({ name: file.name, destination, contents: file.contents, replace });
  }

  if (conflicts.length > 0) {
    throw new Error(
      `refusing to overwrite existing files (pass --force): ${conflicts.join(", ")}`,
    );
  }
  return { outputDir: resolvedOut, files: planned };
}

type PullOperationResult = { ok: true } | { ok: false; error: unknown };

/** Publish the plan. Each file is written to an exclusive temp sibling then
 *  committed atomically: create via `fs.link` (EEXIST on a post-plan race →
 *  aborts that file), or `--force` replace via revalidate-then-rename over a
 *  still-regular file. The whole bundle is NOT transactional. */
export function applySourcePull(plan: PullPlan): void {
  const committed: string[] = [];
  try {
    fs.mkdirSync(plan.outputDir, { recursive: true });
    requireRealDirectory(plan.outputDir);
  } catch (error) {
    throw new PullApplyError(`could not create ${plan.outputDir}: ${message(error)}`, committed);
  }

  for (const file of plan.files) {
    const temp = path.join(plan.outputDir, `.pull-${randomBytes(8).toString("hex")}.tmp`);
    let fd: number | undefined;
    let operation: PullOperationResult = { ok: true };
    try {
      fd = fs.openSync(temp, "wx");
      fs.writeFileSync(fd, file.contents, "utf8");
      fs.closeSync(fd);
      fd = undefined;
      if (file.replace) {
        requireRegularFile(file.destination);
        fs.renameSync(temp, file.destination);
      } else {
        fs.linkSync(temp, file.destination);
      }
      committed.push(file.destination);
    } catch (error) {
      operation = { ok: false, error };
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          operation = { ok: false, error: combineErrors(error, closeError) };
        }
      }
    }

    // A successful create (fs.link) leaves the temp as a second hard link;
    // clean it up. Cleanup happens after committed is already updated, so
    // PullApplyError.committed stays truthful even when cleanup itself fails.
    const cleanupError = cleanupOwnedTemp(plan.outputDir, temp);
    if (!operation.ok) {
      throw new PullApplyError(
        describePullFailure(file, operation.error, cleanupError),
        [...committed],
        cleanupError !== undefined ? temp : undefined,
      );
    }
    if (cleanupError !== undefined) {
      throw new PullApplyError(
        `wrote ${file.destination}, but could not remove temp ${temp}: ${cleanupError}`,
        [...committed],
        temp,
      );
    }
  }
}

function isFlatFilename(name: string): boolean {
  if (name.length === 0 || name === "." || name === "..") {
    return false;
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return false;
  }
  return !path.isAbsolute(name);
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function requireRealDirectory(dir: string): void {
  if (!fs.lstatSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a directory`);
  }
}

function requireRegularFile(destination: string): void {
  if (!fs.lstatSync(destination).isFile()) {
    throw new Error(`${destination} is no longer a regular file`);
  }
}

/** Best-effort removal of an applicator-owned temp only. Verifies the path is a
 *  direct `.pull-*.tmp` child of outputDir first; a missing temp (ENOENT) is
 *  success. Never accepts a server-provided path — this is the deliberate narrow
 *  exception to `safeDeleteFile`, which requires a package root and follows
 *  realpath and so cannot clean a temp in an arbitrary `--out`. */
function cleanupOwnedTemp(outputDir: string, temp: string): string | undefined {
  const base = path.basename(temp);
  if (path.dirname(temp) !== outputDir || !base.startsWith(".pull-") || !base.endsWith(".tmp")) {
    return undefined;
  }
  try {
    fs.unlinkSync(temp);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return message(error);
  }
}

function describePullFailure(
  file: PlannedPullFile,
  error: unknown,
  cleanupError: string | undefined,
): string {
  const base = `pull failed writing ${file.name}: ${message(error)}`;
  return cleanupError !== undefined ? `${base} (also could not remove its temp: ${cleanupError})` : base;
}

function combineErrors(primary: unknown, secondary: unknown): Error {
  return new Error(`${message(primary)}; also: ${message(secondary)}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
