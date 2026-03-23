import { MessageJSON } from "smoltalk";
import { callHook } from "./hooks.js";
import type { AgencyCallbacks } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import { RestoreSignal, InterruptBatchSignal } from "./errors.js";
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

export function setupFunction(args: { state?: InternalFunctionState }): {
  stack: State;
  step: number;
  self: Record<string, any>;
  threads: ThreadStore;
  stateStack: StateStack;
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
      stateStack,
    };
  }

  const stateStack = state.stateStack ?? state.ctx.stateStack;
  const stack = stateStack.getNewState();
  const step = stack.step;
  const self = stack.locals;

  // if being called from a node, we'll pass in threads.
  // if being called as a tool, we won't have threads, but we'll create an empty ThreadStore here.
  const threads = state.threads || new ThreadStore();

  return { stack, step, self, threads, stateStack };
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
  initializeGlobals?: (ctx: RuntimeContext<GraphState>) => void;
}): Promise<RunNodeResult<any>> {
  const execCtx = ctx.createExecutionContext();
  if (initializeGlobals) {
    initializeGlobals(execCtx);
  }
  execCtx.callbacks = callbacks || {};
  await callHook({
    callbacks: execCtx.callbacks,
    name: "onAgentStart",
    data: { nodeName, args: data, messages: messages || [] },
  });
  await execCtx.audit({ type: "nodeEntry", nodeName });
  let isResume = false;
  try {
    while (true) {
      try {
        const threadStore = new ThreadStore();
        const result = await execCtx.graph.run(nodeName, {
          messages: threadStore,
          data,
          ctx: execCtx,
          isResume,
        }, { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) });
        const interrupts = await execCtx.pendingPromises.awaitAll();
        if (interrupts.length > 0) {
          const checkpointId = execCtx.checkpoints.create(execCtx);
          const checkpoint = execCtx.checkpoints.get(checkpointId);
          if (!checkpoint) {
            throw new Error("Failed to retrieve checkpoint after creation");
          }
          return {
            type: "interrupt_batch",
            interrupts,
            checkpoint,
          };
        }
        await execCtx.audit({ type: "nodeExit", nodeName });
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
        if (e instanceof InterruptBatchSignal) {
          // awaitPending detected interrupts among the async results.
          const interrupts = await execCtx.pendingPromises.awaitAll();

          // Each interrupt has its own per-function checkpoint (created inside the function
          // before the finally block popped the forked stack). The batch checkpoint needs
          // correct branch states. We reconstruct them from the per-function checkpoints.
          const nodeFrame = execCtx.stateStack.stack[execCtx.stateStack.stack.length - 1];
          if (nodeFrame && nodeFrame.branches) {
            for (const intr of interrupts) {
              const perFuncCp = intr.checkpointId != null
                ? execCtx.checkpoints.get(intr.checkpointId)
                : undefined;
              if (perFuncCp) {
                // The per-function checkpoint's node frame has serialized branches with the
                // function's forked stack still intact. Copy them into the current node frame,
                // converting from JSON back to live StateStack objects.
                const perFuncFrame = perFuncCp.stack.stack[0];
                if (perFuncFrame?.branches) {
                  for (const branchKey of Object.keys(perFuncFrame.branches)) {
                    const branchJSON = (perFuncFrame.branches as Record<string, any>)[branchKey];
                    if (branchJSON?.stack?.stack?.length > 0) {
                      (nodeFrame.branches as Record<number, any>)[Number(branchKey)] = {
                        stack: StateStack.fromJSON(branchJSON.stack),
                      };
                    }
                  }
                }
              }
            }
          }

          const checkpointId = execCtx.checkpoints.create(execCtx);
          const checkpoint = execCtx.checkpoints.get(checkpointId);
          if (!checkpoint) {
            throw new Error("Failed to retrieve checkpoint after creation");
          }
          return {
            type: "interrupt_batch",
            interrupts,
            checkpoint,
          };
        }
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          await execCtx.audit({ type: "restore", checkpointId: cp.id, nodeName: cp.nodeId });
          nodeName = cp.nodeId;
          data = {};
          isResume = true;
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
