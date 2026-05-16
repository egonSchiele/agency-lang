import * as smoltalk from "smoltalk";
import { nanoid } from "nanoid";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { applyOverrides } from "./rewind.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { RuntimeContext } from "./state/context.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { Approved, GraphState, Rejected } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";
import { reviveWithClasses } from "./classReviver.js";
import { isIpcMode, sendInterruptToParent } from "./ipc.js";
export {
  type ClassRegistry,
  createClassReviver,
  reviveWithClasses,
} from "./classReviver.js";

export type InterruptApprove = {
  type: "approve";
};

export type InterruptReject = {
  type: "reject";
};

export type InterruptResponse =
  | InterruptApprove
  | InterruptReject;

export function approve(value?: any): InterruptResponse {
  return { type: "approve", value } as any;
}

export function reject(value?: any): InterruptResponse {
  return { type: "reject", value } as any;
}

export type InterruptData = {
  // messages that have been exchanged in the prompt function
  // up till this interrupt was triggered. This is needed to restore
  // the message history for this specific prompt
  messages?: smoltalk.MessageJSON[];

  // which tool call caused the interrupt?
  toolCall?: smoltalk.ToolCallJSON;
};

export type InterruptState = {
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
};

export type Interrupt<T = any> = {
  type: "interrupt";
  kind: string;           // e.g. "std::read", "unknown"
  message: string;        // human-readable description
  origin: string;         // compiler-injected module origin
  interruptId: string; // nanoid — globally unique
  data: T;
  debugger?: boolean;
  interruptData?: InterruptData;
  checkpointId?: number;
  checkpoint?: Checkpoint;
  state?: InterruptState; // kept for backward compat migration shim
  runId: string; // unique ID for the agent run, persists across interrupt pauses/resumes
};

export function interrupt<T = any>(opts: {
  kind: string;
  message: string;
  data: T;
  origin: string;
  runId: string;
  interruptId?: string;
}): Interrupt<T> {
  return {
    type: "interrupt",
    kind: opts.kind,
    message: opts.message,
    origin: opts.origin,
    interruptId: opts.interruptId || nanoid(),
    data: opts.data,
    runId: opts.runId,
  };
}

export function createDebugInterrupt<T = any>(
  data: T,
  checkpointId: number,
  checkpoint: Checkpoint,
  runId: string,
): Interrupt<T> {
  return {
    type: "interrupt",
    kind: "debug",
    message: "",
    origin: "",
    interruptId: nanoid(),
    data,
    debugger: true,
    checkpointId,
    checkpoint,
    runId,
  };
}

export function isInterrupt(obj: any): obj is Interrupt {
  return obj && obj.type === "interrupt";
}

export function hasInterrupts(data: any): data is Interrupt[] {
  return Array.isArray(data) && data.length > 0 && data.every(isInterrupt);
}

export function isDebugger(obj: any): obj is Interrupt {
  return isInterrupt(obj) === true && obj.debugger === true;
}

export function isRejected(obj: any): obj is Rejected {
  return obj && obj.type === "reject";
}

export function isApproved(obj: any): obj is Approved {
  return obj && obj.type === "approve";
}

type HandlerChainOutcome =
  | { kind: "rejected"; value: any }
  | { kind: "approved"; value: any }
  | { kind: "propagated" }
  | { kind: "noResponse" };

/** Run all registered handlers for an interrupt (top of the stack first).
 * Emits handlerDecision/interruptResolved events along the way and returns
 * a summary outcome the caller uses to decide whether to propagate. */
async function runHandlerChain(
  ctx: RuntimeContext<any>,
  stack: StateStack | undefined,
  interruptId: string,
  interruptObj: { kind: string; message: string; data: any; origin: string },
): Promise<HandlerChainOutcome> {
  let approvedValue: any = undefined;
  let hasApproval = false;
  let hasPropagation = false;
  ctx.statelogClient.startSpan("handlerChain");
  try {
    for (let i = (ctx.handlers ?? []).length - 1; i >= 0; i--) {
      if (ctx.isCancelled(stack)) throw new AgencyCancelledError();
      // Treat handler execution as atomic for the debugger — same as LLM tool calls.
      ctx.enterToolCall();
      let result: any;
      try {
        result = await ctx.handlers[i](interruptObj);
      } finally {
        ctx.exitToolCall();
      }
      if (result === undefined) {
        ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "none" });
        continue;
      }
      if (result.type === "reject") {
        ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "reject", value: result.value });
        ctx.statelogClient.interruptResolved({ interruptId, outcome: "rejected", resolvedBy: "handler" });
        return { kind: "rejected", value: result.value };
      }
      if (result.type === "propagate") {
        ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "propagate" });
        hasPropagation = true;
        continue;
      }
      if (result.type === "approve") {
        ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "approve", value: result.value });
        hasApproval = true;
        approvedValue = result.value;
        continue;
      }
      throw new Error(
        `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approve", "reject", "propagate", or undefined.`,
      );
    }
  } finally {
    ctx.statelogClient.endSpan(); // end handlerChain span
  }
  if (hasPropagation) return { kind: "propagated" };
  if (hasApproval) return { kind: "approved", value: approvedValue };
  return { kind: "noResponse" };
}

export async function interruptWithHandlers<T = any>(
  kind: string,
  message: string,
  data: T,
  origin: string,
  ctx: RuntimeContext<any>,
  stack?: StateStack,
): Promise<Interrupt<T>[] | Approved | Rejected> {
  const interruptObj = { kind, message, data, origin };
  const interruptId = nanoid();
  const outcome = await runHandlerChain(ctx, stack, interruptId, interruptObj);

  if (outcome.kind === "rejected") {
    return { type: "reject", value: outcome.value };
  }
  const hasPropagation = outcome.kind === "propagated";
  const hasApproval = outcome.kind === "approved";
  const approvedValue = hasApproval ? outcome.value : undefined;
  // IPC mode: always consult parent (unless local handler rejected — that already returned above)
  if (isIpcMode()) {
    const parentDecision = await sendInterruptToParent(
      { kind, message, data, origin },
      { propagated: hasPropagation },
    );
    if (parentDecision.type === "approve") {
      ctx.statelogClient.interruptResolved({
        interruptId,
        outcome: "approved",
        resolvedBy: "ipc",
      });
      return { type: "approve", value: parentDecision.value ?? approvedValue };
    }
    ctx.statelogClient.interruptResolved({
      interruptId,
      outcome: "rejected",
      resolvedBy: "ipc",
    });
    return { type: "reject", value: parentDecision.value };
  }

  // Normal mode (non-IPC)
  // Note: checkpointCreated for these interrupts is emitted by the generated
  // interrupt template code, not here. This is a known gap — non-tool
  // interrupts will have interruptThrown but no matching checkpointCreated
  // from the runtime. A future improvement could add checkpoint events to
  // the generated templates.
  if (hasPropagation) {
    const intr = interrupt({ kind, message, data, origin, runId: ctx.getRunId(), interruptId });
    ctx.statelogClient.interruptThrown({
      interruptId: intr.interruptId,
      interruptData: data,
    });
    return [intr];
  }
  if (hasApproval) {
    ctx.statelogClient.interruptResolved({
      interruptId,
      outcome: "approved",
      resolvedBy: "handler",
    });
    return { type: "approve", value: approvedValue };
  }
  // No handler responded — propagate to user
  const intr = interrupt({ kind, message, data, origin, runId: ctx.getRunId(), interruptId });
  ctx.statelogClient.interruptThrown({
    interruptId: intr.interruptId,
    interruptData: data,
  });
  return [intr];
}

/** Build the ID-keyed response map for `respondToInterrupts`. Extracted
 * to keep the main function under the structural lint limit. */
function buildResponseMap(
  interrupts: Interrupt[],
  responses: InterruptResponse[],
): Record<string, { response: InterruptResponse }> {
  if (responses.length !== interrupts.length) {
    throw new Error(
      `respondToInterrupts: expected ${interrupts.length} responses but got ${responses.length}`,
    );
  }
  const responseMap: Record<string, { response: InterruptResponse }> = {};
  for (let i = 0; i < interrupts.length; i++) {
    responseMap[interrupts[i].interruptId] = {
      response: deepClone(responses[i]),
    };
  }
  return responseMap;
}

/** Inner resume loop: runs the graph and reacts to RestoreSignal until the
 * agent either returns or yields another batch of interrupts. */
async function runResumeLoop(
  execCtx: RuntimeContext<GraphState>,
  startNodeName: string,
  agentStartTime: number,
): Promise<any> {
  let nodeName = startNodeName;
  while (true) {
    try {
      const result = await execCtx.graph.run(
        nodeName,
        { data: {}, ctx: execCtx, isResume: true },
        {
          onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id),
          statelogClient: execCtx.statelogClient,
        },
      );
      await execCtx.pendingPromises.awaitAll();
      const returnObject = createReturnObject({ result, globals: execCtx.globals });
      if (hasInterrupts(returnObject.data)) {
        await execCtx.pauseTraceWriter();
      } else {
        execCtx.statelogClient.agentEnd({
          entryNode: nodeName,
          result: returnObject.data,
          timeTaken: performance.now() - agentStartTime,
          tokenStats: returnObject.tokens,
        });
        await execCtx.closeTraceWriter();
      }
      return returnObject;
    } catch (e) {
      if (e instanceof RestoreSignal) {
        const cp = e.checkpoint;
        execCtx._restoreCount++;
        execCtx.statelogClient.checkpointRestored({
          checkpointId: cp.id,
          restoreCount: execCtx._restoreCount,
        });
        execCtx.restoreState(cp);
        nodeName = cp.nodeId;
        execCtx.stateStack.nodesTraversed = [cp.nodeId];
        continue;
      }
      throw e;
    }
  }
}

export async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  interrupts: Interrupt[];
  responses: InterruptResponse[];
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, interrupts, responses, metadata = {} } = args;
  const responseMap = buildResponseMap(interrupts, responses);

  // All interrupts share the same checkpoint — grab from first
  const interrupt = deepClone(interrupts[0]);
  const checkpoint =
    interrupt.checkpoint ??
    (interrupt.checkpointId !== undefined
      ? ctx.checkpoints?.get(interrupt.checkpointId)
      : undefined);
  if (!checkpoint) {
    throw new Error(
      "No checkpoint found for interrupt. The interrupt may have been created with an older format.",
    );
  }
  if (args.overrides) applyOverrides(checkpoint, args.overrides);

  const execCtx = await ctx.createExecutionContext(interrupt.runId);
  // This is the first restore on this execCtx — record it as such.
  execCtx._restoreCount++;
  execCtx.statelogClient.checkpointRestored({
    checkpointId: checkpoint.id,
    restoreCount: execCtx._restoreCount,
  });
  execCtx.restoreState(checkpoint);
  execCtx.setInterruptResponses(responseMap);
  execCtx.installRegisteredCallbacks(ctx);
  if (metadata.callbacks) Object.assign(execCtx.callbacks, metadata.callbacks);
  if (metadata.debugger) execCtx.debuggerState = metadata.debugger;

  execCtx.statelogClient.startSpan("agentRun");
  execCtx.statelogClient.agentStart({ entryNode: checkpoint.nodeId, args: {} });
  const agentStartTime = performance.now();
  try {
    return await runResumeLoop(execCtx, checkpoint.nodeId, agentStartTime);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    execCtx.statelogClient.error({ errorType: "runtimeError", message: errorMessage });
    execCtx.statelogClient.agentEnd({
      entryNode: checkpoint.nodeId,
      timeTaken: performance.now() - agentStartTime,
    });
    throw error;
  } finally {
    execCtx.statelogClient.endSpan(); // end agentRun span
    execCtx.cleanup();
  }
}

