import { runInBootstrapFrame } from "./asyncContext.js";
import type { HostSettings } from "../host/host.js";
import { __initAllRegisteredCallbacks } from "./crossModuleInitRegistry.js";
import type { AgencyCallbacks } from "./hooks.js";
import { CheckpointEditError, CheckpointError, type RestoreSignal } from "./errors.js";
import type { Policy } from "./policy.js";
import { loadConfiguredProviders } from "#platform";
import { assertCodeUnchanged } from "./referencedModules.js";
import { reinstallRootBudget } from "./rootBudget.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";
import type { Checkpoint, CheckpointJSON } from "./state/checkpointStore.js";
import type { PendingArgOverrides, RuntimeContext } from "./state/context.js";
import type { GlobalStore } from "./state/globalStore.js";
import type { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import { isAttachedResume, mintDebugRun } from "./debugRun.js";
import {
  fromOverrides,
  patchCheckpoint,
  stopOfCheckpoint,
  type CheckpointEdit,
  type ResumeOverrides,
  type StopAt,
} from "./state/checkpointPatch/index.js";
import { resolveFrame } from "./state/checkpointPatch/addresses.js";

export type { ResumeOverrides } from "./state/checkpointPatch/index.js";

export type ResumeMetadata = {
  callbacks?: AgencyCallbacks;
};

export type AfterCheckpointRestored = () => void;

/** What a resume changes in the checkpoint before restoring it: the
 *  old override shapes, which become edits on the frame at `at`, and
 *  edits proper. `at` is the stop the edits are made at, for a caller
 *  with a stop record; the checkpoint's own location otherwise. */
export type ResumeEdits = {
  overrides?: ResumeOverrides;
  edits?: CheckpointEdit[];
  at?: StopAt;
};

export type ResumeRequest = ResumeEdits & {
  checkpoint: Checkpoint;
  policy?: Policy;
  metadata?: ResumeMetadata;
  afterCheckpointRestored?: AfterCheckpointRestored;
};

type RestoreOverrideTarget = {
  stateStack: StateStack;
  globals: GlobalStore;
  _pendingArgOverrides?: PendingArgOverrides;
};

function checkedOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  const checked = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "__proto__") {
      throw new Error(`Resume request contains invalid override name "${key}"`);
    }
    checked[key] = value;
  }
  return checked;
}

/** A copy of `source` with the overrides and edits applied, re-signed
 *  under `settings` when it was signed. Throws `CheckpointEditError`
 *  with every reason when any edit is refused. */
export function applyResumeEdits(
  source: Checkpoint | CheckpointJSON,
  request: ResumeEdits,
  settings: HostSettings,
): Checkpoint {
  const edits = [
    ...fromOverrides(request.overrides ?? {}, source, request.at),
    ...(request.edits ?? []),
  ];
  const result = patchCheckpoint(source, edits, settings, request.at);
  if ("refused" in result) throw new CheckpointEditError(result.refused);
  return result.checkpoint;
}

/** A copy of `source` with `overrides` written into the frame the
 *  checkpoint was taken in, re-signed under `settings` when it was
 *  signed. */
export function applyLocalOverrides(
  source: Checkpoint,
  overrides: Record<string, unknown>,
  settings: HostSettings,
): Checkpoint {
  return applyResumeEdits(source, { overrides: { locals: overrides } }, settings);
}

/** The args of a function frame the program has not entered yet wait
 *  for its entry (`__takeArgOverrides`), keyed by the frame's scope.
 *  The frame is the one at `at`, the same frame `fromOverrides` writes
 *  the args into, so the two halves of an args override name one
 *  frame: inside a tool call that is the tool's frame, not the root's
 *  last. A node frame has been entered, so its args are never queued. */
export function applyRestoreOverrides(
  target: RestoreOverrideTarget,
  checkpoint: Checkpoint,
  overrides: Pick<ResumeOverrides, "args" | "globals"> = {},
  at: StopAt = stopOfCheckpoint(checkpoint),
): void {
  if (overrides.args) {
    const args = checkedOverrides(overrides.args);
    const frame = resolveFrame({ branchPath: at.branchPath }, checkpoint, at);
    if (!("refused" in frame) && frame.found.scopeName !== checkpoint.nodeId) {
      target._pendingArgOverrides = {
        moduleId: frame.found.moduleId ?? null,
        scopeName: frame.found.scopeName,
        values: args,
      };
    }
  }
  if (overrides.globals) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, checkpoint.moduleId)) {
      throw new Error(`Resume checkpoint contains invalid module id "${checkpoint.moduleId}"`);
    }
    for (const [name, value] of Object.entries(checkedOverrides(overrides.globals))) {
      target.globals.set(checkpoint.moduleId, name, value);
    }
  }
}

/** React to a `restore(cp)` the program made mid-run: count it against
 *  `maxRestores`, put the checkpoint's state back, and return the node to run
 *  next. Every run loop goes through here, so the limit holds on a fresh run,
 *  a resumed run, and a rewind alike. The limit matters because a restore also
 *  rewinds what a cost guard has spent, so a guard cannot stop a restore loop. */
export function applyRestoreSignal(
  execCtx: RuntimeContext<GraphState>,
  signal: RestoreSignal,
): string {
  execCtx._restoreCount++;
  if (execCtx._restoreCount > execCtx.maxRestores) {
    throw new CheckpointError(
      `Exceeded maximum number of restores (${execCtx.maxRestores}). Possible infinite loop.`,
    );
  }
  const cp = signal.checkpoint;
  execCtx.rootLog.checkpointRestored({
    checkpointId: cp.id,
    restoreCount: execCtx._restoreCount,
    maxRestores: execCtx.maxRestores,
    overrides: {
      args: !!signal.options?.args,
      globals: !!signal.options?.globals,
    },
  });
  execCtx.restoreState(cp);
  applyRestoreOverrides(execCtx, cp, signal.options);
  execCtx.stateStack.nodesTraversed = [cp.nodeId];
  return cp.nodeId;
}

export async function restoreForResume(
  execCtx: RuntimeContext<GraphState>,
  request: ResumeRequest,
): Promise<Checkpoint> {
  const settings = execCtx.host.settings;
  const checkpoint = applyResumeEdits(
    request.checkpoint,
    { overrides: request.overrides, edits: request.edits, at: request.at },
    settings,
  );
  assertCodeUnchanged(checkpoint.moduleFingerprints);
  installRunPolicyHandler(execCtx, request.policy);
  await loadConfiguredProviders(execCtx);

  execCtx._restoreCount++;
  execCtx.rootLog.checkpointRestored({
    checkpointId: checkpoint.id,
    restoreCount: execCtx._restoreCount,
  });
  request.afterCheckpointRestored?.();

  await runInBootstrapFrame(execCtx, (run) => __initAllRegisteredCallbacks(run));
  execCtx.restoreState(checkpoint);
  // A resume the attached debugger did not issue comes from outside, and
  // is a run of its own to the debugger: two resumes of one checkpoint
  // must not share a key (`debugRun.ts`).
  if (!isAttachedResume(request.metadata as Record<string, unknown> | undefined)) {
    mintDebugRun(execCtx);
  }
  reinstallRootBudget(execCtx.stateStack, execCtx.host, execCtx.budget);
  // Globals were written into the checkpoint by the edits above; the
  // args of a frame not yet entered still wait for its entry.
  applyRestoreOverrides(execCtx, checkpoint, { args: request.overrides?.args }, request.at);

  if (request.metadata?.callbacks) {
    Object.assign(execCtx.callbacks, request.metadata.callbacks);
  }
  return checkpoint;
}
