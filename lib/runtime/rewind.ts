import type { Checkpoint } from "./state/checkpointStore.js";
import { RestoreSignal } from "./errors.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import type { GraphState } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";

export type RewindCheckpoint = {
  checkpoint: Checkpoint;
  llmCall: {
    step: number;
    targetVariable: string;
    prompt: string;
    response: unknown;
    model: string;
  };
};

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
  checkpoint: RewindCheckpoint;
  overrides: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, overrides, metadata = {} } = args;
  const checkpoint = deepClone(args.checkpoint);

  applyOverrides(checkpoint.checkpoint, overrides);
  await ctx.audit({
    type: "override",
    overrides,
    source: "rewind",
  });

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint.checkpoint);
  execCtx._skipNextCheckpoint = true;

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  if (metadata.debugger) {
    execCtx.debugger = metadata.debugger;
  }

  let nodeName = checkpoint.checkpoint.nodeId;

  await execCtx.audit({
    type: "rewind",
    nodeName,
    step: checkpoint.llmCall.step,
    overrides,
  });

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            messages: new ThreadStore(),
            data: {},
            ctx: execCtx,
            isResume: true,
          },
          {
            onNodeEnter: (id) =>
              execCtx.stateStack.nodesTraversed.push(id),
          },
        );
        await execCtx.pendingPromises.awaitAll();
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          await execCtx.audit({
            type: "restore",
            checkpointId: cp.id,
            nodeName: cp.nodeId,
          });
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
