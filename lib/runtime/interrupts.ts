import { deepClone } from "./utils.js";
import { createReturnObject } from "./utils.js";
import { StateStack } from "./stateStack.js";
import * as smoltalk from "smoltalk";
import type { RuntimeContext } from "./context.js";

export function interrupt(data: any): any {
  return {
    type: "interrupt",
    data,
  };
}

export function isInterrupt(obj: any): boolean {
  return obj && obj.type === "interrupt";
}

export async function respondToInterrupt(args: {
  ctx: RuntimeContext;
  interruptObj: any;
  interruptResponse: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;
  const interruptObj = deepClone(args.interruptObj);
  const interruptResponse = deepClone(args.interruptResponse);

  ctx.stateStack = StateStack.fromJSON(interruptObj.__state || {});
  ctx.stateStack.deserializeMode();

  const messages = (ctx.stateStack.interruptData.messages || []).map(
    (json: any) => {
      return smoltalk.messageFromJSON(json);
    },
  );
  ctx.stateStack.interruptData.messages = messages;
  ctx.stateStack.interruptData.interruptResponse = interruptResponse;

  if (interruptResponse.type === "approve" && interruptResponse.newArguments) {
    ctx.stateStack.interruptData.toolCall = {
      ...ctx.stateStack.interruptData.toolCall,
      arguments: {
        ...ctx.stateStack.interruptData.toolCall.arguments,
        ...interruptResponse.newArguments,
      },
    };
  }

  // start at the last node we visited
  const nodesTraversed = ctx.stateStack.interruptData.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];
  const result = await ctx.graph.run(nodeName, {
    messages: messages,
    __metadata: {
      graph: ctx.graph,
      statelogClient: ctx.statelogClient,
      __stateStack: ctx.stateStack,
      __callbacks: metadata.callbacks,
    },
    data: "<from-stack>",
  });
  return createReturnObject({ result, stateStack: ctx.stateStack });
}

export async function approveInterrupt(args: {
  ctx: RuntimeContext;
  interruptObj: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx: args.ctx,
    interruptObj: args.interruptObj,
    interruptResponse: { type: "approve" },
    metadata: args.metadata,
  });
}

export async function modifyInterrupt(args: {
  ctx: RuntimeContext;
  interruptObj: any;
  newArguments: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx: args.ctx,
    interruptObj: args.interruptObj,
    interruptResponse: { type: "approve", newArguments: args.newArguments },
    metadata: args.metadata,
  });
}

export async function rejectInterrupt(args: {
  ctx: RuntimeContext;
  interruptObj: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx: args.ctx,
    interruptObj: args.interruptObj,
    interruptResponse: { type: "reject" },
    metadata: args.metadata,
  });
}

export async function resolveInterrupt(args: {
  ctx: RuntimeContext;
  interruptObj: any;
  value: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  return await respondToInterrupt({
    ctx: args.ctx,
    interruptObj: args.interruptObj,
    interruptResponse: { type: "resolve", value: args.value },
    metadata: args.metadata,
  });
}

export async function resumeFromState(args: {
  ctx: RuntimeContext;
  stateJSON: any;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, metadata = {} } = args;

  ctx.stateStack = StateStack.fromJSON(args.stateJSON.__state || {});
  ctx.stateStack.deserializeMode();

  const messages = (ctx.stateStack.interruptData.messages || []).map(
    (json: any) => smoltalk.messageFromJSON(json),
  );
  ctx.stateStack.interruptData.messages = messages;

  const nodesTraversed = ctx.stateStack.interruptData.nodesTraversed || [];
  const nodeName = nodesTraversed[nodesTraversed.length - 1];

  if (!nodeName) {
    throw new Error("No resumable node found in state file.");
  }

  const result = await ctx.graph.run(nodeName, {
    messages,
    __metadata: {
      graph: ctx.graph,
      statelogClient: ctx.statelogClient,
      __stateStack: ctx.stateStack,
      __callbacks: metadata.callbacks,
    },
    data: "<from-stack>",
  });

  return createReturnObject({ result, stateStack: ctx.stateStack });
}
