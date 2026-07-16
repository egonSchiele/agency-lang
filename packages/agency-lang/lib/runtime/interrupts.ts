import * as smoltalk from "smoltalk";
import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "nanoid";
import { runInBootstrapFrame } from "./asyncContext.js";
import {
  AgencyCancelledError,
  HandlerRecursionError,
  RestoreSignal,
} from "./errors.js";
import { isAborted } from "./abortedResult.js";
import { mergeFor, mergeForIpc } from "./effectMerge.js";
import { applyOverrides } from "./rewind.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { RuntimeContext } from "./state/context.js";
import { loadProviderModules } from "./providerModules.js";
import { installRunPolicyHandler } from "./runPolicyHandler.js";
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

/** Explicit "not my interrupt — ask the next handler." Identical in effect
 *  to a handler returning nothing, but usable in value position (a match
 *  arm must produce a value). Returning `undefined` keeps working; the
 *  chain normalizes it to this shape at the boundary. */
export function pass(): InterruptResponse {
  return { type: "pass" } as any;
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
  // True when the raise site ASSIGNS the approval value (`const x = raise …`):
  // whoever approves this interrupt is expected to provide a value, and a
  // plain approve resolves the variable to `true`. Set by the compiler; absent
  // (falsy) on statement-position raises.
  expectsValue?: boolean;
};

export function interrupt<T = any>(opts: {
  effect: string;
  message: string;
  data: T;
  origin: string;
  runId: string;
  interruptId?: string;
  expectsValue?: boolean;
}): Interrupt<T> {
  return {
    type: "interrupt",
    effect: opts.effect,
    message: opts.message,
    origin: opts.origin,
    interruptId: opts.interruptId || nanoid(),
    data: opts.data,
    runId: opts.runId,
    ...(opts.expectsValue ? { expectsValue: true } : {}),
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

export type HandlerChainOutcome =
  | { kind: "rejected"; value: any }
  | { kind: "approved"; value: any }
  | { kind: "propagated" }
  | { kind: "noResponse" };

/** The interrupt fields visible to handlers and relayed between processes:
 * everything identifying WHAT is being decided, without the per-dispatch
 * bookkeeping (ids, checkpoints) the origin process owns. */
export type InterruptInfo = {
  effect: string;
  message: string;
  data: any;
  origin: string;
  expectsValue?: boolean;
};

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
  interruptObj: InterruptInfo,
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
    // Approvals collect in chain-walk order (innermost handler first) and
    // are merged once at the end via the effect's merge (effectMerge.ts).
    // For effects with no specific merge the default reproduces the
    // historical behavior exactly: the outermost approval overwrites.
    const approvals: any[] = [];
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
        // A handler that is a compiled def returns an AbortedResult when
        // an abort stops it mid-run (compiled frames convert aborts to
        // values). The handler chain is runtime machinery — the exception
        // domain — so the abort resumes its exception life here, exactly
        // as a throwing handler behaved before the value transport. Without
        // this, the aborted value would hit the invalid-shape error below
        // and the abort's cause would be swallowed.
        if (isAborted(result)) {
          throw result.toError();
        }
        // A handler that returns nothing means "pass". Normalize here so
        // the loop, statelog, and merge logic never see two spellings of
        // the same verdict.
        if (result === undefined) {
          result = { type: "pass" };
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
        if (result.type === "pass") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "pass", interrupt: interruptSummary });
          continue;
        }
        if (result.type === "reject") {
          // Only the per-handler decision event here. The terminal
          // interruptResolved is emitted exactly once, by the ORIGIN
          // dispatch's renderVerdict — a relay hop (a parent process
          // rejecting a child's interrupt via gatherChainOutcome) must not
          // emit a second terminal event into the shared trace.
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "reject", value: result.value, interrupt: interruptSummary });
          return { kind: "rejected", value: result.value };
        }
        if (result.type === "propagate") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "propagate", interrupt: interruptSummary });
          hasPropagation = true;
          continue;
        }
        if (result.type === "approve") {
          ctx.statelogClient.handlerDecision({ interruptId, handlerIndex: i, decision: "approve", value: result.value, interrupt: interruptSummary });
          approvals.push(result.value);
          continue;
        }
        throw new Error(
          `Handler returned invalid result type: ${JSON.stringify(result)}. Expected "approve", "reject", "propagate", "pass", or undefined.`,
        );
      }
    } finally {
      ctx.statelogClient.endSpan(chainSpanId); // end handlerChain span
    }
    if (hasPropagation) return { kind: "propagated" };
    if (approvals.length > 0) {
      return {
        kind: "approved",
        value: approvals.reduce(mergeFor(interruptObj.effect)),
      };
    }
    return { kind: "noResponse" };
  });
}

/** Merge two chain-segment outcomes with single-process precedence:
 * reject > propagate > approve > noResponse. `inner` is the segment closer
 * to the interrupt (e.g. the child process), `outer` the segment farther
 * from it (e.g. the parent). A double-approve merges through the EFFECT's
 * approval merge (effectMerge.ts) — std::guard grants accumulate; every
 * other effect keeps the historical IPC default, where the outer value
 * wins but a VALUELESS outer approve defers to the inner value (the
 * outcome travels as JSON, which cannot distinguish an absent value from
 * an explicit undefined). */
export function mergeChainOutcomes(
  effect: string,
  inner: HandlerChainOutcome,
  outer: HandlerChainOutcome,
): HandlerChainOutcome {
  if (inner.kind === "rejected") return inner;
  if (outer.kind === "rejected") return outer;
  if (inner.kind === "propagated" || outer.kind === "propagated") {
    return { kind: "propagated" };
  }
  if (outer.kind === "approved") {
    const innerValue = inner.kind === "approved" ? inner.value : undefined;
    return {
      kind: "approved",
      value: mergeForIpc(effect)(innerValue, outer.value),
    };
  }
  if (inner.kind === "approved") return inner;
  return { kind: "noResponse" };
}

/** The distributed handler chain, evaluated from this process outward:
 * run the local chain; local reject is final (fail-fast, matching the
 * single-process short-circuit); otherwise, if this process is itself a
 * subprocess, consult the parent and merge. Nested subprocesses recurse
 * through this same function on each hop.
 *
 * `interruptId`: the interrupt's id — the CHILD's id when relaying, or the
 * freshly-minted one at the origin dispatch — so every process's
 * handlerDecision/interruptResolved statelog events correlate with the
 * originating interrupt (ids are preserved verbatim end-to-end).
 *
 * `parentDecided` lets the origin caller (`interruptWithHandlers`)
 * attribute the verdict: it distinguishes a verdict the parent hop actually
 * participated in from one settled purely by local handlers (the
 * `resolvedBy: "ipc" | "handler"` tag). Neither this function nor
 * `runHandlerChain` emits terminal statelog events — the origin's
 * `renderVerdict` is the sole emitter, so relay hops (a parent process
 * evaluating a child's interrupt) contribute only handlerDecision events
 * to the shared trace. */
export async function gatherChainOutcome(
  interruptObj: InterruptInfo,
  ctx: RuntimeContext<any>,
  stack: StateStack | undefined,
  interruptId: string,
): Promise<{ outcome: HandlerChainOutcome; parentDecided: boolean }> {
  const local = await runHandlerChain(ctx, stack, interruptId, interruptObj);
  if (local.kind === "rejected") {
    // Local reject is final — fail-fast, the parent is never consulted.
    return { outcome: local, parentDecided: false };
  }
  if (isIpcMode()) {
    const parentOutcome = await sendInterruptToParent(interruptObj, interruptId);
    return {
      outcome: mergeChainOutcomes(interruptObj.effect, local, parentOutcome),
      parentDecided: parentOutcome.kind !== "noResponse",
    };
  }
  return { outcome: local, parentDecided: false };
}

/** Render a merged chain outcome into the shape `interruptWithHandlers`
 * returns, emitting the matching statelog event: approved/rejected resolve
 * in place; propagated/noResponse surface to the user as an Interrupt[].
 * Shared by the IPC and non-IPC decision paths so verdict rendering and
 * statelog dispatch live in exactly one place. */
function renderVerdict(
  merged: HandlerChainOutcome,
  ctx: RuntimeContext<any>,
  interruptId: string,
  interruptObj: InterruptInfo,
  resolvedBy: "ipc" | "handler",
): Interrupt[] | Approved | Rejected {
  const { effect, message, data, origin } = interruptObj;
  const interruptSummary = { effect, message, data };
  if (merged.kind === "rejected") {
    ctx.statelogClient.interruptResolved({
      interruptId,
      outcome: "rejected",
      resolvedBy,
      interrupt: interruptSummary,
    });
    return { type: "reject", value: merged.value };
  }
  if (merged.kind === "approved") {
    ctx.statelogClient.interruptResolved({
      interruptId,
      outcome: "approved",
      resolvedBy,
      interrupt: interruptSummary,
    });
    return { type: "approve", value: merged.value };
  }
  // propagated or noResponse — surface to the user.
  // Note: checkpointCreated for these interrupts is emitted by the generated
  // interrupt template code, not here. This is a known gap — non-tool
  // interrupts will have interruptThrown but no matching checkpointCreated
  // from the runtime. A future improvement could add checkpoint events to
  // the generated templates.
  const intr = interrupt({
    effect,
    message,
    data,
    origin,
    runId: ctx.getRunId(),
    interruptId,
    expectsValue: interruptObj.expectsValue,
  });
  ctx.statelogClient.interruptThrown({
    interruptId: intr.interruptId,
    interruptData: data,
  });
  return [intr];
}

export async function interruptWithHandlers<T = any>(
  effect: string,
  message: string,
  data: T,
  origin: string,
  ctx: RuntimeContext<any>,
  stack?: StateStack,
  // `expectsValue: true` marks an assignment-position raise (`const x = raise
  // …`): handlers and the surfaced Interrupt see that an approval value is
  // expected. Optional trailing object so already-compiled 6-arg calls keep
  // working.
  opts?: { expectsValue?: boolean },
): Promise<Interrupt<T>[] | Approved | Rejected> {
  const interruptObj: InterruptInfo = { effect, message, data, origin };
  if (opts?.expectsValue) interruptObj.expectsValue = true;
  const interruptId = nanoid();
  // The origin dispatch of the distributed chain: gatherChainOutcome walks
  // the local segment and — in IPC mode — consults the parent and merges
  // (the same walk every relay hop performs in handleInterruptMessage).
  // The verdict is rendered LOCALLY: the parent reports, this process
  // decides. A propagated/noResponse merge renders as an Interrupt[] — in a
  // subprocess that is the pause path (the batch bubbles through the normal
  // propagate machinery and the bootstrap converts it into an `interrupted`
  // terminal message).
  const { outcome, parentDecided } = await gatherChainOutcome(
    interruptObj,
    ctx,
    stack,
    interruptId,
  );
  return renderVerdict(outcome, ctx, interruptId, interruptObj, parentDecided ? "ipc" : "handler");
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
  // Re-install the CLI-driven root policy handler on the resumed exec context
  // (handlers are never checkpointed). Guarded no-op unless AGENCY_RUN_POLICY
  // is set and this is the root process. Mirrors the runNode install so the
  // policy survives a resumed leg.
  installRunPolicyHandler(execCtx);
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
  // terminal interruptResolved. Suppressed in IPC mode: a resumed
  // subprocess segment re-enters respondToInterrupts with the SAME
  // preserved interrupt ids in the same inherited trace, and the root
  // process already emitted the user resolution — a second (or, nested,
  // N+1th) emission would break thrown↔resolved pairing for consumers.
  if (!isIpcMode()) {
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

