import * as smoltalk from "smoltalk";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { runInBootstrapFrame } from "./asyncContext.js";
import {
  AgencyCancelledError,
  HandlerRecursionError,
  RestoreSignal,
} from "./errors.js";
import { applyOverrides } from "./rewind.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { RuntimeContext } from "./state/context.js";
import { loadProviderModules } from "./providerModules.js";
import { GlobalStore, GlobalStoreJSON } from "./state/globalStore.js";
import { StateStack, StateStackJSON } from "./state/stateStack.js";
import { Approved, GraphState, Rejected, RunNodeResult } from "./types.js";
import { createReturnObject, deepClone } from "./utils.js";
import { isIpcMode, sendInterruptToParent } from "./ipc.js";

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
  effect: string;         // e.g. "std::read", "unknown"
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
  effect: string;
  message: string;
  data: T;
  origin: string;
  runId: string;
  interruptId?: string;
}): Interrupt<T> {
  return {
    type: "interrupt",
    effect: opts.effect,
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
    effect: "debug",
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

/**
 * Called from the generated CLI bootstrap (the `argv[1] === import.meta.url`
 * block) AFTER a top-level node returns. When a node is run directly from the
 * command line and produces an interrupt that no handler caught, the interrupt
 * comes back as an `Interrupt[]` in `result.data` — and the bootstrap would
 * otherwise just exit silently, leaving the user with no output and no clue.
 *
 * This prints a helpful message pointing at the handlers guide and exits
 * non-zero. It only runs on direct CLI execution: when the compiled module is
 * imported and the node is called from TypeScript, the bootstrap guard is false
 * and this is never reached — there, the caller is expected to inspect
 * `result.data` / `respondToInterrupts` itself, so a returned interrupt is fine.
 */
export function reportUnhandledInterrupts(result: RunNodeResult<any>): void {
  if (!hasInterrupts(result.data)) return;
  for (const it of result.data) {
    console.error(
      `\nInterrupt "${it.effect}" was not handled:\n` +
        `  ${it.message}\n` +
        `  ${JSON.stringify(it.data)}\n\n` +
        `You need to handle your interrupts by wrapping them in a handler.\n` +
        `See the guide: https://agency-lang.com/guide/handlers.html`,
    );
  }
  process.exit(1);
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

/** Maximum nested-dispatch depth for `runHandlerChain`. Each dispatch descends
 *  one level in `handlerChainDepthALS`; exceeding this limit throws
 *  `HandlerRecursionError`. Picked to be well above any plausible legitimate
 *  nesting (a handler that calls one nested handler-aware operation, that itself
 *  calls another, etc.) but small enough that a runaway recursion is caught
 *  immediately rather than after hundreds of leaked handlers. See the case study
 *  in https://ampcode.com/threads/T-019e7a80-0a51-75ce-840e-89b5f595da5c where
 *  the unguarded recursion grew to ~500 handlers before the user noticed the
 *  freeze. */
const MAX_HANDLER_CHAIN_DEPTH = 10;

/** Current handler-chain nesting depth for the *active async lineage*.
 *
 *  Recursion depth is a property of the async call tree, NOT a global count.
 *  Storing it in AsyncLocalStorage (rather than a single counter on `ctx`) means
 *  concurrent dispatches — e.g. an LLM firing 15 tool calls in one round, each of
 *  which interrupts while its siblings are still in flight — each inherit the
 *  SAME parent depth and independently descend one level. Their breadth never
 *  accumulates, so a wide fan-out is no longer mistaken for recursion. Only a
 *  handler whose own body raises another interrupt runs INSIDE this scope, so
 *  genuine self-re-entry still climbs the depth until it trips the guard.
 *
 *  ALS is never serialized, so there is nothing to reset across checkpoints or
 *  resumes — each scope unwinds automatically when its dispatch returns or
 *  throws. */
const handlerChainDepthALS = new AsyncLocalStorage<number>();

/** Run all registered handlers for an interrupt (top of the stack first).
 * Emits handlerDecision/interruptResolved events along the way and returns
 * a summary outcome the caller uses to decide whether to propagate. */
async function runHandlerChain(
  ctx: RuntimeContext<any>,
  stack: StateStack | undefined,
  interruptId: string,
  interruptObj: { effect: string; message: string; data: any; origin: string },
): Promise<HandlerChainOutcome> {
  // Descend one level in the CURRENT async lineage (see
  // `handlerChainDepthALS`). Concurrent sibling dispatches each read the same
  // inherited parent depth, so fan-out breadth never accumulates; only a
  // handler whose body re-enters the chain nests inside the `run(...)` scope
  // below and climbs the depth.
  const depth = (handlerChainDepthALS.getStore() ?? 0) + 1;
  if (depth > MAX_HANDLER_CHAIN_DEPTH) {
    throw new HandlerRecursionError(interruptObj.effect, MAX_HANDLER_CHAIN_DEPTH);
  }
  return handlerChainDepthALS.run(depth, async () => {
    let approvedValue: any = undefined;
    let hasApproval = false;
    let hasPropagation = false;
    const chainSpanId = ctx.statelogClient.startSpan("handlerChain");
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
        // Pre-bind the interrupt summary once so all handlerDecision /
        // interruptResolved events from this dispatch carry the same
        // {effect, message, data} payload — lets log readers see *what*
        // is being approved/rejected without needing a separate
        // interruptThrown event (which doesn't fire for synchronously-
        // resolved interrupts like `with approve`).
        const interruptSummary = {
          effect: interruptObj.effect,
          message: interruptObj.message,
          data: interruptObj.data,
        };
        if (result === undefined) {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "none", interrupt: interruptSummary });
          continue;
        }
        if (result.type === "reject") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "reject", value: result.value, interrupt: interruptSummary });
          ctx.statelogClient.interruptResolved({ interruptId, outcome: "rejected", resolvedBy: "handler", interrupt: interruptSummary });
          return { kind: "rejected", value: result.value };
        }
        if (result.type === "propagate") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "propagate", interrupt: interruptSummary });
          hasPropagation = true;
          continue;
        }
        if (result.type === "approve") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "approve", value: result.value, interrupt: interruptSummary });
          hasApproval = true;
          approvedValue = result.value;
          continue;
        }
        throw new Error(
          `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approve", "reject", "propagate", or undefined.`,
        );
      }
    } finally {
      ctx.statelogClient.endSpan(chainSpanId); // end handlerChain span
    }
    if (hasPropagation) return { kind: "propagated" };
    if (hasApproval) return { kind: "approved", value: approvedValue };
    return { kind: "noResponse" };
  });
}

export async function interruptWithHandlers<T = any>(
  effect: string,
  message: string,
  data: T,
  origin: string,
  ctx: RuntimeContext<any>,
  stack?: StateStack,
): Promise<Interrupt<T>[] | Approved | Rejected> {
  const interruptObj = { effect, message, data, origin };
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
      { effect, message, data, origin },
      { propagated: hasPropagation },
    );
    const interruptSummary = { effect, message, data };
    if (parentDecision.type === "approve") {
      ctx.statelogClient.interruptResolved({
        interruptId,
        outcome: "approved",
        resolvedBy: "ipc",
        interrupt: interruptSummary,
      });
      return { type: "approve", value: parentDecision.value ?? approvedValue };
    }
    ctx.statelogClient.interruptResolved({
      interruptId,
      outcome: "rejected",
      resolvedBy: "ipc",
      interrupt: interruptSummary,
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
    const intr = interrupt({ effect, message, data, origin, runId: ctx.getRunId(), interruptId });
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
      interrupt: { effect, message, data },
    });
    return { type: "approve", value: approvedValue };
  }
  // No handler responded — propagate to user
  const intr = interrupt({ effect, message, data, origin, runId: ctx.getRunId(), interruptId });
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
  moduleDir?: string,
): Promise<any> {
  let nodeName = startNodeName;
  while (true) {
    try {
      // Seed an ALS frame so stdlib helpers and `callHook` reads (which
      // post-ALS-migration look up `ctx` / `stack` / `threads` via
      // `getRuntimeContext()`) see the resumed run's context.
      //
      // This is a bootstrap frame: it only covers the small slice of
      // execution between entering `graph.run` and the first
      // `Runner.runInScope` inside the resumed node body — generated
      // node bodies re-install ALS with the actual per-node
      // `ThreadStore` (reconstituted by `setupNode` from
      // `stack.threads` JSON) on every step. So the threads slot here
      // is intentionally a `BootstrapThreadStore` — if anything inside
      // graph dispatch / setupNode tries to reach for it, the throw
      // surfaces the bug instead of letting a write silently land in
      // a discarded placeholder.
      const result = await runInBootstrapFrame(
        execCtx,
        () =>
          execCtx.graph.run(
            nodeName,
            { data: {}, ctx: execCtx, isResume: true },
            {
              onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id),
              statelogClient: execCtx.statelogClient,
            },
          ),
        { moduleDir },
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
  // See runNode's docstring on the same field — on resume we have to
  // re-register module top-level callbacks because `topLevelCallbacks`
  // lives on the (fresh) execCtx and is not checkpointed.
  registerTopLevelCallbacks?: (
    ctx: RuntimeContext<GraphState>,
  ) => void | Promise<void>;
  // See runNode's docstring on the same field — seeded by generated
  // code so the resumed graph's stdlib helpers resolve paths against
  // the compiled module dir.
  moduleDir?: string;
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
  // A cross-process resume starts with an empty provider registry (registration
  // is process-global, not part of serialized checkpoint state), so re-register
  // before resuming. Idempotent in-process via loadProviderModules' guard.
  await loadProviderModules(execCtx);
  // This is the first restore on this execCtx — record it as such.
  execCtx._restoreCount++;
  execCtx.statelogClient.checkpointRestored({
    checkpointId: checkpoint.id,
    restoreCount: execCtx._restoreCount,
  });
  // Each user response resolves a previously-thrown interrupt. Emit the
  // lifecycle event so dashboards can pair every interruptThrown with a
  // terminal interruptResolved.
  for (let i = 0; i < interrupts.length; i++) {
    const intr = interrupts[i];
    const resp = responses[i];
    const outcome =
      resp.type === "approve" ? "approved" : ("rejected" as const);
    execCtx.statelogClient.interruptResolved({
      interruptId: intr.interruptId,
      outcome,
      resolvedBy: "user",
    });
  }
  // Re-register top-level callbacks BEFORE restoreState so the
  // `_callbackImpl` routing check (`stateStack.isGlobalContext()`)
  // sees the still-empty stack and pushes onto `ctx.topLevelCallbacks`.
  // After `restoreState`, the stack carries the checkpoint frames and
  // the same registration would instead bind to a caller frame and be
  // popped immediately as the restored frames unwind.
  //
  // The bootstrap frame mirrors `runNode` — top-level callback
  // registration runs Agency code that goes through `__call`, which
  // reads ctx/threads/stack from ALS after the
  // drop-per-call-context-plumbing migration. See lib/runtime/node.ts
  // and lib/runtime/asyncContext.ts (`runInBootstrapFrame`).
  if (args.registerTopLevelCallbacks) {
    await runInBootstrapFrame(
      execCtx,
      () => args.registerTopLevelCallbacks!(execCtx),
      { moduleDir: args.moduleDir },
    );
  }
  execCtx.restoreState(checkpoint);
  execCtx.setInterruptResponses(responseMap);
  if (metadata.callbacks) Object.assign(execCtx.callbacks, metadata.callbacks);
  if (metadata.debugger) execCtx.debuggerState = metadata.debugger;

  const agentRunSpanId = execCtx.statelogClient.startSpan("agentRun");
  execCtx.statelogClient.agentStart({ entryNode: checkpoint.nodeId, args: {} });
  const agentStartTime = performance.now();
  try {
    return await runResumeLoop(execCtx, checkpoint.nodeId, agentStartTime, args.moduleDir);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    execCtx.statelogClient.error({ errorType: "runtimeError", message: errorMessage });
    execCtx.statelogClient.agentEnd({
      entryNode: checkpoint.nodeId,
      timeTaken: performance.now() - agentStartTime,
    });
    throw error;
  } finally {
    execCtx.statelogClient.endSpan(agentRunSpanId); // end agentRun span
    execCtx.cleanup();
  }
}

