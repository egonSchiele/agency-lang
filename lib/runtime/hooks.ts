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
import type { AuditEntry } from "./audit.js";

export type CallbackMap = {
  onAgentStart: {
    nodeName: string;
    args: Record<string, any>;
    messages: MessageJSON[];
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
  };
  onFunctionEnd: { functionName: string; timeTaken: number };
  onToolCallStart: { toolName: string; args: any[] };
  onToolCallEnd: { toolName: string; result: any; timeTaken: number };
  onStream:
    | { type: "text"; text: string }
    | { type: "tool_call"; toolCall: ToolCallJSON }
    | { type: "done"; result: PromptResult }
    | { type: "error"; error: any };
  onAudit: AuditEntry;
};

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

export async function callHook<K extends keyof CallbackMap>(args: {
  callbacks: AgencyCallbacks;
  name: K;
  data: CallbackMap[K];
}): Promise<CallbackReturn<K> | undefined> {
  const { callbacks, name, data } = args;
  const hook = callbacks[name];
  if (hook) {
    try {
      return (await hook(data)) as CallbackReturn<K>;
    } catch (error) {
      console.error(`[agency] ${name} callback error:`, error);
    }
  }
  return undefined;
}
