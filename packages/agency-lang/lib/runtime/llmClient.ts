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

/**
 * Provider-agnostic embedding config. Mirrors PromptConfig's split from
 * smoltalk's SmolConfig: keeps the LLMClient interface usable by any
 * registered client, not just SmoltalkClient.
 */
export type EmbedConfig = {
  model?: string;
  provider?: string;
  dimensions?: number;
  apiKey?: string;
  metadata?: Record<string, any>;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
};

export type LLMClient = {
  text(config: PromptConfig): Promise<Result<PromptResult>>;
  textStream(config: PromptConfig): AsyncGenerator<StreamChunk>;
  /** Generate embeddings for one or more inputs. Optional on custom
   *  clients — returning a failure Result lets callers (e.g. memory
   *  Tier 2) silently skip rather than crash. */
  embed(
    input: string | string[],
    config?: EmbedConfig,
  ): Promise<Result<EmbedResult>>;
};

export class SmoltalkClient implements LLMClient {
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    return smoltalk.text({ ...this.toSmolConfig(config), stream: false });
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    yield* smoltalk.text({ ...this.toSmolConfig(config), stream: true });
  }

  async embed(
    input: string | string[],
    config?: EmbedConfig,
  ): Promise<Result<EmbedResult>> {
    // Default to a real embedding model — the chat model defaults
    // (e.g. gpt-4o-mini) would be rejected by smoltalk.embed.
    const model = config?.model ?? "text-embedding-3-small";
    const result = await smoltalk.embed(input, {
      model,
      provider: config?.provider as any,
      dimensions: config?.dimensions,
      openAiApiKey: config?.apiKey,
      metadata: config?.metadata,
    });
    if (!result.success) return result;
    return {
      success: true,
      value: {
        embeddings: result.value.embeddings,
        model: result.value.model,
      },
    };
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
