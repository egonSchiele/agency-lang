import * as fs from "fs";
import * as path from "path";

import { sha256Text } from "@/utils/hash.js";

import { closureHashOf, computeCodeIdentity, type CodeIdentity } from "./codeIdentity.js";
import type { RunDirectoryPaths, RunDirectorySnapshot } from "./runDir.js";
import type { Trace } from "./traces.js";

/**
 * Attaching agent code to a run directory, stored directly under `code/` (a
 * run directory holds one run, so one code version). The plan is pure: it
 * hashes the closure it is given and checks that the directory's trace
 * recorded that hash on its `agentStart`. A mismatch is refused, not warned — optimizing the wrong
 * program would be silent otherwise.
 */
export class CodeMismatchError extends Error {}

export type CodeAttachmentPlan = {
  identity: CodeIdentity;
  /** Absolute base directory the closure's relative paths hang off. */
  baseDir: string;
  status: "add" | "already-present";
};

/** The closure hashes the directory's traces recorded, deduplicated. */
export function recordedClosureHashes(traces: readonly Trace[]): string[] {
  const hashes: string[] = [];
  for (const trace of traces) {
    for (const event of trace.events) {
      if (event.data.type !== "agentStart") continue;
      const hash = event.data.code?.closureHash;
      if (typeof hash === "string" && !hashes.includes(hash)) hashes.push(hash);
    }
  }
  return hashes;
}

export function planCodeAttachment(
  snapshot: RunDirectorySnapshot,
  entryFile: string,
  paths: RunDirectoryPaths,
): CodeAttachmentPlan {
  const identity = computeCodeIdentity(entryFile);
  const recorded = recordedClosureHashes(snapshot.traces);
  if (!recorded.includes(identity.closureHash)) {
    const known = recorded.length === 0 ? "none recorded" : recorded.join(", ");
    throw new CodeMismatchError(
      `${entryFile} hashes to ${identity.closureHash}, which no trace in ${snapshot.dir} ` +
        `recorded as its code (${known}). Attach the code that actually ran.`,
    );
  }
  const baseDir = closureBaseDirOf(entryFile, identity);
  const target = paths.codeDir;
  if (fs.existsSync(target)) {
    assertStoredTreeMatches(target, identity);
    return { identity, baseDir, status: "already-present" };
  }
  return { identity, baseDir, status: "add" };
}

/** @internal Copies the closure into `code/`. Caller holds the lock. */
export function applyCodeAttachment(paths: RunDirectoryPaths, plan: CodeAttachmentPlan): void {
  if (plan.status === "already-present") return;
  const target = paths.codeDir;
  for (const file of plan.identity.closure) {
    const destination = path.join(target, file.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(plan.baseDir, file.file), destination);
  }
}

function closureBaseDirOf(entryFile: string, identity: CodeIdentity): string {
  // `entry` is relative to the base, so the base is the entry's real path with
  // that suffix removed.
  const realEntry = fs.realpathSync(path.resolve(entryFile));
  return realEntry.slice(0, realEntry.length - identity.entry.length - 1);
}

/** A stored tree with the right name but different contents is corruption,
 *  not something to paper over. */
function assertStoredTreeMatches(target: string, identity: CodeIdentity): void {
  const stored = identity.closure.map((file) => {
    const storedPath = path.join(target, file.file);
    if (!fs.existsSync(storedPath)) {
      throw new CodeMismatchError(
        `${target} is missing ${file.file}; the stored code tree is incomplete.`,
      );
    }
    return { file: file.file, sha256: hashFile(storedPath) };
  });
  const storedHash = closureHashOf(stored);
  if (storedHash !== identity.closureHash) {
    throw new CodeMismatchError(
      `${target} should hold closure hash ${identity.closureHash} but its files hash to ` +
        `${storedHash}; the stored code tree is corrupt.`,
    );
  }
}

function hashFile(filePath: string): string {
  return sha256Text(fs.readFileSync(filePath, "utf8"));
}
