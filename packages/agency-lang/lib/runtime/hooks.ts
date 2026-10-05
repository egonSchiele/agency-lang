import type {
  CostEstimate,
  MessageJSON,
  ModelName,
  PromptResult,
  TokenUsage,
  ToolCallJSON,
  UserContentInput,
} from "smoltalk";
import type { CallbackName } from "../types/function.js";
import type { LLMRetryReason } from "./llmRetry.js";
import { AgencyFunction } from "./agencyFunction.js";
import { assertUsable, callPlain, sameRun, withChildRun, type Run } from "./asyncContext.js";
import { sendCallbackToParent } from "./callbackForwarding.js";
import { AgencyAbort, RunControlSignal } from "./errors.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { CheckpointJSON, TraceEvent } from "./trace/types.js";
import type { RunNodeResult } from "./types.js";

export type CallbackMap = {
  onAgentStart: {
    nodeName: string;
    args: Record<string, any>;
    messages: MessageJSON[];
    cancel: (reason?: string) => void;
  };
  onAgentEnd: { nodeName: string; result: RunNodeResult<any> };
  onNodeStart: { nodeName: string };
  onNodeEnd: { nodeName: string; data: any };
  onLLMCallStart: {
    // A string, or an array of text/attachment parts (redacted for logging).
    prompt: string | UserContentInput;
    tools: { name: string; description?: string; schema: any }[];
    model: ModelName | undefined;
    messages: MessageJSON[];
  };
  onLLMCallEnd: {
    model: string;
    result: PromptResult;
    usage: TokenUsage | undefined;
    cost: CostEstimate | undefined;
    timeTaken: number;
    messages: MessageJSON[];
  };
  onFunctionStart: {
    functionName: string;
    args: Record<string, any>;
    moduleId: string;
  };
  onFunctionEnd: { functionName: string; timeTaken: number };
  onToolCallStart: { toolName: string; args: Record<string, unknown> };
  onToolCallEnd: { toolName: string; result: any; timeTaken: number };
  onLLMRetry: {
    attempt: number; // 1-based retry number
    maxRetries: number; // the configured retry count
    delayMs: number;
    reason: LLMRetryReason;
    detail: string;
  };
  onLLMTimeout: { limitMs: number; attempt: number };
  onStream:
    | { type: "text"; text: string }
    | { type: "tool_call"; toolCall: ToolCallJSON }
    | { type: "done"; result: PromptResult }
    | { type: "error"; error: any };
  onTrace: TraceEvent;
  /** One statement checkpoint on the top-level stack, fired from `debugStep`
   *  whenever a consumer is registered. `checkpoint` is plain JSON (function
   *  refs encoded, as in a pause result); `{ type: "paused", checkpoint,
   *  runId }` resumes through `resumeFromCheckpoint`. Never forwarded from
   *  a subprocess. */
  onCheckpoint: { runId: string; checkpoint: CheckpointJSON };
  onOAuthRequired: {
    serverName: string;
    authUrl: string;
    complete: Promise<void>;
    cancel: () => void;
  };
  onEmit: unknown;
  onThreadStart: {
    threadId: string; // slug form ("t3")
    threadType: "thread" | "subthread";
    parentThreadId?: string; // slug form when present
    label?: string; // from thread(label: "...") {}
    isResumption?: boolean; // true when entered via continue/session
  };
  onThreadEnd: {
    threadId: string; // slug form
    label?: string;
    eagerSummarize: boolean; // from thread(summarize: true)
    messages: MessageJSON[]; // snapshot at close
  };
};

// Compile-time guard: ensures VALID_CALLBACK_NAMES stays in sync with CallbackMap.
type _AssertNamesMatchMap = CallbackName extends keyof CallbackMap
  ? keyof CallbackMap extends CallbackName
    ? true
    : false
  : false;
const _callbackNamesInSync: _AssertNamesMatchMap = true;

/** All callbacks (scoped + top-level + TS-passed) return `void`. Callback
 *  bodies cannot raise interrupts — that is enforced statically by the
 *  typechecker (see `checkCallbackBodyInterrupts`). A callback that
 *  throws a JS error is caught and logged by `fireWithGuard`. */
export type CallbackReturn<K extends keyof CallbackMap> = void;

export type AgencyCallbacks = {
  [K in keyof CallbackMap]?: (data: CallbackMap[K]) => void | Promise<void>;
};

// Recursion guard: prevents a callback that triggers helper functions
// which re-fire the same hook from recursing into itself
// (tests/agency/callback-recursion).
//
// The callbacks running on this path are listed on the frame, in
// `activeCallbacks`. Each `fireWithGuard` call runs the callback in a new
// frame whose list is the inherited one plus the callback's own key. That
// frame follows the callback through `await`s and nested calls, so a
// re-fire of the same callback further down sees its key and is skipped.
//
// Concurrent sibling branches (e.g. `Promise.allSettled([fireA(),
// fireB()])`) each run in their OWN frame, so A's key is visible only
// inside A's continuation chain, not inside B's. That's why parallel
// fork/tool branches can each fire the same callback without dropping
// sibling invocations.
//
// Why the frame rather than a per-stack or module-level set:
//   - A module-level set dropped legitimate parallel-branch invocations,
//     because every branch shared it.
//   - A per-stack set didn't catch recursion: each runBatch call creates a
//     NEW branch stack, so the recursive fire (which happens on the new
//     stack) never sees the outer fire's entry.
//
// The list is never serialized. An entry is visible only inside the frame
// of its fire, which ends when the callback resolves, so a checkpoint can
// never capture a "stuck" entry.

/** True while a callback body is executing on this async path. The runner
 *  defers an external pause here, because a checkpoint taken inside a
 *  callback dispatch is not a place a resume can re-enter. */
export function isInsideCallback(run: Run): boolean {
  return sameRun(run, "isInsideCallback()").activeCallbacks.length > 0;
}

// Global hook registry: allows external packages (e.g., @agency-lang/mcp) to
// register callbacks that fire alongside user-provided callbacks.
const _globalHooks: Partial<Record<keyof CallbackMap, Array<(data: any) => any>>> = {};

export function registerGlobalHook<K extends keyof CallbackMap>(
  name: K,
  fn: (data: CallbackMap[K]) => void | Promise<void>,
): void {
  if (!_globalHooks[name]) {
    _globalHooks[name] = [];
  }
  _globalHooks[name]!.push(fn);
}

async function invokeCallback(
  run: Run,
  fn: any,
  data: unknown,
  stateStack?: StateStack,
): Promise<void> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    // When `stateStack` is set, install an ALS frame overriding the
    // active stack so the callback body sees the branch's isolated
    // stack via `getRuntimeContext().stack`. This matters inside
    // parallel tool branches: scoped callbacks registered inside a
    // branch's frame chain must be discovered via the branch's stack.
    const af = fn as AgencyFunction;
    const desc = { type: "positional" as const, args: [data] };
    if (stateStack) {
      await withChildRun(run, { stack: stateStack }, "a callback", (branchRun) =>
        af.invoke(branchRun, desc),
      );
    } else {
      await af.invoke(run, desc);
    }
    return;
  }
  // Plain JS callbacks (from AgencyCallbacks TS arg) — just async funcs.
  await callPlain(run, fn, [data]);
}

async function fireWithGuard(
  run: Run,
  fn: any,
  data: unknown,
  errorLabel: string,
  stateStack?: StateStack,
): Promise<void> {
  const key = fn as object;
  // Recursion guard scoped to the current frame. See the comment above
  // `isInsideCallback` for why the list lives on the frame.
  const frame = assertUsable(sameRun(run, "fireWithGuard()"), "fire a callback");
  if (frame.activeCallbacks.includes(key)) return;
  // A new list per fire, holding the inherited entries plus our own key, so
  // a deeper fire can re-enter without changing the outer list.
  const active = [...frame.activeCallbacks, key];
  try {
    await withChildRun(frame, { activeCallbacks: active }, "a callback", (callbackRun) =>
      invokeCallback(callbackRun, fn, data, stateStack),
    );
  } catch (error) {
    // Never swallow real control-flow exceptions used by the runtime.
    // AgencyAbort covers BOTH a cancellation and a guard trip — a guard trip
    // raised inside a callback must propagate to its owning guard, not be
    // logged + dropped as a stray JS error (it is not an AgencyCancelledError).
    if (error instanceof RunControlSignal) throw error;
    if (error instanceof AgencyAbort) throw error;
    // Real JS errors (e.g. a callback body crashed) are logged and dropped.
    // Callback bodies cannot raise interrupts (typechecker-enforced), so
    // there is no interrupt path to surface here.
    console.error(`[agency] ${errorLabel} callback error:`, error);
  }
}

/** Gather every callback registered for `name`, in fire order. `stack` is
 *  the stack to walk for scoped callbacks — pass `ctx.stateStack` from
 *  top-level call sites, or a branch's own stack from inside a fork branch
 *  (otherwise scoped callbacks registered inside the branch's frame chain
 *  are missed). */
export function gatherCallbacks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
  stack: StateStack,
): any[] {
  // Order: innermost stack-frame scoped callbacks → outermost → top-level
  // (registered during module init) → TS-passed callback. Top-level comes
  // after stack-walked because conceptually they are "the outermost scope".
  const scoped = stack.collectScopedCallbacks(name);
  const topLevel = (ctx.topLevelCallbacks ?? [])
    .filter((cb) => cb.name === name)
    .map((cb) => cb.fn);
  const tsCb = ctx.callbacks[name];
  const out: any[] = [...scoped, ...topLevel];
  if (tsCb) out.push(tsCb);
  return out;
}

/** Whether any consumer is registered for `name` across all sources a fire
 *  would reach: global hooks, scoped callbacks on `stack`, top-level
 *  registrations, and a TS-passed callback. Mirrors what `invokeCallbacks`
 *  actually fires, so callers can branch on "is anyone listening?" without
 *  reaching into `ctx.callbacks` directly (which only sees the TS-passed
 *  slot — the bug that made streaming ignore `callback("onStream")`). */
export function hasCallbackConsumer<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
  stateStack?: StateStack,
): boolean {
  if ((_globalHooks[name]?.length ?? 0) > 0) return true;
  const walkStack = stateStack ?? ctx.stateStack;
  return gatherCallbacks(ctx, name, walkStack).length > 0;
}

/** Fire every callback registered for `name`, sequentially. When
 *  `stateStack` is supplied, callbacks run on that stack (so scoped
 *  callbacks registered inside a branch's frame chain are found). When
 *  `stateStack` is omitted, behaviour is identical to today's `callHook`:
 *  scoped callbacks are walked from `ctx.stateStack` and the callback
 *  frame pushes onto `ctx.stateStack`.
 *
 *  Used directly by sites that fire inside a fork/tool branch (e.g. the
 *  per-tool `onToolCallStart` / `onToolCallEnd` in `prompt.ts`). The
 *  public `callHook` is now a thin wrapper that omits `stateStack`.
 *
 *  The caller passes the run the callbacks fire under. `fireWithGuard`
 *  keeps its recursion guard on that run. */
export async function invokeCallbacks<K extends keyof CallbackMap>(
  run: Run,
  args: {
    name: K;
    data: CallbackMap[K];
    stateStack?: StateStack;
  },
): Promise<void> {
  const { name, data, stateStack } = args;

  // Forward every event to the parent when running inside a std::agency run()
  // subprocess, so the parent's registered callbacks fire for child events
  // (fire-and-forget; strips functions; no-op outside IPC). Purely additive: the
  // child still fires its own callbacks below. When THIS process is itself a
  // subprocess, this re-forwards relayed events upward -> automatic nested relay.
  sendCallbackToParent(name, data, run.log);

  const ctx = run.ctx;
  const walkStack = stateStack ?? ctx.stateStack;

  // Fire global hooks (from external packages) first. Order matches the
  // pre-refactor behaviour of callHook.
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(run, fn, data, `global ${name}`, stateStack);
  }

  for (const fn of gatherCallbacks(ctx, name, walkStack)) {
    await fireWithGuard(run, fn, data, name, stateStack);
  }
}

/** Today's call sites that fire on the top-level stack. Thin wrapper over
 *  `invokeCallbacks` with no `stateStack` override. */
export async function callHook<K extends keyof CallbackMap>(
  run: Run,
  args: {
    name: K;
    data: CallbackMap[K];
  },
): Promise<void> {
  await invokeCallbacks(run, args);
}
