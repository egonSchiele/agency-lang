import type { Checkpoint } from "./state/checkpointStore.js";
import { RestoreSignal } from "./errors.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import type { GraphState } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";
import { isInterrupt } from "./interrupts.js";
import { color } from "termcolors";

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

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint.checkpoint);
  execCtx._skipNextCheckpoint = true;

  execCtx.installRegisteredCallbacks(ctx);
  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let nodeName = checkpoint.checkpoint.nodeId;

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            data: {},
            ctx: execCtx,
            isResume: true,
          },
          {
            onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id),
          },
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
