import { defaultHost } from "#default-host";
import type { HostSettings } from "../host/host.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import { throwIfNodeResultAborted } from "./abortBoundary.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { RestoreSignal } from "./errors.js";
import { applyLocalOverrides, applyRestoreSignal, restoreForResume } from "./resumeSetup.js";
import { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";
import { createReturnObject } from "./utils.js";
import { nanoid } from "nanoid";

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
        if (e instanceof RestoreSignal) {
          nodeName = applyRestoreSignal(execCtx, e);
          continue;
        }
        throw e;
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
