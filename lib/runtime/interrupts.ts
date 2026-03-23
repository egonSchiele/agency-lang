import { deepClone } from "./utils.js";
import { createReturnObject } from "./utils.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { RestoreSignal } from "./errors.js";
import * as smoltalk from "smoltalk";
import { RuntimeContext } from "./state/context.js";
import type { Checkpoint } from "./state/checkpointStore.js";
import { GraphState } from "./types.js";
import { ThreadStore } from "./state/threadStore.js";
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
  interrupt_id: string;    // nanoid — globally unique
  data: T;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState;  // kept for backward compat migration shim
};

export function interrupt<T = any>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    interrupt_id: nanoid(),
    data,
  };
}

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
}

export type InterruptBatch = {
  type: "interrupt_batch";
  interrupts: Interrupt[];
  checkpoint: Checkpoint;
};

export function isInterruptBatch(obj: any): obj is InterruptBatch {
  return obj && obj.type === "interrupt_batch";
}

export async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: Checkpoint;
  responses: Record<string, InterruptResponse>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;
  const responses = deepClone(args.responses);

  const checkpoint = args.checkpoint;
  if (!checkpoint) {
    throw new Error("No checkpoint provided for respondToInterrupts.");
  }

  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  // Store responses on the execution context so deserialization can access them
  (execCtx as any).__interruptResponses = responses;

  let nodeName = checkpoint.nodeId;

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(nodeName, {
          messages: new ThreadStore(),
          data: {},
          ctx: execCtx,
          isResume: true,
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        const interrupts = await execCtx.pendingPromises.awaitAll();
        if (interrupts.length > 0) {
          const cpId = execCtx.checkpoints.create(execCtx);
          const cp = execCtx.checkpoints.get(cpId);
          return {
            type: "interrupt_batch",
            interrupts,
            checkpoint: cp,
          };
        }
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
        const result = await execCtx.graph.run(nodeName, {
          // todo: is this correct? Do we need to pass messages here?
          messages: new ThreadStore(),
          ctx: execCtx,
          isResume: true,
          data: {},
          //interruptData
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        await execCtx.pendingPromises.awaitAll();
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          await execCtx.audit({ type: "restore", checkpointId: cp.id, nodeName: cp.nodeId });
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
