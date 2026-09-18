import type { DebuggerState } from "../debugger/debuggerState.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { signCheckpoint } from "./checkpointChecksum.js";
import { __initAllRegisteredCallbacks } from "./crossModuleInitRegistry.js";
import type { AgencyCallbacks } from "./hooks.js";
import { CheckpointError, type RestoreSignal } from "./errors.js";
import { ensureConfiguredLocalProvider } from "./localProvider.js";
import type { Policy } from "./policy.js";
import { loadProviderModules } from "./providerModules.js";
import { assertCodeUnchanged } from "./referencedModules.js";
import { reinstallRootBudget } from "./rootBudget.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import type { PendingArgOverrides, RuntimeContext } from "./state/context.js";
import type { GlobalStore } from "./state/globalStore.js";
import { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import { deepClone } from "./utils.js";

export type ResumeOverrides = {
  locals?: Record<string, unknown>;
  args?: Record<string, unknown>;
  globals?: Record<string, unknown>;
};

export type ResumeMetadata = {
  callbacks?: AgencyCallbacks;
  debugger?: DebuggerState;
};

export type AfterCheckpointRestored = () => void;

export type ResumeRequest = {
  checkpoint: Checkpoint;
  policy?: Policy;
  overrides?: ResumeOverrides;
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

export function applyLocalOverrides(
  source: Checkpoint,
  overrides: Record<string, unknown> = {},
): Checkpoint {
  const checkpoint = deepClone(source);
  const frame = StateStack.lastFrameJSON(checkpoint.stack);
  for (const [key, value] of Object.entries(checkedOverrides(overrides))) {
    frame.locals[key] = value;
  }
  if (checkpoint.signature !== undefined) {
    signCheckpoint(checkpoint);
  }
  return checkpoint;
}

export function applyRestoreOverrides(
  target: RestoreOverrideTarget,
  checkpoint: Checkpoint,
  overrides: Pick<ResumeOverrides, "args" | "globals"> = {},
): void {
  if (overrides.args) {
    const args = checkedOverrides(overrides.args);
    const frame = StateStack.lastFrameJSON(checkpoint.stack);
    if (frame.scopeName !== checkpoint.nodeId) {
      target._pendingArgOverrides = {
        moduleId: frame.moduleId ?? null,
        scopeName: frame.scopeName,
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
  execCtx.statelogClient.checkpointRestored({
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
  const checkpoint = applyLocalOverrides(request.checkpoint, request.overrides?.locals);
  if (request.overrides?.args) {
    for (const [name, value] of Object.entries(checkedOverrides(request.overrides.args))) {
      StateStack.lastFrameJSON(checkpoint.stack).args[name] = value;
    }
    if (checkpoint.signature !== undefined) {
      signCheckpoint(checkpoint);
    }
  }
  assertCodeUnchanged(checkpoint.moduleFingerprints);
  installRunPolicyHandler(execCtx, request.policy);
  await loadProviderModules(execCtx);
  await ensureConfiguredLocalProvider(execCtx);

  execCtx._restoreCount++;
  execCtx.statelogClient.checkpointRestored({
    checkpointId: checkpoint.id,
    restoreCount: execCtx._restoreCount,
  });
  request.afterCheckpointRestored?.();

  await runInBootstrapFrame(execCtx, () => __initAllRegisteredCallbacks(execCtx));
  execCtx.restoreState(checkpoint);
  reinstallRootBudget(execCtx.stateStack, execCtx.budget);
  applyRestoreOverrides(execCtx, checkpoint, {
    args: request.overrides?.args,
    globals: request.overrides?.globals,
  });

  if (request.metadata?.callbacks) {
    Object.assign(execCtx.callbacks, request.metadata.callbacks);
  }
  if (request.metadata?.debugger) {
    execCtx.debuggerState = request.metadata.debugger;
  }
  return checkpoint;
}
