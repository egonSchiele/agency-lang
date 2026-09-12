import type { Checkpoint } from "./state/checkpointStore.js";
import { throwIfNodeResultAborted } from "./abortBoundary.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { RestoreSignal } from "./errors.js";
import { applyLocalOverrides, applyRestoreOverrides, restoreForResume } from "./resumeSetup.js";
import { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";
import { createReturnObject } from "./utils.js";
import { nanoid } from "nanoid";

export function applyOverrides(checkpoint: Checkpoint, overrides: Record<string, unknown>): void {
  const changed = applyLocalOverrides(checkpoint, overrides);
  Object.assign(checkpoint, changed);
}

export async function rewindFrom(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  overrides: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, overrides, metadata = {} } = args;
  // A rewind is conceptually a new execution: it builds a fresh execCtx
  // and replays from the checkpoint. The module-level `__globalCtx` that
  // callers pass in never has runId set (only per-run execCtx do), so we
  // mint one for trace correlation. Replays therefore appear as distinct
  // runs in trace files, which matches the actual execution semantics.
  const runId = (ctx as any).runId ?? nanoid();
  const execCtx = await ctx.createExecutionContext({ runId });
  try {
    const checkpoint = await restoreForResume(execCtx, {
      checkpoint: args.checkpoint,
      overrides: { locals: overrides },
      metadata,
    });
    execCtx._skipNextCheckpoint = true;
    let nodeName = checkpoint.nodeId;

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
        const result = await runInBootstrapFrame(execCtx, () =>
          execCtx.graph.run(
            nodeName,
            {
              data: {},
              ctx: execCtx,
              isResume: true,
            },
            {
              onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id),
              statelogClient: execCtx.statelogClient,
            },
          ),
        );
        await execCtx.pendingPromises.awaitAll();
        await throwIfNodeResultAborted(result, execCtx, { endsRun: false });
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          applyRestoreOverrides(execCtx, cp, e.options);
          nodeName = cp.nodeId;
          execCtx.stateStack.nodesTraversed = [cp.nodeId];
          continue;
        }
        throw e;
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
