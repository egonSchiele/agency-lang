import { deepClone } from "./utils.js";
import { createReturnObject } from "./utils.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { RestoreSignal } from "./errors.js";
import * as smoltalk from "smoltalk";
import { RuntimeContext } from "./state/context.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import { GraphState, Rejected, Approved } from "./types.js";
import { ThreadStore } from "./state/threadStore.js";
import { color } from "termcolors";
import { nanoid } from "nanoid";

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
  //interruptId: string; // nanoid — globally unique
  data: T;
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

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
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
  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    const result = await ctx.handlers[i](data);
    if (result === undefined) {
      await ctx.audit({ type: "handlerResult", handlerIndex: i, data, result: "passthrough" });
      continue;
    }
    if (result.type === "rejected") {
      await ctx.audit({ type: "handlerResult", handlerIndex: i, data, result: "rejected", value: result.value });
      await ctx.audit({ type: "handlerDecision", data, decision: "rejected", value: result.value });
      return { type: "rejected", value: result.value };
    }
    if (result.type === "approved") {
      await ctx.audit({ type: "handlerResult", handlerIndex: i, data, result: "approved", value: result.value });
      hasApproval = true;
      approvedValue = result.value;
      continue;
    }
    throw new Error(
      `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approved", "rejected", or undefined.`,
    );
  }
  if (hasApproval) {
    await ctx.audit({ type: "handlerDecision", data, decision: "approved", value: approvedValue });
    return { type: "approved", value: approvedValue };
  }
  await ctx.audit({ type: "handlerDecision", data, decision: "unhandled" });
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
  const cpId = execCtx.checkpoints.create(execCtx);
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
  metadata?: Record<string, any>;
}): Promise<any> {
  // console.log(color.green(JSON.stringify({ args }, null, 2)));
  //const { interrupt, interruptResponse, metadata = {} } = args;
  const interrupt = deepClone(args.interrupt);
  const interruptResponse = deepClone(args.interruptResponse);
  const { ctx, metadata = {} } = args;

  // Migration shim for old-format interrupts
  if (interrupt.state && !interrupt.checkpoint) {
    const nodesTraversed = interrupt.state.stack.nodesTraversed || [];
    interrupt.checkpoint = {
      id: -1,
      stack: interrupt.state.stack,
      globals: interrupt.state.globals,
      nodeId: nodesTraversed[nodesTraversed.length - 1],
    };
  }

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

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  const interruptData = interrupt.interruptData || {};

  interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "modify") {
    interruptData.toolCall!.arguments = {
      ...interruptData.toolCall!.arguments,
      ...interruptResponse.newArguments,
    };
  }

  let nodeName = checkpoint.nodeId;
  await execCtx.audit({ type: "interrupt", nodeName, args: interruptResponse });
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            // todo user should be able to pass messages
            // in metadata
            messages: new ThreadStore(),
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

export async function approveInterrupt({
  ctx,
  interrupt,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "approve" },
    metadata,
  });
}

export async function modifyInterrupt({
  ctx,
  interrupt,
  newArguments,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  newArguments: Record<string, any>;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "modify", newArguments },
    metadata,
  });
}

export async function rejectInterrupt({
  ctx,
  interrupt,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "reject" },
    metadata,
  });
}

export async function resolveInterrupt({
  ctx,
  interrupt,
  value,
  metadata,
}: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  value: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx,
    interrupt,
    interruptResponse: { type: "resolve", value },
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
  execCtx.stateStack = StateStack.fromJSON(args.state.stack);
  execCtx.stateStack.deserializeMode();
  execCtx.globals = GlobalStore.fromJSON(args.state.globals);

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
            // todo: is this correct? Do we need to pass messages here?
            messages: new ThreadStore(),
            ctx: execCtx,
            isResume: true,
            data: {},
            //interruptData
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
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
