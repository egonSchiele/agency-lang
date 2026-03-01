import { MessageJSON } from "smoltalk";
import { callHook } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import { State } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { GraphState, RunNodeResult } from "./types.js";
import { createReturnObject } from "./utils.js";

export function setupNode(args: { state: GraphState }): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  let { state } = args;
  const ctx = state.ctx;
  /* 
  if (state.isResume) {
    // restore global state
    // to to restore data that was saved on the state stack for this node
    // clear the state stack from metadata so it doesn't propagate to other nodes.
    //state.__metadata.__stateStack = undefined;
  } */

  // either creates a new stack for this node,
  // or restores the stack if we're resuming after an interrupt
  const stack = ctx.stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // Initialize or restore the ThreadStore for dynamic message thread management
  const threads = stack.threads
    ? ThreadStore.fromJSON(stack.threads)
    : new ThreadStore();
  stack.threads = threads;

  return { stack, step, self, threads };
}

export function setupFunction(args: {
  ctx: RuntimeContext<GraphState>;
  metadata: any;
}): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  const { ctx, metadata = {} } = args;

  const stack = ctx.stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // if being called from a node, we'll pass in threads.
  // if being called as a tool, we won't have threads, but we'll create an empty ThreadStore here.
  const threads = metadata?.threads || new ThreadStore();

  return { stack, step, self, threads };
}

export async function runNode({
  ctx,
  nodeName,
  data,
  messages,
}: {
  // global execution context
  ctx: RuntimeContext<GraphState>;

  // name of node to run
  nodeName: string;

  // arbitrary data to pass to the node
  data: Record<string, any>;

  // any message history to pass to the node
  // tbd how this gets used. Which message thread does it get added to?
  messages?: MessageJSON[];
}): Promise<RunNodeResult<any>> {
  await callHook({
    callbacks: ctx.callbacks,
    name: "onAgentStart",
    data: { nodeName, args: data, messages: messages || [] },
  });
  const threadStore = new ThreadStore();
  const result = await ctx.graph.run(nodeName, {
    messages: threadStore,
    data,
    ctx,
    isResume: false,
  });
  const returnObject = createReturnObject({
    result,
    stateStack: ctx.stateStack,
  });
  await callHook({
    callbacks: ctx.callbacks,
    name: "onAgentEnd",
    data: { nodeName, result: returnObject },
  });
  return returnObject;
}
