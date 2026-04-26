import type {
  MessageJSON,
  PromptResult,
  TokenUsage,
  CostEstimate,
  ToolCallJSON,
  ModelName,
  Strategy,
  StrategyJSON,
} from "smoltalk";
import type { RunNodeResult } from "./types.js";
import type { TraceEvent } from "./trace/types.js";
import type { CallbackName } from "../types/function.js";

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
    model: ModelName | Strategy | StrategyJSON | undefined;
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

export type CallbackReturn<K extends keyof CallbackMap> = K extends
  | "onLLMCallStart"
  | "onLLMCallEnd"
  ? MessageJSON[] | void
  : void;

export type AgencyCallbacks = {
  [K in keyof CallbackMap]?: (
    data: CallbackMap[K],
  ) => CallbackReturn<K> | Promise<CallbackReturn<K>>;
};

// Tracks which hooks are currently executing to prevent infinite recursion
// when a callback calls a helper function that would re-trigger the same hook.
// Keyed by callbacks object so concurrent executions don't block each other.
const _activeHooks = new WeakMap<AgencyCallbacks, Set<string>>();

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

export async function callHook<K extends keyof CallbackMap>(args: {
  callbacks: AgencyCallbacks;
  name: K;
  data: CallbackMap[K];
}): Promise<CallbackReturn<K> | undefined> {
  const { callbacks, name, data } = args;

  // Fire global hooks (from external packages)
  const globalFns = _globalHooks[name];
  if (globalFns) {
    for (const fn of globalFns) {
      try {
        await fn(data);
      } catch (error) {
        console.error(`[agency] global ${name} hook error:`, error);
      }
    }
  }

  const hook = callbacks[name];
  if (!hook) return undefined;
  let active = _activeHooks.get(callbacks);
  if (!active) {
    active = new Set();
    _activeHooks.set(callbacks, active);
  }
  if (!active.has(name)) {
    active.add(name);
    try {
      return (await hook(data)) as CallbackReturn<K>;
    } catch (error) {
      console.error(`[agency] ${name} callback error:`, error);
    } finally {
      active.delete(name);
    }
  }
  return undefined;
}
