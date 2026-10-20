import type { Interrupt } from "./interrupts.js";
import { createDebugInterrupt } from "./interrupts.js";
import { callHook, hasCallbackConsumer } from "./hooks.js";
import { nativeTypeReplacer } from "./revivers/index.js";
import { Checkpoint } from "./state/checkpointStore.js";
import type { RuntimeContext } from "./state/context.js";
import type { SourceLocation } from "./state/sourceLocation.js";
import type { StateStack } from "./state/stateStack.js";
import type { Run } from "./asyncContext.js";

/** Where a debug stop happened, carried in the debug interrupt's `data`.
 *  The interrupt's checkpoint cannot say: once a stop inside a tool call
 *  joins its batch, that checkpoint is the shared one stamped from the
 *  `runPrompt` frame, whose location is the loop's. The driver reads the
 *  source line from this record, finds the stopped frame in the
 *  checkpoint by `branchPath` (`Checkpoint.frameAt`), and sets its
 *  stepping depth from `depth` when it shows the stop. */
export type DebugStopData = {
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** Branch keys from the root down to the stack the step ran on. */
  branchPath: string[];
  /** How many Agency calls deep the step is: the node's statements are
   *  at 0, a called function's or a tool's at one more than its caller. */
  depth: number;
  label: string | null;
};

export function isDebugStop(data: unknown): data is DebugStopData {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return typeof record.stepPath === "string" && Array.isArray(record.branchPath);
}

export async function debugStep(
  run: Run,
  info: Omit<SourceLocation, "nodeId" | "branchPath"> & {
    label: string | null;
    nodeContext: boolean;
    isUserAdded: boolean;
  },
  stack: StateStack,
): Promise<Interrupt[] | undefined> {
  const ctx: RuntimeContext<any> = run.ctx;
  // Global initialization runs outside any graph node, so there's no node
  // context to create checkpoints against. Skip debugging entirely.
  if (!ctx.stateStack.currentNodeId()) {
    return undefined;
  }

  const onRootStack = stack === ctx.stateStack;
  const location = {
    moduleId: info.moduleId,
    scopeName: info.scopeName,
    stepPath: info.stepPath,
    branchPath: stack.branchPath(),
  };

  // A rewind marks the checkpoint at its destination as already recorded.
  // Consume that marker here so later steps continue writing trace checkpoints.
  const skipCheckpoint = ctx._skipNextCheckpoint;
  ctx._skipNextCheckpoint = false;
  // A trace checkpoint and an `onCheckpoint` report cover root-stack steps
  // only. A trace checkpoint is a copy of the whole root stack, so one per
  // step inside every tool would multiply an agent run's trace by its
  // tool statements; and a host cannot re-enter a branch from outside.
  if (!skipCheckpoint && onRootStack) {
    const cp = Checkpoint.fromContext(ctx, location);
    await ctx.writeCheckpointToTraceWriter(cp);
    // The payload goes through nativeTypeReplacer so a scoped Agency
    // callback becomes a function ref the host can store and the resume
    // path can revive.
    if (hasCallbackConsumer(ctx, "onCheckpoint", stack)) {
      await callHook(run, {
        name: "onCheckpoint",
        data: {
          runId: ctx.getRunId(),
          checkpoint: JSON.parse(JSON.stringify(cp.toJSON(), nativeTypeReplacer)),
        },
      });
    }
  }

  const dbg = ctx.debuggerState;
  if (!dbg) {
    return undefined;
  }

  // The depth of this step is how many Agency calls deep the run is
  // (`withCallDepth` counts every call, a tool call included): the node's
  // statements are at 0, a called function's at 1, a tool's at one more
  // than the function that called `llm()`. A fork or parallel branch is
  // at its block's depth, like a loop body. When stepping, the debugger
  // stops at or above the depth the last command targeted: `next` targets
  // the depth it stopped at, `step out` one less, `step in` one more.
  // When running, only a `debugger()` statement stops it.
  const depth = run.callDepth?.depth ?? 0;
  const shouldPause = dbg.isStepping() ? dbg.shouldStopAt(depth) : info.isUserAdded;

  // The rolling checkpoint is stamped from the root even inside a branch:
  // the root holds every live branch stack, which is what a rewind
  // replays. Its location names the branch, so `getCurrentFrame` finds
  // the frame the step ran in.
  dbg.createRollingCheckpoint(ctx, location);

  if (!shouldPause) {
    return undefined;
  }

  // The halting checkpoint is stamped from the local stack, as a tool's
  // own interrupt and a guard trip are (the slice rule in
  // docs/dev/runtime/concurrent-interrupts.md). Inside a tool call the
  // tool loop stores it on the branch, and the shared checkpoint stamped
  // at the join carries the branch's frames in its slot. On resume the
  // `__dbg_` flag in the stopped frame makes the hook skip, so the stop
  // is not taken twice. Its location carries no branch path: the stack it
  // holds is the branch's own, so its frame is that stack's last one.
  const checkpointId = ctx.checkpoints.create(stack, ctx, {
    moduleId: info.moduleId,
    scopeName: info.scopeName,
    stepPath: info.stepPath,
  });
  const checkpoint = ctx.checkpoints.get(checkpointId);

  if (!checkpoint) {
    const debugData = {
      info,
      checkpointId,
    };
    throw new Error(`Failed to create debug checkpoint: ${JSON.stringify(debugData)}`);
  }

  // The depth is not recorded on `dbg` here: several branches can stop in
  // one round, and the driver sets the depth from the stop it shows.
  const stop: DebugStopData = { ...location, depth, label: info.label };
  const debugInterrupt = createDebugInterrupt(stop, checkpointId, checkpoint, ctx.getRunId());

  return [debugInterrupt];
}
