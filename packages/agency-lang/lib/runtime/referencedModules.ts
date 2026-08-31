import type { StateJSON, StateStackJSON } from "./state/stateStack.js";
import { getModuleSourceHash, type ModuleSourceEntry } from "./moduleSourceHashRegistry.js";
import { CheckpointCodeChangedError } from "./errors.js";

/** Collect the source entry of every module that has a live frame on the
 *  stack (nested branch stacks included). Frames with no claimed module
 *  (bootstrap frames, runtime builtins like runPrompt) are skipped. */
export function collectModuleSourceHashes(
  stackJson: StateStackJSON,
): Record<string, ModuleSourceEntry> {
  const entries: Record<string, ModuleSourceEntry> = Object.create(null);
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
      const entry = getModuleSourceHash(frame.moduleId);
      if (entry !== undefined) {
        entries[frame.moduleId] = entry;
      }
    }
    for (const branch of Object.values(frame.branches ?? {})) {
      visitStack(branch.stack);
    }
  };
  visitStack(stackJson);
  return entries;
}

/** Throw if any stored module hash no longer matches the loaded code. Runs on
 *  resume BEFORE any state is restored. A module missing from the registry
 *  counts as changed. */
export function assertCodeUnchanged(
  moduleSourceHashes: Record<string, ModuleSourceEntry> | undefined,
): void {
  if (!moduleSourceHashes) {
    return;
  }
  for (const [moduleId, stored] of Object.entries(moduleSourceHashes)) {
    const current = getModuleSourceHash(moduleId);
    if (current?.hash !== stored.hash) {
      throw new CheckpointCodeChangedError(moduleId, stored.compiledAt, current?.compiledAt);
    }
  }
}
