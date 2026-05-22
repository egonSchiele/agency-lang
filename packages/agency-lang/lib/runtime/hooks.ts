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
import type { RuntimeContext } from "./state/context.js";
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

// Per-instance recursion guard: prevents a callback that triggers helper
// functions which re-fire the same hook from recursing into itself.
const _activeCallbacks = new WeakSet<object>();

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
  _errorLabel: string,
): Promise<Interrupt[] | undefined> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    const result = await (fn as AgencyFunction).invoke(
      { type: "positional", args: [data] },
      { ctx },
    );
    // The callback body completed with an unhandled `interrupt` statement.
    // Surface the interrupts so the caller can decide what to do — Phase 0
    // callers (`callHookAndDrop`) log them; Phase 1+ codegen sites stamp a
    // checkpoint and propagate them up the runner.
    if (hasInterrupts(result)) {
      return result as Interrupt[];
    }
    return undefined;
  }
  // Plain JS callbacks (from AgencyCallbacks TS arg) have no interrupt
  // mechanism — they're just async functions. Errors thrown by them still
  // get caught by fireWithGuard below.
  await fn(data);
  return undefined;
}

async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
): Promise<Interrupt[] | undefined> {
  const key = fn as object;
  if (_activeCallbacks.has(key)) return undefined;
  _activeCallbacks.add(key);
  try {
    return await invokeCallback(fn, data, ctx, errorLabel);
  } catch (error) {
    // Never swallow real control-flow exceptions used by the runtime.
    if (error instanceof RestoreSignal) throw error;
    if (error instanceof AgencyCancelledError) throw error;
    // Real JS errors (e.g. a callback body crashed) still get logged here.
    // Interrupts no longer flow through this path — they return normally
    // from invokeCallback now.
    console.error(`[agency] ${errorLabel} callback error:`, error);
    return undefined;
  } finally {
    _activeCallbacks.delete(key);
  }
}

function gatherCallbacks<K extends keyof CallbackMap>(
  ctx: RuntimeContext<any>,
  name: K,
): any[] {
  // Order: innermost stack-frame scoped callbacks → outermost → top-level
  // (registered during module init) → TS-passed callback. Top-level comes
  // after stack-walked because conceptually they are "the outermost scope".
  const scoped = ctx.stateStack.collectScopedCallbacks(name);
  const topLevel = (ctx.topLevelCallbacks ?? [])
    .filter((cb) => cb.name === name)
    .map((cb) => cb.fn);
  const tsCb = ctx.callbacks[name];
  const out: any[] = [...scoped, ...topLevel];
  if (tsCb) out.push(tsCb);
  return out;
}

export async function callHook<K extends keyof CallbackMap>(args: {
  ctx: RuntimeContext<any>;
  name: K;
  data: CallbackMap[K];
}): Promise<Interrupt[] | undefined> {
  const { ctx, name, data } = args;

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
    await fireWithGuard(fn, data, ctx, `global ${name}`);
  }

  for (const fn of gatherCallbacks(ctx, name)) {
    const result = await fireWithGuard(fn, data, ctx, name);
    if (result) collected.push(...result);
  }

  return collected.length > 0 ? collected : undefined;
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
  const result = await callHook(args);
  if (result) {
    console.error(
      `[agency] ${args.name} callback raised an unhandled interrupt ` +
        `(kind="${result[0].kind}") at a runtime call site that does not ` +
        `support interrupt propagation. The interrupt is being dropped. ` +
        `Move the hook firing into an agency-controlled scope, or wait for ` +
        `Phase 2 of the callback-interrupts work.`,
      result,
    );
  }
}
