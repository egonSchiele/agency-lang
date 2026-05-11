import type {
  Message,
  PromptResult,
  Result,
  SmolConfig,
  StreamChunk,
} from "smoltalk";
import * as smoltalk from "smoltalk";
import type { ZodType } from "zod";

export type ToolDefinition = {
  name: string;
  description?: string;
  schema: ZodType;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
};

export type PromptConfig = {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: ZodType;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  reasoningEffort?: "low" | "medium" | "high";
  apiKey?: string;
  model?: string;
  provider?: string;
  metadata?: Record<string, any>;
  abortSignal?: AbortSignal;
  hooks?: Partial<{
    onStart: (config: PromptConfig) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onEnd: (result: PromptResult) => void;
    onError: (error: Error) => void;
  }>;
};

export type LLMClient = {
  text(config: PromptConfig): Promise<Result<PromptResult>>;
  textStream(config: PromptConfig): AsyncGenerator<StreamChunk>;
};

export class SmoltalkClient implements LLMClient {
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    return smoltalk.text({ ...this.toSmolConfig(config), stream: false });
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    yield* smoltalk.text({ ...this.toSmolConfig(config), stream: true });
  }

  private toSmolConfig(config: PromptConfig): Omit<SmolConfig, "stream"> {
    const {
      messages, tools, responseFormat, abortSignal,
      model, apiKey, maxTokens, temperature, provider,
      thinking, reasoningEffort, metadata,
    } = config;

    return {
      ...metadata,
      messages, tools, responseFormat, abortSignal,
      model, maxTokens, temperature, provider, thinking, reasoningEffort,
      openAiApiKey: apiKey,
    } as Omit<SmolConfig, "stream">;
  }
}
