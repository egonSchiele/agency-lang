import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { applyOverrides } from "./rewind.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { RuntimeContext } from "./state/context.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { Approved, GraphState, Rejected } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";
import { reviveWithClasses } from "./classReviver.js";
export {
  type ClassRegistry,
  createClassReviver,
  reviveWithClasses,
} from "./classReviver.js";

export type InterruptApprove = {
  type: "approve";
};

// modify = modify the args for a tool call
export type InterruptModify = {
  type: "modify";
  newArguments: Record<string, any>;
};

export type InterruptReject = {
  type: "reject";
};

// resolve = assign a specific value to a variable
// eg
// x = interrupt("What value should x have?")
export type InterruptResolve = {
  type: "resolve";
  value: any;
};

export type InterruptResponse =
  | InterruptApprove
  | InterruptModify
  | InterruptReject
  | InterruptResolve;

export type InterruptData = {
  // messages that have been exchanged in the prompt function
  // up till this interrupt was triggered. This is needed to restore
  // the message history for this specific prompt
  messages?: smoltalk.MessageJSON[];

  // which tool call caused the interrupt?
  toolCall?: smoltalk.ToolCallJSON;

  interruptResponse?: InterruptResponse;
};

export type InterruptState = {
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
};

export type Interrupt<T = any> = {
  type: "interrupt";
  interruptId: string; // nanoid — globally unique
  data: T;
  debugger?: boolean;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState; // kept for backward compat migration shim
  runId: string; // unique ID for the agent run, persists across interrupt pauses/resumes
};

export function interrupt<T = any>(data: T, runId: string): Interrupt<T> {
  return {
    type: "interrupt",
    interruptId: nanoid(),
    data,
    runId,
  };
}

export function createDebugInterrupt<T = any>(
  data: T,
  checkpointId: number,
  checkpoint: Checkpoint,
  runId: string,
): Interrupt<T> {
  return {
    type: "interrupt",
    interruptId: nanoid(),
    data,
    debugger: true,
    checkpointId,
    checkpoint,
    runId,
  };
}

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
}

export function hasInterrupts(data: any): data is Interrupt[] {
  return Array.isArray(data) && data.length > 0 && data.every(isInterrupt);
}

export function isDebugger(obj: any): obj is Interrupt {
  return isInterrupt(obj) === true && obj.debugger === true;
}

export function isRejected(obj: any): obj is Rejected {
  return obj && obj.type === "rejected";
}

export function isApproved(obj: any): obj is Approved {
  return obj && obj.type === "approved";
}

export async function interruptWithHandlers<T = any>(
  data: T,
  ctx: RuntimeContext<any>,
): Promise<Interrupt<T> | Approved | Rejected> {
  if (ctx.handlers.length === 0) {
    return interrupt(data, ctx.getRunId());
  }
  let approvedValue: any = undefined;
  let hasApproval = false;
  let hasPropagation = false;
  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    if (ctx.aborted) {
      throw new AgencyCancelledError();
    }
    // Enter tool call context so that the debugger treats handler execution
    // as atomic — debug hooks won't fire inside the handler body, just like
    // they don't fire inside LLM tool calls.
    ctx.enterToolCall();
    let result: any;
    try {
      result = await ctx.handlers[i](data);
    } finally {
      ctx.exitToolCall();
    }
    if (result === undefined) {
      continue;
    }
    if (result.type === "rejected") {
      return { type: "rejected", value: result.value };
    }
    if (result.type === "propagated") {
      hasPropagation = true;
      continue;
    }
    if (result.type === "approved") {
      hasApproval = true;
      approvedValue = result.value;
      continue;
    }
    throw new Error(
      `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approved", "rejected", "propagated", or undefined.`,
    );
  }
  if (hasPropagation) {
    return interrupt(data, ctx.getRunId());
  }
  if (hasApproval) {
    return { type: "approved", value: approvedValue };
  }
  return interrupt(data, ctx.getRunId());
}

// if we ever end up supporting multiple interrupts at once
/* export type InterruptBatch = {
  type: "interrupt_batch";
  interrupts: Interrupt[];
  checkpoint: Checkpoint;
};

export function isInterruptBatch(obj: any): obj is InterruptBatch {
  return obj && obj.type === "interrupt_batch";
}

function interruptBatch(
  interrupts: Interrupt[],
  execCtx: RuntimeContext<any>,
): InterruptBatch {
  const cpId = execCtx.checkpoints.create(execCtx, { moduleId: "", scopeName: "", stepPath: "" });
  const cp = execCtx.checkpoints.get(cpId);
  return {
    type: "interrupt_batch",
    interrupts,
    checkpoint: cp,
  };
}
 */
export async function respondToInterrupt(args: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  interruptResponse: InterruptResponse;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const interrupt = deepClone(args.interrupt);
  const interruptResponse = deepClone(args.interruptResponse);
  const { ctx, metadata = {} } = args;

  const checkpoint =
    interrupt.checkpoint ??
    (interrupt.checkpointId !== undefined
      ? ctx.checkpoints?.get(interrupt.checkpointId)
      : undefined);
  if (!checkpoint) {
    throw new Error(
      "No checkpoint found for interrupt. The interrupt may have been created with an older format.",
    );
  }

  if (args.overrides) {
    applyOverrides(checkpoint, args.overrides);
  }

  const execCtx = await ctx.createExecutionContext(interrupt.runId);
  execCtx.restoreState(checkpoint);

  execCtx.installRegisteredCallbacks(ctx);
  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let interruptData: InterruptData | undefined = interrupt.interruptData || {};

  if (interrupt.debugger && !interrupt.interruptData?.toolCall) {
    // Debugger-generated interrupts don't carry tool-call data,
    // unless the debug pause happened inside a tool call during an LLM call —
    // in that case, keep interruptData so runPrompt can resume mid-conversation.
    interruptData = undefined;
  } else {
    interruptData.interruptResponse = interruptResponse;

    if (interruptResponse.type === "modify") {
      interruptData.toolCall!.arguments = {
        ...interruptData.toolCall!.arguments,
        ...interruptResponse.newArguments,
      };
    }
  }

  let nodeName = checkpoint.nodeId;
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            data: {},
            ctx: execCtx,
            isResume: true,
            interruptData,
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
        );
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });
        if (isInterrupt(returnObject.data)) {
          await execCtx.pauseTraceWriter();
        } else {
          await execCtx.closeTraceWriter();
        }
        return returnObject;
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

export async function approveInterrupt({
  ctx,
  interrupt,
  overrides,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "approve" },
    overrides,
    metadata,
  });
}

export async function modifyInterrupt({
  ctx,
  interrupt,
  newArguments,
  overrides,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  newArguments: Record<string, any>;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "modify", newArguments },
    overrides,
    metadata,
  });
}

export async function rejectInterrupt({
  ctx,
  interrupt,
  overrides,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "reject" },
    overrides,
    metadata,
  });
}

export async function resolveInterrupt({
  ctx,
  interrupt,
  value,
  overrides,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  value: any;
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "resolve", value },
    overrides,
    metadata,
  });
}
