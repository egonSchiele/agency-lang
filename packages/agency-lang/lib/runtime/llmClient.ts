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

/**
 * Provider-neutral view of an error thrown by an LLMClient. Lets agency's retry
 * classifier decide policy without importing any provider SDK. The client
 * adapter (which knows its provider's error shapes) populates this.
 */
export type NormalizedLLMError = {
  /** HTTP status, when the error came from an HTTP response. */
  status?: number;
  /** Server-requested retry delay (ms), parsed from response headers if present. */
  retryAfterMs?: number;
  /** Terminal-ish provider classifications the client recognizes. Undefined for
   *  generic / transport errors (agency falls back to status + message). */
  kind?: "contentPolicy" | "contextWindow" | "structuredOutput" | "requestTimeout";
  /** Human-readable message (always present). */
  message: string;
};

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
  /** Translate an error this client threw into provider-neutral fields for
   *  agency's retry classifier. Optional — agency falls back to `{ message }`. */
  normalizeError?(err: unknown): NormalizedLLMError;
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

  normalizeError(err: unknown): NormalizedLLMError {
    if (!(err instanceof smoltalk.SmolError)) {
      let message: string;
      if (err instanceof Error) {
        message = err.message;
      } else {
        message = String(err);
      }
      return { message };
    }

    const normalized: NormalizedLLMError = { message: err.message };
    if (err.status !== undefined) {
      normalized.status = err.status;
    }
    const retryAfterMs = parseRetryAfter(err.headers);
    if (retryAfterMs !== undefined) {
      normalized.retryAfterMs = retryAfterMs;
    }
    if (err instanceof smoltalk.SmolContentPolicyError) {
      normalized.kind = "contentPolicy";
    } else if (err instanceof smoltalk.SmolContextWindowExceededError) {
      normalized.kind = "contextWindow";
    } else if (err instanceof smoltalk.SmolStructuredOutputError) {
      normalized.kind = "structuredOutput";
    } else if (err instanceof smoltalk.SmolTimeoutError) {
      normalized.kind = "requestTimeout";
    }
    return normalized;
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

function parseRetryAfter(
  headers: Record<string, string> | undefined,
): number | undefined {
  if (!headers) {
    return undefined;
  }
  const ms = headers["retry-after-ms"];
  if (ms !== undefined && !Number.isNaN(Number(ms))) {
    return Number(ms);
  }
  const seconds = headers["retry-after"];
  if (seconds !== undefined && !Number.isNaN(Number(seconds))) {
    return Number(seconds) * 1000;
  }
  return undefined;
}
