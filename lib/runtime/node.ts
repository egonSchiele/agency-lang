import { ThreadStore } from "./state/threadStore.js";
import { callHook } from "./hooks.js";
import { createReturnObject } from "./utils.js";
import type { RuntimeContext } from "./state/context.js";

export function setupNode(args: {
  ctx: RuntimeContext;
  state: any;
  nodeName: string;
}): {
  graph: any;
  statelogClient: any;
  stack: any;
  step: number;
  self: any;
  threads: ThreadStore;
  globalState: any;
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

export function setupFunction(args: { ctx: RuntimeContext; metadata: any }): {
  stack: any;
  step: number;
  self: any;
  threads: ThreadStore;
  statelogClient: any;
  graph: any;
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

export async function runNode(args: {
  ctx: RuntimeContext;
  nodeName: string;
  data: Record<string, any>;
  messages?: any[];
  callbacks?: Record<string, Function>;
}): Promise<any> {
  const { ctx, nodeName, data, messages, callbacks } = args;
  ctx.callbacks = callbacks || {};
  await callHook({
    callbacks: ctx.callbacks,
    name: "onAgentStart",
    data: { nodeName, args: data, messages: messages || [] },
  });
  const result = await ctx.graph.run(nodeName, {
    messages: messages || [],
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
