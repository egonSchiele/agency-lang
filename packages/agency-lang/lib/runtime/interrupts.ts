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
}): Interrupt<T> {
  return {
    type: "interrupt",
    kind: opts.kind,
    message: opts.message,
    origin: opts.origin,
    interruptId: nanoid(),
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

export async function interruptWithHandlers<T = any>(
  kind: string,
  message: string,
  data: T,
  origin: string,
  ctx: RuntimeContext<any>,
  stack?: StateStack,
): Promise<Interrupt<T>[] | Approved | Rejected> {
  const interruptObj = { kind, message, data, origin };
  if (ctx.handlers.length === 0) {
    return [interrupt({ kind, message, data, origin, runId: ctx.getRunId() })];
  }
  let approvedValue: any = undefined;
  let hasApproval = false;
  let hasPropagation = false;
  for (let i = ctx.handlers.length - 1; i >= 0; i--) {
    if (ctx.isCancelled(stack)) {
      throw new AgencyCancelledError();
    }
    // Enter tool call context so that the debugger treats handler execution
    // as atomic — debug hooks won't fire inside the handler body, just like
    // they don't fire inside LLM tool calls.
    ctx.enterToolCall();
    let result: any;
    try {
      result = await ctx.handlers[i](interruptObj);
    } finally {
      ctx.exitToolCall();
    }
    if (result === undefined) {
      continue;
    }
    if (result.type === "reject") {
      return { type: "reject", value: result.value };
    }
    if (result.type === "propagate") {
      hasPropagation = true;
      continue;
    }
    if (result.type === "approve") {
      hasApproval = true;
      approvedValue = result.value;
      continue;
    }
    throw new Error(
      `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approve", "reject", "propagate", or undefined.`,
    );
  }
  if (hasPropagation) {
    return [interrupt({ kind, message, data, origin, runId: ctx.getRunId() })];
  }
  if (hasApproval) {
    return { type: "approve", value: approvedValue };
  }
  return [interrupt({ kind, message, data, origin, runId: ctx.getRunId() })];
}

export async function respondToInterrupts(args: {
  ctx: RuntimeContext<GraphState>;
  interrupts: Interrupt[];
  responses: InterruptResponse[];
  overrides?: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, interrupts, responses, metadata = {} } = args;

  if (responses.length !== interrupts.length) {
    throw new Error(
      `respondToInterrupts: expected ${interrupts.length} responses but got ${responses.length}`,
    );
  }

  // Build ID-keyed response map
  const responseMap: Record<string, { response: InterruptResponse }> = {};
  for (let i = 0; i < interrupts.length; i++) {
    responseMap[interrupts[i].interruptId] = {
      response: deepClone(responses[i]),
    };
  }

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


  if (args.overrides) {
    applyOverrides(checkpoint, args.overrides);
  }

  const execCtx = await ctx.createExecutionContext(interrupt.runId);
  execCtx.restoreState(checkpoint);

  execCtx.setInterruptResponses(responseMap);

  execCtx.installRegisteredCallbacks(ctx);
  if (metadata.callbacks) {
    Object.assign(execCtx.callbacks, metadata.callbacks);
  }

  if (metadata.debugger) {
    execCtx.debuggerState = metadata.debugger;
  }

  let nodeName = checkpoint.nodeId;
  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            data: {},
            ctx: execCtx,
            isResume: true,
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
        );
        await execCtx.pendingPromises.awaitAll();
        const returnObject = createReturnObject({
          result,
          globals: execCtx.globals,
        });

        if (hasInterrupts(returnObject.data)) {
          await execCtx.pauseTraceWriter();
        } else {
          await execCtx.closeTraceWriter();
        }
        return returnObject;
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          nodeName = cp.nodeId;
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

