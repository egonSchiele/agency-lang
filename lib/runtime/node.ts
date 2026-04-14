import { MessageJSON } from "smoltalk";
import { callHook } from "./hooks.js";
import type { AgencyCallbacks } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import { CheckpointError, RestoreSignal } from "./errors.js";
import { State, StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { GraphState, InternalFunctionState, RunNodeResult } from "./types.js";
import { createReturnObject } from "./utils.js";
import { color } from "termcolors";

export function setupNode(args: { state: GraphState }): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  let { state } = args;
  const ctx = state.ctx;

  const stack = ctx.stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // Initialize or restore the ThreadStore for dynamic message thread management
  let threads: ThreadStore;
  if (stack.threads) {
    threads = ThreadStore.fromJSON(stack.threads);
  } else if (state.messages instanceof ThreadStore) {
    threads = state.messages;
  } else {
    // Fallback: create a new ThreadStore with a default active thread.
    // This can happen on debugger/rewind resume paths where messages is not passed
    // and the checkpoint frame doesn't have serialized threads.
    threads = ThreadStore.withDefaultActive();
  }
  stack.threads = threads;

  return { stack, step, self, threads };
}

export function setupFunction(args: { state?: InternalFunctionState }): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
} {
  const { state } = args;
  if (state === undefined) {
    // this means the function got called as a tool by the llm
    const stateStack = new StateStack();
    const stack = stateStack.getNewState();
    return {
      stack,
      step: 0,
      self: stack.locals,
      threads: new ThreadStore(),
    };
  }

  const stateStack = state.stateStack ?? state.ctx.stateStack;
  const stack = stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // if being called from a node, we'll pass in threads.
  // if being called as a tool, we won't have threads, but we'll create an empty ThreadStore here.
  const threads = state.threads || new ThreadStore();

  return { stack, step, self, threads };
}

export async function runNode({
  ctx,
  nodeName,
  data,
  messages,
  callbacks,
  initializeGlobals,
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

  callbacks?: AgencyCallbacks;

  // initializes global variables on the execution context
  initializeGlobals?: (ctx: RuntimeContext<GraphState>) => void | Promise<void>;
}): Promise<RunNodeResult<any>> {
  const execCtx = ctx.createExecutionContext();
  if (initializeGlobals) {
    await initializeGlobals(execCtx);
  }
  execCtx.callbacks = callbacks || {};
  await callHook({
    callbacks: execCtx.callbacks,
    name: "onAgentStart",
    data: { nodeName, args: data, messages: messages || [] },
  });
  let isResume = false;
  let threadStore = ThreadStore.withDefaultActive();
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(nodeName, {
          messages: threadStore,
          data,
          ctx: execCtx,
          isResume,
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });
        await callHook({
          callbacks: execCtx.callbacks,
          name: "onAgentEnd",
          data: { nodeName, result: returnObject },
        });
        return returnObject;
      } catch (e) {
        if (e instanceof RestoreSignal) {
          execCtx._restoreCount++;
          if (execCtx._restoreCount > execCtx.maxRestores) {
            throw new CheckpointError(
              `Exceeded maximum number of restores (${execCtx.maxRestores}). Possible infinite loop.`,
            );
          }
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          if (e.options?.args) {
            execCtx._pendingArgOverrides = e.options.args;
          }
          if (e.options?.globals) {
            for (const [varName, value] of Object.entries(e.options.globals)) {
              execCtx.globals.set(cp.moduleId, varName, value);
            }
          }
          nodeName = cp.nodeId;
          data = {};
          isResume = true;
          execCtx.stateStack.nodesTraversed = [cp.nodeId];
          // Reset ThreadStore for the restored execution
          threadStore = ThreadStore.withDefaultActive();
          continue;
        }
        throw e;
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
