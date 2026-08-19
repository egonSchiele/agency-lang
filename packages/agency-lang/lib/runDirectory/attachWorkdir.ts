import * as fs from "fs";
import * as path from "path";

import { isStrictDescendant, safeDeleteDirectoryWithin } from "@/utils.js";

import type { RunDirectoryPaths, RunDirectorySnapshot } from "./runDir.js";

/**
 * Attaching a filesystem snapshot to a run directory, at `workdir/`, with a
 * sidecar `workdir.json` recording when the snapshot was taken and where
 * from — a workdir attached after the fact may postdate the run, and a grader
 * deserves to know. The plan is pure; replacement (`replace: true`) is carried
 * out inside the apply step through `safeDeleteDirectoryWithin`, so no caller
 * ever deletes first.
 */
export class WorkdirAttachmentError extends Error {}

export type WorkdirAttachmentRequest = {
  sourceDir: string;
  replace?: boolean;
  /** A directory inside `sourceDir` to leave out of the copy, on top of the
   *  run directory itself: the group a captured run is being written into. */
  excludeDir?: string;
};

export type WorkdirAttachmentPlan = {
  sourceDir: string;
  target: string;
  sidecar: string;
  excludeDirs: string[];
  status: "add" | "replace";
};

export type WorkdirSidecar = { snapshotAt: string; source: string };

export function planWorkdirAttachment(
  snapshot: RunDirectorySnapshot,
  request: WorkdirAttachmentRequest,
  paths: RunDirectoryPaths,
): WorkdirAttachmentPlan {
  if (snapshot.traces.length === 0) {
    throw new WorkdirAttachmentError(
      `No trace in ${snapshot.dir}; add its statelog before its workdir.`,
    );
  }
  if (!fs.existsSync(request.sourceDir) || !fs.statSync(request.sourceDir).isDirectory()) {
    throw new WorkdirAttachmentError(`${request.sourceDir} is not a directory.`);
  }
  const target = paths.workdirDir;
  const sidecar = paths.workdirSidecar;
  // The run directory may sit inside the tree being captured (`agency run
  // --capture-workdir ./runs from the project root); copying it into itself
  // would recurse forever, so its subtree is left out.
  const excludeDirs = [path.resolve(paths.dir)];
  if (request.excludeDir !== undefined) excludeDirs.push(path.resolve(request.excludeDir));
  const plan = { sourceDir: request.sourceDir, target, sidecar, excludeDirs };
  if (fs.existsSync(target)) {
    if (request.replace !== true) {
      throw new WorkdirAttachmentError(
        `${target} already holds a workdir; pass replace to overwrite it.`,
      );
    }
    return { ...plan, status: "replace" };
  }
  return { ...plan, status: "add" };
}

/** @internal Copies the tree and writes the sidecar. Caller holds the lock. */
export function applyWorkdirAttachment(
  paths: RunDirectoryPaths,
  plan: WorkdirAttachmentPlan,
  snapshotAt: string,
): void {
  if (plan.status === "replace") {
    const deleted = safeDeleteDirectoryWithin(paths.dir, plan.target);
    if (!deleted.success) {
      throw new WorkdirAttachmentError(deleted.message ?? `Could not replace ${plan.target}`);
    }
  }
  fs.mkdirSync(plan.target, { recursive: true });
  copyTreeExcluding(path.resolve(plan.sourceDir), plan.target, plan.excludeDirs);
  const sidecar: WorkdirSidecar = { snapshotAt, source: path.resolve(plan.sourceDir) };
  fs.writeFileSync(plan.sidecar, JSON.stringify(sidecar, null, 2) + "\n");
}

/** Copy `source` into `target`, skipping the `excluded` directories. `cpSync`
 *  refuses a tree that contains its own destination outright, so the walk
 *  descends only along the paths to the excluded directories and copies whole
 *  subtrees everywhere else. */
function copyTreeExcluding(source: string, target: string, excluded: string[]): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (excluded.includes(from)) continue;
    if (entry.isDirectory() && excluded.some((dir) => isStrictDescendant(from, dir))) {
      copyTreeExcluding(from, to, excluded);
    } else {
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
