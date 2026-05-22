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

function isAgencyInterrupt(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as any).__agencyInterrupt === true);
}

async function invokeCallback(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
): Promise<void> {
  if (AgencyFunction.isAgencyFunction(fn)) {
    await (fn as AgencyFunction).invoke(
      { type: "positional", args: [data] },
      { ctx },
    );
    return;
  }
  await fn(data);
}

async function fireWithGuard(
  fn: any,
  data: unknown,
  ctx: RuntimeContext<any>,
  errorLabel: string,
): Promise<void> {
  const key = fn as object;
  if (_activeCallbacks.has(key)) return;
  _activeCallbacks.add(key);
  try {
    await invokeCallback(fn, data, ctx);
  } catch (error) {
    if (isAgencyInterrupt(error)) throw error;
    console.error(`[agency] ${errorLabel} callback error:`, error);
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
}): Promise<void> {
  const { ctx, name, data } = args;

  // Fire global hooks (from external packages) first
  for (const fn of _globalHooks[name] ?? []) {
    await fireWithGuard(fn, data, ctx, `global ${name}`);
  }

  for (const fn of gatherCallbacks(ctx, name)) {
    await fireWithGuard(fn, data, ctx, name);
  }
}
