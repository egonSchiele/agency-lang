import * as fs from "fs";
import * as path from "path";
import { MessageJSON } from "smoltalk";
import { callHook } from "./hooks.js";
import type { AgencyCallbacks } from "./hooks.js";
import type { RuntimeContext } from "./state/context.js";
import {
  AgencyCancelledError,
  CheckpointError,
  RestoreSignal,
} from "./errors.js";
import { State, StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { resolveTraceFilePath } from "./trace/traceWriter.js";
import { GraphState, InternalFunctionState, RunNodeResult } from "./types.js";
import { createReturnObject } from "./utils.js";
import { color } from "@/utils/termcolors.js";
import { nanoid } from "nanoid";
import { hasInterrupts } from "./interrupts.js";

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
  threads.setStatelogClient(ctx.statelogClient);
  stack.threads = threads;

  return { stack, step, self, threads };
}

export function setupFunction(args: { state?: InternalFunctionState }): {
  stateStack: StateStack;
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
      stateStack,
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

  return { stateStack, stack, step, self, threads };
}

export async function runNode({
  ctx,
  nodeName,
  data,
  messages,
  callbacks,
  initializeGlobals,
  abortSignal,
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

  // An AbortSignal for cancelling the agent mid-execution.
  // When aborted, in-flight LLM requests are torn down and a AgencyCancelledError is thrown.
  abortSignal?: AbortSignal;
}): Promise<RunNodeResult<any>> {
  const runId = nanoid();

  // runNode is the entry point for a fresh agent run (resumes go through
  // respondToInterrupts instead). If trace output is enabled, truncate the
  // target file so this run starts with a clean slate. FileSink opens in
  // append mode, so subsequent per-execCtx writers within this same run
  // accumulate into the same file naturally.
  const tracePath = resolveTraceFilePath(ctx.traceConfig, runId);
  if (tracePath) {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.writeFileSync(tracePath, "");
  }

  const execCtx = await ctx.createExecutionContext(runId);
  if (initializeGlobals) {
    await initializeGlobals(execCtx);
  }
  execCtx.installRegisteredCallbacks(ctx);
  // Externally-passed callbacks override registered ones and receive only data.
  if (callbacks) {
    Object.assign(execCtx.callbacks, callbacks);
  }

  // Wire external abort signal to the execution context
  const cancel = (reason?: string) => execCtx.cancel(reason);
  if (abortSignal) {
    if (abortSignal.aborted) {
      throw new AgencyCancelledError();
    }
    abortSignal.addEventListener("abort", () => execCtx.cancel(), {
      once: true,
    });
  }

  await callHook({
    callbacks: execCtx.callbacks,
    name: "onAgentStart",
    data: { nodeName, args: data, messages: messages || [], cancel },
  });

  execCtx.statelogClient.startSpan("agentRun");
  execCtx.statelogClient.agentStart({ entryNode: nodeName, args: data });
  const agentStartTime = performance.now();

  let isResume = false;
  let threadStore = ThreadStore.withDefaultActive();
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            messages: threadStore,
            data,
            ctx: execCtx,
            isResume,
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
        );
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });

        if (hasInterrupts(returnObject.data)) {
          // Interrupt(s): attach runId and pause (no footer)
          if (execCtx.runId) {
            for (const intr of returnObject.data) {
              intr.runId = execCtx.runId;
            }
          }
          await execCtx.pauseTraceWriter();
        } else {
          // Final result: emit footer and close
          execCtx.statelogClient.agentEnd({
            entryNode: nodeName,
            result: returnObject.data,
            timeTaken: performance.now() - agentStartTime,
            tokenStats: returnObject.tokens,
          });
          await callHook({
            callbacks: execCtx.callbacks,
            name: "onAgentEnd",
            data: { nodeName, result: returnObject },
          });
          await execCtx.closeTraceWriter();
        }
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
          execCtx.statelogClient.checkpointRestored({
            checkpointId: cp.id,
            restoreCount: execCtx._restoreCount,
            maxRestores: execCtx.maxRestores,
            overrides: {
              args: !!e.options?.args,
              globals: !!e.options?.globals,
            },
          });
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
    execCtx.statelogClient.endSpan(); // end agentRun span
    // Persist any in-memory MemoryManager state. Writes are best-effort —
    // we never fail the run because of a save error, but we do log it so
    // disk problems are visible.
    if (execCtx.memoryManager) {
      try {
        await execCtx.memoryManager.save();
      } catch (err) {
        console.warn(
          `[memory] save failed: ${(err as Error).message}`,
        );
      }
    }
    execCtx.cleanup();
  }
}
