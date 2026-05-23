import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CostEstimate,
  MessageJSON,
  ModelName,
  PromptResult,
  TokenUsage,
  ToolCallJSON,
} from "smoltalk";
import type { CallbackName } from "../types/function.js";
import { AgencyFunction } from "./agencyFunction.js";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
import { hasInterrupts, type Interrupt } from "./interrupts.js";
import { isFailure, type ResultFailure } from "./result.js";
import type { RuntimeContext } from "./state/context.js";
import type { StateStack } from "./state/stateStack.js";
import type { TraceEvent } from "./trace/types.js";
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
    prompt: string;
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
    isBuiltin: boolean;
    moduleId: string;
  };
  onFunctionEnd: { functionName: string; timeTaken: number };
  onToolCallStart: { toolName: string; args: Record<string, unknown> };
  onToolCallEnd: { toolName: string; result: any; timeTaken: number };
  onStream:
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCallJSON }
  | { type: "done"; result: PromptResult }
  | { type: "error"; error: any };
  onTrace: TraceEvent;
  onOAuthRequired: {
    serverName: string;
    authUrl: string;
    complete: Promise<void>;
    cancel: () => void;
  };
  onEmit: unknown;
};

// Compile-time guard: ensures VALID_CALLBACK_NAMES stays in sync with CallbackMap.
type _AssertNamesMatchMap = CallbackName extends keyof CallbackMap ? keyof CallbackMap extends CallbackName ? true : false : false;
const _callbackNamesInSync: _AssertNamesMatchMap = true;

/** All callbacks (scoped + top-level + TS-passed) now return `void`. The old
 *  message-override capability on `onLLMCallStart`/`onLLMCallEnd` has been
 *  removed — return values are discarded. */
export type CallbackReturn<K extends keyof CallbackMap> = void;

export type AgencyCallbacks = {
  [K in keyof CallbackMap]?: (
    data: CallbackMap[K],
  ) => void | Promise<void>;
};

// Recursion guard: prevents a callback that triggers helper functions
// which re-fire the same hook from recursing into itself
// (tests/agency/callback-recursion).
//
// Each `fireWithGuard` call wraps the callback in
// `_activeCallbacksALS.run(active, ...)` with a freshly-allocated
// `new Set<object>(inherited)` that adds the current callback's key.
// The Set is inherited through `await` boundaries and nested sync
// calls inside that scope, so a synchronous re-fire of the same
// callback (via a helper-function call on the same async chain) sees
// its own key in the set and is skipped.
//
// Concurrent sibling branches (e.g. `Promise.allSettled([fireA(),
// fireB()])`) each enter their OWN `_activeCallbacksALS.run(...)`
// scope, so A's added key is visible only inside A's continuation
// chain, not inside B's. That's why parallel fork/tool branches can
// each fire the same callback without dropping sibling invocations.
// (Note: `statelogClient.runInBranchContext` scopes a different ALS
// — `spanStorage` for Statelog spans — and does NOT touch this
// callback guard. Sibling isolation here comes purely from each fire
// allocating its own Set and entering its own ALS scope.)
//
// Why ALS rather than a per-stack or module-level WeakSet:
//   - Module-level WeakSet (pre-Task 5 behaviour) dropped legitimate
//     parallel-branch invocations because every branch shared the
//     same set.
//   - Per-stack WeakSet didn't catch recursion: each runBatch call
//     creates a NEW branch stack, so the recursive fire (which
//     happens on the new stack) never sees the outer fire's entry.
//   - ALS naturally inherits the set through both sync calls and
//     awaited continuations, and each fire's `.run(...)` scope
//     isolates siblings from one another.
//
// Set entries are live-only — never serialized. Cleanup is automatic:
// the entry is only visible inside the `_activeCallbacksALS.run(...)`
// scope of its fire, which exits when the callback resolves, so a
// checkpoint can never capture a "stuck" entry.
const _activeCallbacksALS = new AsyncLocalStorage<Set<object>>();

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

/** Outcome of firing a callback. `ok` means the callback completed
 *  normally; `interrupts` means it raised one or more agency interrupts
 *  that need user response; `failure` means the user (or a handler)
 *  rejected an interrupt the callback raised — see
 *  `docs/superpowers/plans/2026-05-23-callback-rejection-propagation.md`. */
export type CallbackOutcome =
  | { kind: "ok" }
  | { kind: "interrupts"; interrupts: Interrupt[] }
  | { kind: "failure"; failure: ResultFailure };

/** Extract a Failure from a callback's return value, handling both the
 *  bare `failure(...)` shape (used by `def`-style callbacks) and the
 *  node-context envelope `{ messages, data: failure(...) }` produced by
 *  callbacks compiled inside a node-style scope. Returns the unwrapped
 *  failure or undefined if neither shape matches. */
function extractCallbackFailure(result: any): ResultFailure | undefined {
  if (isFailure(result)) return result;
  if (result && typeof result === "object" && isFailure((result as any).data)) {
    return (result as any).data;
  }
  return undefined;
}

async function invokeCallback(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  stateStack?: StateStack,
): Promise<CallbackOutcome> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    // When `stateStack` is set, the callback frame is pushed onto that
    // stack rather than `ctx.stateStack`. This matters inside parallel
    // tool branches: the callback's interrupt checkpoint must capture
    // the branch's slice (so `setInterruptOnBranch` finds the right
    // frame), not the parent's stack. See Plan 1 / Bug 2 in
    // docs/notes/parallel-callback-investigation.md.
    const result = await (fn as AgencyFunction).invoke(
      { type: "positional", args: [data] },
      stateStack ? { ctx, stateStack } : { ctx },
    );
    // The callback body completed with an unhandled `interrupt` statement.
    // Surface the interrupts so the caller can decide what to do.
    if (hasInterrupts(result)) {
      return { kind: "interrupts", interrupts: result as Interrupt[] };
    }
    // The callback raised an interrupt that a handler (or the user) rejected.
    // Generated `interrupt` codegen translates rejection to
    // `runner.halt(failure("interrupt rejected", ...))`, so the callback's
    // return value is a Failure — possibly wrapped in a node-context envelope.
    const failure = extractCallbackFailure(result);
    if (failure) return { kind: "failure", failure };
    return { kind: "ok" };
  }
  // Plain JS callbacks (from AgencyCallbacks TS arg) have no interrupt
  // mechanism — they're just async functions. Errors thrown by them still
  // get caught by fireWithGuard below.
  await fn(data);
  return { kind: "ok" };
}

async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
  stateStack?: StateStack,
): Promise<CallbackOutcome> {
  const key = fn as object;
  // Recursion guard scoped to the current ALS context. See
  // `_activeCallbacksALS` docstring for why ALS (not module-level
  // WeakSet, not per-stack WeakSet).
  const inherited = _activeCallbacksALS.getStore();
  if (inherited?.has(key)) return { kind: "ok" };
  // Always allocate a fresh set per fire — we need our own copy so a
  // deeper fire can safely re-enter without corrupting the outer set.
  // The new set carries over the inherited entries plus our own key.
  const active = new Set<object>(inherited);
  active.add(key);
  try {
    return await _activeCallbacksALS.run(active, () =>
      invokeCallback(fn, data, ctx, stateStack),
    );
  } catch (error) {
    // Never swallow real control-flow exceptions used by the runtime.
    if (error instanceof RestoreSignal) throw error;
    if (error instanceof AgencyCancelledError) throw error;
    // Real JS errors (e.g. a callback body crashed) still get logged here.
    // Interrupts no longer flow through this path — they return normally
    // from invokeCallback now.
    console.error(`[agency] ${errorLabel} callback error:`, error);
    return { kind: "ok" };
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

/** Fire every callback registered for `name`, sequentially. When
 *  `stateStack` is supplied, callbacks run on that stack (so any interrupt
 *  raised inside a callback captures a checkpoint with the right slice and
 *  `setInterruptOnBranch` finds the right frame). When `stateStack` is
 *  omitted, behaviour is identical to today's `callHook`: scoped callbacks
 *  are walked from `ctx.stateStack` and the callback frame pushes onto
 *  `ctx.stateStack`.
 *
 *  Used directly by sites that fire inside a fork/tool branch (e.g. the
 *  per-tool `onToolCallStart` / `onToolCallEnd` in `prompt.ts`). The
 *  public `callHook` is now a thin wrapper that omits `stateStack`. */
export async function invokeCallbacks<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
  stateStack?: StateStack;
}): Promise<CallbackOutcome> {
  const { ctx, name, data, stateStack } = args;
  const walkStack = stateStack ?? ctx.stateStack;

  // Single shared collector. Mirrors the runForkAll pattern of "let every
  // sibling run to completion, batch all interrupts together at the end"
  // (see docs/dev/concurrent-interrupts.md). Callbacks are sequential
  // here (not parallel like fork branches), but the batching semantics
  // are the same: an interrupt from callback A must not short-circuit
  // callback B.
  const collected: Interrupt[] = [];

  // Fire global hooks (from external packages) first. They are plain JS
  // and have no interrupt mechanism, so they can't contribute to the
  // batch.
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`, stateStack);
  }

  for (const fn of gatherCallbacks(ctx, name, walkStack)) {
    const outcome = await fireWithGuard(fn, data, ctx, name, stateStack);
    // First failure wins — later callbacks don't fire. Matches how a JS
    // error inside a Runner.step body short-circuits the rest of that
    // step. See docs/superpowers/plans/2026-05-23-callback-rejection-
    // propagation.md.
    if (outcome.kind === "failure") return outcome;
    if (outcome.kind === "interrupts") {
      collected.push(...outcome.interrupts);
    }
  }

  // Defensive: onAgentStart / onAgentEnd fire outside any agency frame so
  // there is no Runner to halt and nowhere for the user to respond from.
  // Reject loudly so a developer who accidentally registers an
  // interrupt-raising callback for these hooks sees a clear error
  // instead of silent failure (callHookAndDrop would log + drop them).
  if (
    collected.length > 0 &&
    (name === "onAgentStart" || name === "onAgentEnd")
  ) {
    throw new Error(
      `[agency] ${name} callbacks cannot raise interrupts: the agent has ` +
        `no active frame to checkpoint, so there is nowhere for the user ` +
        `to respond from. Remove the interrupt() call from the callback ` +
        `body, or move the registration to a hook that fires inside an ` +
        `agency call frame (onFunctionStart, onNodeStart, etc.).`,
    );
  }

  return collected.length > 0
    ? { kind: "interrupts", interrupts: collected }
    : { kind: "ok" };
}

/** Today's call sites that fire on the top-level stack. Thin wrapper over
 *  `invokeCallbacks` with no `stateStack` override. */
export async function callHook<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<CallbackOutcome> {
  return invokeCallbacks(args);
}

/** Fire a SINGLE specific callback (already extracted from
 *  `gatherCallbacks`) on the given `stateStack`. Returns the callback's
 *  outcome (ok / interrupts / failure). Used by `Runner.hook`'s
 *  per-callback runBatch path so each batch child corresponds to exactly
 *  one callback — letting runBatch's cached-branch short-circuit skip
 *  already-resolved callbacks on resume. */
export async function invokeOneCallback<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  fn: any;
  name: K;
  data: CallbackMap[K];
  stateStack?: StateStack;
}): Promise<CallbackOutcome> {
  return fireWithGuard(args.fn, args.data, args.ctx, args.name, args.stateStack);
}

/** Fire every globally-registered hook (from `registerGlobalHook`) for
 *  `name`. Global hooks are plain JS with no interrupt mechanism, so
 *  they always run inline — `Runner.hook` calls this before delegating
 *  the scoped/top-level/ts callbacks to runBatch. */
export async function fireGlobalHooks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
  data: CallbackMap[K],
  stateStack?: StateStack,
): Promise<void> {
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`, stateStack);
  }
}

/**
 * Fire a hook with the today-style "log + drop" interrupt behavior.
 *
 * Existing TS-side runtime call sites (in `lib/runtime/node.ts` and
 * `lib/runtime/prompt.ts`) wrap `callHook` with this helper because
 * they cannot propagate callback interrupts up the agency runner: they
 * sit either outside any agency frame (onAgentStart / onAgentEnd) or
 * inside `runPrompt`'s internal state machine which has no resumable
 * substep machinery yet. Phase 2 of the callback-interrupts work will
 * give the LLM/tool sites real propagation; until then they continue
 * to log and drop, matching the pre-refactor behavior.
 *
 * Codegen-emitted hook sites (the `ts.callHook(...)` builder) get
 * actual propagation in Phase 1 by emitting `callHook` directly and
 * checking the return value inline.
 */
export async function callHookAndDrop<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<void> {
  const outcome = await callHook(args);
  if (outcome.kind === "interrupts") {
    console.error(
      `[agency] ${args.name} callback raised an unhandled interrupt ` +
        `(kind="${outcome.interrupts[0].kind}") at a runtime call site that does not ` +
        `support interrupt propagation. The interrupt is being dropped. ` +
        `Some sites (onAgentStart/onAgentEnd) fundamentally cannot ` +
        `propagate because they fire outside any agency frame; others ` +
        `(LLM/tool hooks) may gain propagation in a future phase. To ` +
        `respond to this interrupt, register the callback on a hook ` +
        `that fires inside an agency call frame instead.`,
      outcome.interrupts,
    );
  } else if (outcome.kind === "failure") {
    console.error(
      `[agency] ${args.name} callback halted with a rejected interrupt ` +
        `(error="${outcome.failure.error}") at a runtime call site that ` +
        `does not support failure propagation. The failure is being ` +
        `dropped. Top-level hooks (onAgentStart/onAgentEnd) fundamentally ` +
        `cannot propagate because they fire outside any agency frame.`,
      outcome.failure,
    );
  }
}
