import type { StateJSON, StateStackJSON } from "./state/stateStack.js";
import { getModuleSourceHash } from "./moduleSourceHashRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

/** Walk every frame in the stack (and nested branch stacks) and collect the
 *  source hash of each frame's module that has one registered. Frames with no
 *  claimed module (bootstrap frames, runtime builtins like runPrompt) are
 *  skipped. */
export function collectModuleSourceHashes(stackJson: StateStackJSON): Record<string, string> {
  const hashes: Record<string, string> = {};
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
      const hash = getModuleSourceHash(frame.moduleId);
      if (hash !== undefined) {
        hashes[frame.moduleId] = hash;
      }
    }
    for (const branch of Object.values(frame.branches ?? {})) {
      visitStack(branch.stack);
    }
  };
  visitStack(stackJson);
  return hashes;
}

/** Throw if any stored module hash no longer matches the loaded code. Runs on
 *  resume BEFORE any state is restored, so an out-of-date checkpoint is never
 *  partially executed. A module missing from the registry counts as changed
 *  (deleted, renamed, or compiled from a different directory). */
export function assertCodeUnchanged(moduleSourceHashes: Record<string, string> | undefined): void {
  if (!moduleSourceHashes) {
    return;
  }
  for (const [moduleId, storedHash] of Object.entries(moduleSourceHashes)) {
    if (getModuleSourceHash(moduleId) !== storedHash) {
      throw new CheckpointCodeChangedError(moduleId);
    }
  }
}
