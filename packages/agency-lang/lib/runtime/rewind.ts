import { defaultHost } from "#default-host";
import type { HostSettings } from "../host/host.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import { throwIfNodeResultAborted } from "./abortBoundary.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { RestoreSignal } from "./errors.js";
import { applyLocalOverrides, applyRestoreSignal, restoreForResume } from "./resumeSetup.js";
import { RuntimeContext } from "./state/context.js";
import { resolveInvocation, type InvocationOptions } from "./invocationOptions.js";
import type { GraphState, RunNodeCoreResult } from "./types.js";
import { createReturnObject } from "./utils.js";
import { nanoid } from "nanoid";
import { isAttachedResume, settleStops } from "./attachedDebugger.js";
import { withExternalSignals } from "./externalSignals.js";
import { unwrapWithUsage, type ServedInvocationOutcome } from "./invocationUsage.js";
import { PauseSignal } from "./errors.js";
import { pausedReturnObject } from "./pause.js";

/** Write `overrides` into the checkpoint's last frame in place, re-signing
 *  it under `settings` when it was signed. A caller outside any run, such
 *  as a host editing a checkpoint it holds, gets the platform's default
 *  host. */
export function applyOverrides(
  checkpoint: Checkpoint,
  overrides: Record<string, unknown>,
  settings: HostSettings = defaultHost().settings,
): void {
  const changed = applyLocalOverrides(checkpoint, overrides, settings);
  Object.assign(checkpoint, changed);
}

/** Replay from `checkpoint` with `overrides` written into its last frame.
 *  Like a resume, the result carries the run's `usage` and `traceId`, the
 *  caller's cancel and pause signals reach the replay, and an attached
 *  debugger answers the replay's debug stops before it returns
 *  (`settleStops`). */
export async function rewindFrom(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  overrides: Record<string, unknown>;
  metadata?: Record<string, any>;
  /** The root policy and per-invocation config of the run being replayed,
   *  with the same contract as a resume: the caller that started the run
   *  with them passes them again, and the restore installs them. */
  invocation?: InvocationOptions;
  abortSignal?: AbortSignal;
  pauseSignal?: AbortSignal;
}): Promise<any> {
  const { ctx, overrides, metadata = {} } = args;
  const signals = { abortSignal: args.abortSignal, pauseSignal: args.pauseSignal };
  const outcome = await replayFrom(args, signals);
  if (isAttachedResume(metadata)) {
    return unwrapWithUsage(outcome);
  }
  const settled = await settleStops(ctx, outcome, {
    invocation: args.invocation,
    callbacks: metadata.callbacks,
    ...signals,
  });
  return unwrapWithUsage(settled);
}

async function replayFrom(
  args: Parameters<typeof rewindFrom>[0],
  signals: { abortSignal?: AbortSignal; pauseSignal?: AbortSignal },
): Promise<ServedInvocationOutcome<RunNodeCoreResult<any>>> {
  const { ctx, overrides, metadata = {} } = args;
  // A rewind is conceptually a new execution: it builds a fresh execCtx
  // and replays from the checkpoint. The module-level `__globalCtx` that
  // callers pass in never has runId set (only per-run execCtx do), so we
  // mint one for trace correlation. Replays therefore appear as distinct
  // runs in trace files, which matches the actual execution semantics.
  const runId = (ctx as any).runId ?? nanoid();
  const resolved = resolveInvocation({ kind: "resume", options: args.invocation, runId });
  const execCtx = await ctx.createExecutionContext(resolved);
  try {
    const checkpoint = await restoreForResume(execCtx, {
      checkpoint: args.checkpoint,
      policy: resolved.policy,
      overrides: { locals: overrides },
      metadata,
    });
    execCtx._skipNextCheckpoint = true;
    const value = await withExternalSignals(execCtx, signals, () =>
      replayLoop(execCtx, checkpoint.nodeId),
    );
    return {
      status: "returned",
      value,
      usage: execCtx.invocationUsage.snapshot(),
      traceId: execCtx.getRunId(),
    };
  } finally {
    execCtx.cleanup();
  }
}

async function replayLoop(
  execCtx: RuntimeContext<GraphState>,
  startNodeName: string,
): Promise<RunNodeCoreResult<any>> {
  let nodeName = startNodeName;
  {
    while (true) {
      try {
        // See `runResumeLoop` in lib/runtime/interrupts.ts — stdlib
        // helpers and `callHook` lookups go through
        // `getRuntimeContext()` now, so the rewind path needs to
        // seed its own ALS frame too. This is a bootstrap frame:
        // generated node bodies re-enter ALS inside each
        // `Runner.runInScope` with the per-scope ThreadStore
        // reconstituted by `setupNode` — nothing user-facing should
        // reach for `threads` in the slice covered by this wrap.
        const result = await runInBootstrapFrame(execCtx, (run) =>
          execCtx.graph.run(
            nodeName,
            {
              data: {},
              ctx: execCtx,
              isResume: true,
              run,
            },
            {
              onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id),
              statelogClient: execCtx.rootLogWithSpans,
            },
          ),
        );
        await execCtx.pendingPromises.awaitAll();
        await throwIfNodeResultAborted(result, execCtx, { endsRun: false });
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof PauseSignal) {
          return await pausedReturnObject(execCtx, e);
        }
        if (e instanceof RestoreSignal) {
          nodeName = applyRestoreSignal(execCtx, e);
          continue;
        }
        throw e;
      }
    }
  }
}
