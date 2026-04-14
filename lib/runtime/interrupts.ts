import * as smoltalk from "smoltalk";
import { RestoreSignal } from "./errors.js";
import { applyOverrides } from "./rewind.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { RuntimeContext } from "./state/context.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { Approved, GraphState, Rejected } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";

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

import { reviveWithClasses } from "./classReviver.js";
export { type ClassRegistry, createClassReviver, reviveWithClasses } from "./classReviver.js";

export type Interrupt<T = any> = {
  type: "interrupt";
  //interruptId: string; // nanoid — globally unique
  data: T;
  debugger?: boolean;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState; // kept for backward compat migration shim
};

export function interrupt<T = any>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    //interruptId: nanoid(),
    data,
  };
}

export function createDebugInterrupt<T = any>(
  data: T,
  checkpointId: number,
  checkpoint: Checkpoint,
): Interrupt<T> {
  return {
    type: "interrupt",
    data,
    debugger: true,
    checkpointId,
    checkpoint,
  };
}

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
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
    return interrupt(data);
  }
  let approvedValue: any = undefined;
  let hasApproval = false;
  let hasPropagation = false;
  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    const result = await ctx.handlers[i](data);
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
    return interrupt(data);
  }
  if (hasApproval) {
    return { type: "approved", value: approvedValue };
  }
  return interrupt(data);
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

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let interruptData: InterruptData | undefined = interrupt.interruptData || {};

  if (interrupt.debugger) {
    // Debugger-generated interrupts don't carry tool-call data
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

export async function resumeFromState(args: {
  ctx: RuntimeContext<GraphState>;
  state: InterruptState;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;

  const execCtx = ctx.createExecutionContext();

  // Revive class instances in the serialized state if any classes are registered
  const state = Object.keys(ctx.classRegistry).length > 0
    ? reviveWithClasses(args.state, ctx.classRegistry)
    : args.state;

  execCtx.stateStack = StateStack.fromJSON(state.stack);
  execCtx.stateStack.deserializeMode();
  execCtx.globals = GlobalStore.fromJSON(state.globals);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  const nodesTraversed = execCtx.stateStack.nodesTraversed || [];
  let nodeName = nodesTraversed[nodesTraversed.length - 1];

  if (!nodeName) {
    throw new Error("No resumable node found in state file.");
  }

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            ctx: execCtx,
            isResume: true,
            data: {},
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
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
