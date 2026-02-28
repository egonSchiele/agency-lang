import { ThreadStore } from "./state/threadStore.js";
import { callHook } from "./hooks.js";
import { createReturnObject } from "./utils.js";
import type { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { StatelogClient } from "@/statelogClient.js";
import { SimpleMachine } from "@/simplemachine/graph.js";
import { GraphState, RunNodeResult } from "./types.js";
import { MessageJSON } from "smoltalk";

export function setupNode(args: {
  ctx: RuntimeContext<GraphState>;
  state: any;
  nodeName: string;
}): {
  graph: SimpleMachine<GraphState>;
  statelogClient: StatelogClient;
  stack: StateStack;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
  globalState: Record<string, any> | null;
} {
  const { ctx, state } = args;

  const graph = state.__metadata?.graph || ctx.graph;
  const statelogClient = state.__metadata?.statelogClient || ctx.statelogClient;

  let globalState: any = null;

  // if `state.__metadata?.__stateStack` is set, that means we are resuming execution
  // at this node after an interrupt. In that case, this is the line that restores the state.
  if (state.__metadata?.__stateStack) {
    ctx.stateStack = state.__metadata.__stateStack;

    // restore global state
    if (state.__metadata?.__stateStack?.global) {
      globalState = state.__metadata.__stateStack.global;
    }

    // clear the state stack from metadata so it doesn't propagate to other nodes.
    state.__metadata.__stateStack = undefined;
  }

  if (state.__metadata?.callbacks) {
    ctx.callbacks = state.__metadata.callbacks;
  }

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

  return { graph, statelogClient, stack, step, self, threads, globalState };
}

export function setupFunction(args: {
  ctx: RuntimeContext<GraphState>;
  metadata: any;
}): {
  stack: StateStack;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
  statelogClient: StatelogClient;
  graph: SimpleMachine<GraphState>;
} {
  const { ctx, metadata = {} } = args;

  const stack = ctx.stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;
  const graph = metadata?.graph || ctx.graph;
  const statelogClient = metadata?.statelogClient || ctx.statelogClient;

  // if being called from a node, we'll pass in threads.
  // if being called as a tool, we won't have threads, but we'll create an empty ThreadStore here.
  const threads = metadata?.threads || new ThreadStore();

  return { stack, step, self, threads, statelogClient, graph };
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
