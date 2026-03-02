import type {
  MessageJSON,
  PromptResult,
  TokenUsage,
  CostEstimate,
  ToolCallJSON,
  ModelConfig,
  ModelName,
} from "smoltalk";
import type { RunNodeResult } from "./types.js";

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
    model: ModelName | ModelConfig | undefined;
  };
  onLLMCallEnd: {
    model: string | ModelConfig;
    result: PromptResult;
    usage: TokenUsage | undefined;
    cost: CostEstimate | undefined;
    timeTaken: number;
  };
  onToolCallStart: { toolName: string; args: any[] };
  onToolCallEnd: { toolName: string; result: any; timeTaken: number };
  onStream:
    | { type: "text"; text: string }
    | { type: "tool_call"; toolCall: ToolCallJSON }
    | { type: "done"; result: PromptResult }
    | { type: "error"; error: any };
};

export type AgencyCallbacks = {
  [K in keyof CallbackMap]?: (data: CallbackMap[K]) => void | Promise<void>;
};

export async function callHook<K extends keyof CallbackMap>(args: {
  callbacks: AgencyCallbacks;
  name: K;
  data: CallbackMap[K];
}): Promise<void> {
  const { callbacks, name, data } = args;
  const hook = callbacks[name];
  if (hook) {
    await hook(data);
  }
}
