import type {
  Message,
  PromptResult,
  Result,
  SmolConfig,
  StreamChunk,
} from "smoltalk";
import * as smoltalk from "smoltalk";
import type { ZodType } from "zod";
import { DEFAULT_EMBEDDING_MODEL } from "../constants.js";

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
 * Embedding config and result. We reuse smoltalk's types directly here
 * — there's no benefit to a parallel runtime-neutral shape since
 * the registered client always speaks one provider's protocol anyway,
 * and smoltalk's type covers the fields every provider cares about
 * (provider-specific api keys, dimensions, etc.).
 *
 * The LLMClient interface uses `Partial<smoltalk.EmbedConfig>` so the
 * `model` field can be left unset — the client fills in a sensible
 * default rather than forcing every caller to specify it.
 */
export type EmbedConfig = smoltalk.EmbedConfig;
export type EmbedResult = smoltalk.EmbedResult;

export type LLMClient = {
  text(config: PromptConfig): Promise<Result<PromptResult>>;
  textStream(config: PromptConfig): AsyncGenerator<StreamChunk>;
  /** Generate embeddings for one or more inputs. Returning a failure
   *  Result lets callers (e.g. memory Tier 2) silently skip rather
   *  than crash when a client doesn't support embeddings. */
  embed(
    input: string | string[],
    config?: Partial<EmbedConfig>,
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
    config?: Partial<EmbedConfig>,
  ): Promise<Result<EmbedResult>> {
    // Default to an embedding model — chat model defaults (e.g.
    // gpt-4o-mini) would be rejected by smoltalk.embed.
    return smoltalk.embed(input, {
      model: DEFAULT_EMBEDDING_MODEL,
      ...config,
    });
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
