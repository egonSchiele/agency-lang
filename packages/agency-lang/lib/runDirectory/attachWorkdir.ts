import * as fs from "fs";
import * as path from "path";

import { isStrictDescendant, safeDeleteDirectoryWithin } from "@/utils.js";

import type { RunDirectoryPaths, RunDirectorySnapshot } from "./runDir.js";

/**
 * Attaching a filesystem snapshot to one trace, at `workdir/<traceId>/`, with
 * a sidecar `workdir/<traceId>.json` recording when the snapshot was taken and
 * where from — a workdir attached after the fact may postdate the run, and a
 * grader deserves to know. The plan is pure; replacement (`replace: true`) is
 * carried out inside the apply step through `safeDeleteDirectoryWithin`, so no
 * caller ever deletes first.
 */
export class WorkdirAttachmentError extends Error {}

export type WorkdirAttachmentRequest = {
  traceId: string;
  sourceDir: string;
  replace?: boolean;
};

export type WorkdirAttachmentPlan = {
  traceId: string;
  sourceDir: string;
  target: string;
  sidecar: string;
  status: "add" | "replace";
};

export type WorkdirSidecar = { snapshotAt: string; source: string };

export function planWorkdirAttachment(
  snapshot: RunDirectorySnapshot,
  request: WorkdirAttachmentRequest,
  paths: RunDirectoryPaths,
): WorkdirAttachmentPlan {
  if (!snapshot.traces.some((trace) => trace.traceId === request.traceId)) {
    throw new WorkdirAttachmentError(
      `No trace ${request.traceId} in ${snapshot.dir}; add its statelog before its workdir.`,
    );
  }
  if (!fs.existsSync(request.sourceDir) || !fs.statSync(request.sourceDir).isDirectory()) {
    throw new WorkdirAttachmentError(`${request.sourceDir} is not a directory.`);
  }
  const target = path.join(paths.workdirDir, request.traceId);
  const sidecar = path.join(paths.workdirDir, `${request.traceId}.json`);
  // A trace id is whatever the statelog said it was. One like `../escaped`
  // would put both files outside workdir/, so the resolved paths are checked
  // here, before anything is written, not just on replacement.
  const workdirRoot = path.resolve(paths.workdirDir);
  const contained = [target, sidecar].every(
    (file) =>
      isStrictDescendant(workdirRoot, path.resolve(file)) &&
      path.dirname(path.resolve(file)) === workdirRoot,
  );
  if (!contained) {
    throw new WorkdirAttachmentError(
      `Refusing to attach a workdir for trace "${request.traceId}": its id would place files ` +
        `outside ${paths.workdirDir}.`,
    );
  }
  if (fs.existsSync(target)) {
    if (request.replace !== true) {
      throw new WorkdirAttachmentError(
        `${target} already holds a workdir for this trace; pass replace to overwrite it.`,
      );
    }
    return {
      traceId: request.traceId,
      sourceDir: request.sourceDir,
      target,
      sidecar,
      status: "replace",
    };
  }
  return { traceId: request.traceId, sourceDir: request.sourceDir, target, sidecar, status: "add" };
}

/** @internal Copies the tree and writes the sidecar. Caller holds the lock. */
export function applyWorkdirAttachment(
  paths: RunDirectoryPaths,
  plan: WorkdirAttachmentPlan,
  snapshotAt: string,
): void {
  if (plan.status === "replace") {
    const deleted = safeDeleteDirectoryWithin(paths.workdirDir, plan.target);
    if (!deleted.success) {
      throw new WorkdirAttachmentError(deleted.message ?? `Could not replace ${plan.target}`);
    }
  }
  fs.mkdirSync(plan.target, { recursive: true });
  // The run directory may sit inside the tree being captured (`agency run
  // --capture-workdir ./runs/x` from the project root); copying it into itself
  // would recurse forever, so its subtree is left out.
  copyTreeExcluding(path.resolve(plan.sourceDir), plan.target, path.resolve(paths.dir));
  const sidecar: WorkdirSidecar = { snapshotAt, source: path.resolve(plan.sourceDir) };
  fs.writeFileSync(plan.sidecar, JSON.stringify(sidecar, null, 2) + "\n");
}

/** Copy `source` into `target`, skipping the `excluded` directory. `cpSync`
 *  refuses a tree that contains its own destination outright, so the walk
 *  descends only along the path to `excluded` and copies whole subtrees
 *  everywhere else. */
function copyTreeExcluding(source: string, target: string, excluded: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (from === excluded) continue;
    if (entry.isDirectory() && isStrictDescendant(from, excluded)) {
      copyTreeExcluding(from, to, excluded);
    } else {
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
