import type { StateJSON, StateStackJSON } from "./state/stateStack.js";
import { getModuleFingerprint, type ModuleFingerprint } from "./moduleFingerprintRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

/** Collect the fingerprint of every module that has a live frame on the
 *  stack (nested branch stacks included). Frames with no claimed module
 *  (bootstrap frames, runtime builtins like runPrompt) are skipped. */
export function collectModuleFingerprints(
  stackJson: StateStackJSON,
): Record<string, ModuleFingerprint> {
  const fingerprints: Record<string, ModuleFingerprint> = Object.create(null);
  const visitStack = (stack: StateStackJSON | undefined): void => {
    if (!stack) {
      return;
    }
    for (const frame of stack.stack) {
      visitFrame(frame);
    }
  };
  const visitFrame = (frame: StateJSON): void => {
    if (frame.moduleId) {
      const fingerprint = getModuleFingerprint(frame.moduleId);
      if (fingerprint !== undefined) {
        fingerprints[frame.moduleId] = fingerprint;
      }
    }
    for (const branch of Object.values(frame.branches ?? {})) {
      visitStack(branch.stack);
    }
  };
  visitStack(stackJson);
  return fingerprints;
}

/** Throw if any stored module fingerprint no longer matches the loaded code.
 *  Runs on resume BEFORE any state is restored. A module missing from the
 *  registry counts as changed. */
export function assertCodeUnchanged(
  moduleFingerprints: Record<string, ModuleFingerprint> | undefined,
): void {
  if (!moduleFingerprints) {
    return;
  }
  for (const [moduleId, stored] of Object.entries(moduleFingerprints)) {
    const current = getModuleFingerprint(moduleId);
    if (current?.hash !== stored.hash) {
      throw new CheckpointCodeChangedError(moduleId, stored.compiledAt, current?.compiledAt);
    }
  }
}
