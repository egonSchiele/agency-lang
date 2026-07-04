import type {
  Message,
  PromptResult,
  Result,
  SmolConfig,
  StreamChunk,
} from "smoltalk";
import * as smoltalk from "smoltalk";
import type { ZodType } from "zod";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_IMAGE_MODEL } from "../constants.js";

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
  /** Server-side hosted tools to enable for this call, by capability name
   *  (e.g. ["web_search"]). Distinct from `tools` (client functions): hosted
   *  tools run on the provider and return results inline. A client that does
   *  not support hosted tools simply ignores this field. */
  hostedTools?: string[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: ZodType;
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  reasoningEffort?: "low" | "medium" | "high";
  /** A bare string is the OpenAI-key shorthand; the object form (same shape as
   *  `SmolConfig["apiKey"]`) supplies per-provider keys. See `toSmolConfig`. */
  apiKey?: string | SmolConfig["apiKey"];
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

// The single image type surface — custom-client authors and the std::image
// helper import these from here rather than reaching into smoltalk directly.
export type ImageConfig = smoltalk.ImageConfig;
export type ImageGenResult = smoltalk.ImageGenResult;
export type ImageInput = smoltalk.ImageInput;
export type ImageRef = smoltalk.ImageRef;

/**
 * Provider-neutral view of an error thrown by an `LLMClient`. Lets agency's
 * retry classifier decide policy without importing any provider SDK. The
 * client adapter (which knows its provider's error shapes) populates this.
 *
 * All fields except `message` are optional, so a custom client can supply as
 * little as it knows. Classification (`lib/runtime/llmRetry.ts`) prefers
 * `kind` when set, then `status`, then falls back to message-matching on
 * `message`.
 */
export type NormalizedLLMError = {
  /** HTTP status, when the error came from an HTTP response. */
  status?: number;
  /** Server-requested retry delay (ms), already parsed (e.g. from
   *  `retry-after` / `retry-after-ms` headers) by the client. */
  retryAfterMs?: number;
  /** Provider classifications the client recognizes. All are provider-neutral;
   *  a custom client can populate any subset. Retryable: `rateLimit`,
   *  `overloaded`, `requestTimeout`. Terminal: `contentPolicy`,
   *  `contextWindow`, `structuredOutput`, `auth`. Undefined for unclassified
   *  errors — agency falls back to `status`, then `message`. */
  kind?:
    | "contentPolicy"
    | "contextWindow"
    | "structuredOutput"
    | "requestTimeout"
    | "rateLimit"
    | "overloaded"
    | "auth";
  /** Human-readable message (always present). */
  message: string;
};

/**
 * The pluggable LLM transport. Agency ships `SmoltalkClient` as the default,
 * but anything implementing this shape can be swapped in via
 * `ctx.llmClient`. The only smoltalk-specific surface is the message / chunk
 * shapes (`Message`, `PromptResult`, `StreamChunk`, `EmbedConfig`,
 * `EmbedResult`) which we re-export from smoltalk for convenience.
 *
 * `normalizeError` is optional. When absent, agency's retry layer falls back
 * to `{ message: String(err) }` — meaning it can only classify errors by
 * matching keywords in the message (`ECONNRESET`, `terminated`, etc.). A
 * client that wants status-based or typed classification should implement
 * `normalizeError` and populate the `NormalizedLLMError` fields it knows
 * about. No retry semantics are baked in here — the policy lives entirely
 * in `lib/runtime/llmRetry.ts`.
 */
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
  /** Generate an image. Optional — clients that don't support it omit the
   *  method; callers (std::image) surface a failure Result. */
  image?(
    input: ImageInput,
    config?: Partial<ImageConfig>,
  ): Promise<Result<ImageGenResult>>;
  /** Translate an error this client threw into provider-neutral fields for
   *  agency's retry classifier. Optional — agency falls back to `{ message }`
   *  when omitted, which still works (message-pattern matching) but loses
   *  status- and `kind`-based classification. */
  normalizeError?(err: unknown): NormalizedLLMError;
};

export class SmoltalkClient implements LLMClient {
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    return smoltalk.text({ ...toSmolConfig(config), stream: false });
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    yield* smoltalk.text({ ...toSmolConfig(config), stream: true });
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

  async image(
    input: ImageInput,
    config?: Partial<ImageConfig>,
  ): Promise<Result<ImageGenResult>> {
    // `model` first so an explicit config.model overrides the default.
    return smoltalk.image(input, {
      model: DEFAULT_IMAGE_MODEL,
      ...config,
    } as ImageConfig);
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

    // smoltalk 0.4.2 already exposes `status`, `retryAfterMs`, and typed
    // subclasses for the standard provider failures — read them through
    // rather than re-parsing headers or sniffing status codes ourselves.
    const normalized: NormalizedLLMError = { message: err.message };
    if (err.status !== undefined) {
      normalized.status = err.status;
    }
    if (err.retryAfterMs !== undefined) {
      normalized.retryAfterMs = err.retryAfterMs;
    }
    if (err instanceof smoltalk.SmolContentPolicyError) {
      normalized.kind = "contentPolicy";
    } else if (err instanceof smoltalk.SmolContextWindowExceededError) {
      normalized.kind = "contextWindow";
    } else if (err instanceof smoltalk.SmolStructuredOutputError) {
      normalized.kind = "structuredOutput";
    } else if (err instanceof smoltalk.SmolTimeoutError) {
      normalized.kind = "requestTimeout";
    } else if (err instanceof smoltalk.SmolRateLimitError) {
      normalized.kind = "rateLimit";
    } else if (err instanceof smoltalk.SmolOverloadedError) {
      normalized.kind = "overloaded";
    } else if (err instanceof smoltalk.SmolAuthError) {
      normalized.kind = "auth";
    }
    return normalized;
  }

}

/** Convert agency's PromptConfig into smoltalk's SmolConfig.
 *  The nested `apiKey` map (every provider's key) and `baseUrl` arrive via
 *  `...metadata` (the merged smoltalk client config) and MUST be preserved —
 *  replacing `apiKey` wholesale here would clobber non-OpenAI / hosted-provider
 *  keys. A per-call `apiKey` string overrides only `apiKey.openAi`; a per-call
 *  `apiKey` object merges over the metadata map (per-provider override). */
export function toSmolConfig(config: PromptConfig): Omit<SmolConfig, "stream"> {
  const {
    messages, tools, responseFormat, abortSignal,
    model, apiKey, maxTokens, temperature, provider,
    thinking, reasoningEffort, metadata, hostedTools,
  } = config;

  const metaApiKey = (metadata as { apiKey?: SmolConfig["apiKey"] } | undefined)
    ?.apiKey;
  return {
    ...metadata,
    messages, tools, responseFormat, abortSignal,
    model, maxTokens, temperature, provider, thinking, reasoningEffort,
    hostedTools,
    ...(typeof apiKey === "string"
      ? { apiKey: { ...metaApiKey, openAi: apiKey } }
      : apiKey
      ? { apiKey: { ...metaApiKey, ...apiKey } }
      : {}),
  } as Omit<SmolConfig, "stream">;
}
