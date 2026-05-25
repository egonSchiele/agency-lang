import type { Checkpoint } from "./state/checkpointStore.js";
import { agencyStore } from "./asyncContext.js";
import { RestoreSignal } from "./errors.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import type { GraphState } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";
import { color } from "@/utils/termcolors.js";
import { nanoid } from "nanoid";

export function applyOverrides(
  checkpoint: Checkpoint,
  overrides: Record<string, unknown>,
): void {
  const frame = StateStack.lastFrameJSON(checkpoint.stack);
  for (const [key, value] of Object.entries(overrides)) {
    frame.locals[key] = value;
  }
}

export async function rewindFrom(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  overrides: Record<string, unknown>;
  metadata?: Record<string, any>;
  // See respondToInterrupts / runNode — every fresh execCtx loses
  // ctx.topLevelCallbacks and needs to re-run module-level
  // `callback(...)` registrations.
  registerTopLevelCallbacks?: (
    ctx: RuntimeContext<GraphState>,
  ) => void | Promise<void>;
}): Promise<any> {
  const { ctx, overrides, metadata = {} } = args;
  const checkpoint = deepClone(args.checkpoint);

  applyOverrides(checkpoint, overrides);

  // A rewind is conceptually a new execution: it builds a fresh execCtx
  // and replays from the checkpoint. The module-level `__globalCtx` that
  // callers pass in never has runId set (only per-run execCtx do), so we
  // mint one for trace correlation. Replays therefore appear as distinct
  // runs in trace files, which matches the actual execution semantics.
  const runId = (ctx as any).runId ?? nanoid();
  const execCtx = await ctx.createExecutionContext(runId);
  // Must run before restoreState so the empty stack routes the
  // registration to `ctx.topLevelCallbacks`. See the matching comment
  // in `respondToInterrupts`. The `agencyStore.run` wrap is also
  // mirrored from there — top-level callback registration runs
  // Agency code (the `callback(...)` wrapper) that needs an ALS
  // frame for `__call` post-migration.
  const bootstrapThreads = ThreadStore.withDefaultActive(execCtx.statelogClient);
  if (args.registerTopLevelCallbacks) {
    await agencyStore.run(
      { ctx: execCtx, stack: execCtx.stateStack, threads: bootstrapThreads },
      () => args.registerTopLevelCallbacks!(execCtx),
    );
  }
  execCtx.restoreState(checkpoint);
  execCtx._skipNextCheckpoint = true;

  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let nodeName = checkpoint.nodeId;
  // See `runResumeLoop` in lib/runtime/interrupts.ts — stdlib helpers
  // and `callHook` lookups go through `getRuntimeContext()` now, so the
  // rewind path needs to seed its own ALS frame too. The threads slot is
  // a placeholder; generated node bodies re-enter ALS inside each
  // `Runner.runInScope` with the per-scope ThreadStore.
  const threadStore = ThreadStore.withDefaultActive(execCtx.statelogClient);

  try {
    while (true) {
      try {
        const result = await agencyStore.run(
          { ctx: execCtx, stack: execCtx.stateStack, threads: threadStore },
          () =>
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
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
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
