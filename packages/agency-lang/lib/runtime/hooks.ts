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
import { getRuntimeContext } from "./asyncContext.js";
import { AgencyCancelledError, RestoreSignal } from "./errors.js";
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

/** All callbacks (scoped + top-level + TS-passed) return `void`. Callback
 *  bodies cannot raise interrupts — that is enforced statically by the
 *  typechecker (see `checkCallbackBodyInterrupts`). A callback that
 *  throws a JS error is caught and logged by `fireWithGuard`. */
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

async function invokeCallback(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  stateStack?: StateStack,
): Promise<void> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    // When `stateStack` is set, the callback frame is pushed onto that
    // stack rather than `ctx.stateStack`. This matters inside parallel
    // tool branches: scoped callbacks registered inside a branch's
    // frame chain must be discovered via the branch's stack.
    await (fn as AgencyFunction).invoke(
      { type: "positional", args: [data] },
      stateStack ? { ctx, stateStack } : { ctx },
    );
    return;
  }
  // Plain JS callbacks (from AgencyCallbacks TS arg) — just async funcs.
  await fn(data);
}

async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
  stateStack?: StateStack,
): Promise<void> {
  const key = fn as object;
  // Recursion guard scoped to the current ALS context. See
  // `_activeCallbacksALS` docstring for why ALS (not module-level
  // WeakSet, not per-stack WeakSet).
  const inherited = _activeCallbacksALS.getStore();
  if (inherited?.has(key)) return;
  // Always allocate a fresh set per fire — we need our own copy so a
  // deeper fire can safely re-enter without corrupting the outer set.
  // The new set carries over the inherited entries plus our own key.
  const active = new Set<object>(inherited);
  active.add(key);
  try {
    await _activeCallbacksALS.run(active, () =>
      invokeCallback(fn, data, ctx, stateStack),
    );
  } catch (error) {
    // Never swallow real control-flow exceptions used by the runtime.
    if (error instanceof RestoreSignal) throw error;
    if (error instanceof AgencyCancelledError) throw error;
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
 *  `ctx` is optional — when omitted, it's resolved from the active ALS
 *  frame via `getRuntimeContext()`. Every codegen-emitted `callHook(...)`
 *  site omits it. Within this repo, the remaining explicit-ctx callers
 *  are all in runtime code where an ALS frame *is* installed and the
 *  param is redundant:
 *    - `node.ts` — `onAgentStart` (inside `runInBootstrapFrame`) and
 *      `onAgentEnd` (inside `agencyStore.run` with the real threads).
 *    - `prompt.ts` — `onLLMCallStart`/`End` and the per-tool
 *      `onToolCallStart`/`End`, all called from inside a
 *      `Runner.runInScope` frame seeded by the generated node body.
 *  Those sites pass `ctx` defensively (predating the ALS migration)
 *  and could be tightened in a follow-up by dropping the param and
 *  making it required-via-ALS again. The slot stays optional so
 *  external callers that have a ctx but no ALS frame still work. */
export async function invokeCallbacks<K extends keyof CallbackMap>(args: {
  ctx?: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
  stateStack?: StateStack;
}): Promise<void> {
  const { name, data, stateStack } = args;
  const ctx = args.ctx ?? getRuntimeContext().ctx;
  const walkStack = stateStack ?? ctx.stateStack;

  // Fire global hooks (from external packages) first. Order matches the
  // pre-refactor behaviour of callHook.
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`, stateStack);
  }

  for (const fn of gatherCallbacks(ctx, name, walkStack)) {
    await fireWithGuard(fn, data, ctx, name, stateStack);
  }
}

/** Today's call sites that fire on the top-level stack. Thin wrapper over
 *  `invokeCallbacks` with no `stateStack` override. */
export async function callHook<K extends keyof CallbackMap>(args: {
  ctx?: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<void> {
  await invokeCallbacks(args);
}
