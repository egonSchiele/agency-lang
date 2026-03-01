import { deepClone } from "./utils.js";
import { createReturnObject } from "./utils.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import * as smoltalk from "smoltalk";
import { RuntimeContext } from "./state/context.js";
import { GraphState } from "./types.js";
import { ThreadStore } from "./state/threadStore.js";

export type InterruptApprove = {
  type: "approve";
};
export type InterruptModify = {
  type: "modify";
  newArguments: any;
};

export type InterruptReject = {
  type: "reject";
};

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

export type Interrupt<T = any> = {
  type: "interrupt";
  data: T;
  interruptData?: InterruptData;
  state?: StateStackJSON;
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
  //const { interrupt, interruptResponse, metadata = {} } = args;
  const interrupt = deepClone(args.interrupt);
  const interruptResponse = deepClone(args.interruptResponse);
  const { ctx, metadata = {} } = args;

  // this needs to be cleaned up
  ctx.stateStack = StateStack.fromJSON(interrupt.state!);
  ctx.stateStack.deserializeMode();

  if (metadata.callbacks) {
    ctx.callbacks = metadata.callbacks;
  }

  const interruptData = interrupt.interruptData || {};

  /*   const messages: smoltalk.Message[] = (interruptData.messages || []).map(
    (json: any) => {
      return smoltalk.messageFromJSON(json);
    },
  );
  interruptData.messages = messages; */
  interruptData.interruptResponse = interruptResponse;

  // not sure we should be saving interrupt data on state stack?
  if (interruptResponse.type === "modify") {
    interruptData.toolCall!.arguments = {
      ...interruptData.toolCall!.arguments,
      ...interruptResponse.newArguments,
    };
  }

  // start at the last node we visited
  const nodesTraversed = ctx.stateStack.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await ctx.graph.run(nodeName, {
    // todo user should be able to pass messages
    // in metadata
    messages: new ThreadStore(),
    data: {},
    ctx,
    isResume: true,
    interruptData,
  });
  return createReturnObject({ result, stateStack: ctx.stateStack });
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
  newArguments: any;
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
  state: StateStackJSON;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;

  ctx.stateStack = StateStack.fromJSON(args.state || {});
  ctx.stateStack.deserializeMode();

  const nodesTraversed = ctx.stateStack.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];

  if (!nodeName) {
    throw new Error("No resumable node found in state file.");
  }

  const result = await ctx.graph.run(nodeName, {
    // todo: is this correct? Do we need to pass messages here?
    messages: new ThreadStore(),
    ctx,
    isResume: true,
    data: {},
  });

  return createReturnObject({ result, stateStack: ctx.stateStack });
}
