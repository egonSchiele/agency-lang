import { acquireRunDirLock, type RunDirLock } from "@/runDirectory/lock.js";

// The lock is run-directory infrastructure now (lib/runDirectory/lock.ts). This
// shim keeps the label store's names until Phase 5 replaces the store.
export type DatasetLock = RunDirLock;
export type AcquireStoreLockArgs = { datasetDir: string; reportWarning(message: string): void };

export function acquireDatasetLock(args: AcquireStoreLockArgs): DatasetLock {
  return acquireRunDirLock({ dir: args.datasetDir, reportWarning: args.reportWarning });
}
