import type { DebuggerState } from "../debugger/debuggerState.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { signCheckpoint } from "./checkpointChecksum.js";
import { __initAllRegisteredCallbacks } from "./crossModuleInitRegistry.js";
import type { AgencyCallbacks } from "./hooks.js";
import { ensureConfiguredLocalProvider } from "./localProvider.js";
import type { Policy } from "./policy.js";
import { loadProviderModules } from "./providerModules.js";
import { assertCodeUnchanged } from "./referencedModules.js";
import { reinstallRootBudget } from "./rootBudget.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
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
  _pendingArgOverrides?: Record<string, unknown>;
};

export function applyLocalOverrides(
  source: Checkpoint,
  overrides: Record<string, unknown> = {},
): Checkpoint {
  const checkpoint = deepClone(source);
  const frame = StateStack.lastFrameJSON(checkpoint.stack);
  for (const [key, value] of Object.entries(overrides)) {
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
    target._pendingArgOverrides = overrides.args;
  }
  if (overrides.globals) {
    for (const [name, value] of Object.entries(overrides.globals)) {
      target.globals.set(checkpoint.moduleId, name, value);
    }
  }
}

export async function restoreForResume(
  execCtx: RuntimeContext<GraphState>,
  request: ResumeRequest,
): Promise<Checkpoint> {
  const checkpoint = applyLocalOverrides(request.checkpoint, request.overrides?.locals);
  if (request.overrides?.args) {
    Object.assign(StateStack.lastFrameJSON(checkpoint.stack).args, request.overrides.args);
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
  applyRestoreOverrides(execCtx, checkpoint, { globals: request.overrides?.globals });

  if (request.metadata?.callbacks) {
    Object.assign(execCtx.callbacks, request.metadata.callbacks);
  }
  if (request.metadata?.debugger) {
    execCtx.debuggerState = request.metadata.debugger;
  }
  return checkpoint;
}
