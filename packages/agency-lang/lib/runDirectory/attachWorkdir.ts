import * as fs from "fs";
import * as path from "path";

import { safeDeleteDirectoryWithin } from "@/utils.js";

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
  fs.cpSync(plan.sourceDir, plan.target, { recursive: true });
  const sidecar: WorkdirSidecar = { snapshotAt, source: path.resolve(plan.sourceDir) };
  fs.writeFileSync(plan.sidecar, JSON.stringify(sidecar, null, 2) + "\n");
}
