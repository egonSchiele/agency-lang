import type { Checkpoint } from "./state/checkpointStore.js";
import { runInBootstrapFrame } from "./asyncContext.js";
import { __initAllRegisteredCallbacks } from "./crossModuleInitRegistry.js";
import { RestoreSignal } from "./errors.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
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
  // See runNode's docstring on the same field — seeded by generated
  // code so the rewound graph's stdlib helpers resolve paths against
  // the compiled module dir.
  moduleDir?: string;
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
  // in `respondToInterrupts`. The bootstrap frame is also mirrored
  // from there — top-level callback registration runs Agency code
  // (the `callback(...)` wrapper) that needs an ALS frame for
  // `__call` post-migration. See `runInBootstrapFrame` in
  // lib/runtime/asyncContext.ts.
  await runInBootstrapFrame(
    execCtx,
    () => __initAllRegisteredCallbacks(execCtx),
    { moduleDir: args.moduleDir },
  );
  execCtx.restoreState(checkpoint);
  execCtx._skipNextCheckpoint = true;

  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let nodeName = checkpoint.nodeId;

  try {
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
        const result = await runInBootstrapFrame(
          execCtx,
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
          { moduleDir: args.moduleDir },
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
