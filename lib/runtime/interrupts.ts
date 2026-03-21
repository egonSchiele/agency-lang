import { deepClone } from "./utils.js";
import { createReturnObject } from "./utils.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import * as smoltalk from "smoltalk";
import { RuntimeContext } from "./state/context.js";
import { GraphState } from "./types.js";
import { ThreadStore } from "./state/threadStore.js";
import { color } from "termcolors";

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
  data: T;
  interruptData?: InterruptData;
  state?: InterruptState;
};

export function interrupt<T = any>(data: T): Interrupt<T> {
  return {
    type: "interrupt",
    data,
  };
}

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
}

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

  const execCtx = ctx.createExecutionContext();
  const savedState = interrupt.state!;
  execCtx.stateStack = StateStack.fromJSON(savedState.stack);
  execCtx.stateStack.deserializeMode();
  execCtx.globals = GlobalStore.fromJSON(savedState.globals);

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

  // start at the last node we visited
  const nodesTraversed = execCtx.stateStack.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  await execCtx.audit({ type: "interrupt", nodeName, args: interruptResponse });
  const result = await execCtx.graph.run(nodeName, {
    // todo user should be able to pass messages
    // in metadata
    messages: new ThreadStore(),
    data: {},
    ctx: execCtx,
    isResume: true,
    interruptData,
  }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
  return createReturnObject({ result, globals: execCtx.globals });
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
  const nodeName = nodesTraversed[nodesTraversed.length - 1];

  if (!nodeName) {
    throw new Error("No resumable node found in state file.");
  }

  const result = await execCtx.graph.run(nodeName, {
    // todo: is this correct? Do we need to pass messages here?
    messages: new ThreadStore(),
    ctx: execCtx,
    isResume: true,
    data: {},
    //interruptData
  }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });

  return createReturnObject({ result, globals: execCtx.globals });
}
