# LLM Client Abstraction

## Problem

Agency currently hardcodes smoltalk as the LLM client. All `llm()` calls go through `smoltalk.text()` in `lib/runtime/prompt.ts`. Users who want to use a different LLM package (e.g., for a different provider, custom retry logic, or a proprietary API) have no way to swap it out.

## Solution

Define a minimal `LLMClient` interface with an Agency-owned `PromptConfig` type. Users can provide an alternative client via a `setLLMClient()` builtin function. Smoltalk remains the default when no client is set.

## Design

### 1. Agency-Owned PromptConfig

Agency defines its own config type rather than using smoltalk's `SmolPromptConfig`. This gives Agency control over the interface stability and keeps the contract clean for alternative client authors.

```typescript
type ToolDefinition = {
  name: string;
  description?: string;
  schema: ZodType;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
};

type PromptConfig = {
  /** The conversation messages to send to the model. */
  messages: Message[];

  /** Tools (functions) the model can call. */
  tools?: ToolDefinition[];

  /** Maximum number of tokens the model can generate. */
  maxTokens?: number;

  /** Sampling temperature (0-2). */
  temperature?: number;

  /** A Zod schema to constrain the model's output to structured JSON. */
  responseFormat?: ZodType;

  /** Enable extended thinking / reasoning. */
  thinking?: {
    enabled: boolean;
    /** Token budget for thinking. (Anthropic only) */
    budgetTokens?: number;
  };

  /** Provider-agnostic reasoning effort level. */
  reasoningEffort?: "low" | "medium" | "high";

  /** API key for the provider. */
  apiKey?: string;

  /** Model identifier. */
  model?: string;

  /** Override the provider. */
  provider?: string;

  /** Client-specific options — escape hatch for features not in the standard config. */
  metadata?: Record<string, any>;

  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;

  /** Lifecycle hooks. Called by client implementations at the appropriate points. */
  hooks?: Partial<{
    onStart: (config: PromptConfig) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onEnd: (result: PromptResult) => void;
    onError: (error: Error) => void;
  }>;
};
```

**Two audiences for this config:**

- **Users** see a subset when passing the second arg to `llm()` (model, temperature, maxTokens, etc.). They never see hooks or messages — Agency fills those in.
- **Client authors** implement against the full `PromptConfig`. They must call the lifecycle hooks at the appropriate points in their implementation. `metadata` is the escape hatch for client-specific options.

`Message`, `PromptResult`, and `StreamChunk` types still come from smoltalk — they represent the message/response format and are used throughout the runtime for serialization, interrupts, and threads. Only the config type is Agency-owned.

### 2. LLM Client Interface

```typescript
type LLMClient = {
  text(config: PromptConfig): Promise<Result<PromptResult>>
  textStream(config: PromptConfig): AsyncGenerator<StreamChunk>
}
```

**Streaming vs non-streaming:** Currently `prompt.ts` calls `smoltalk.text()` with a `stream` flag — one function with overloads. The `LLMClient` interface splits this into two explicit methods (`text` and `textStream`) to avoid overload ambiguity. `prompt.ts` branches on the stream flag and calls the appropriate method. The `(smoltalk.text as Function)` type cast in prompt.ts is removed as part of Phase 1.

**Error contract for streaming:** `textStream` returns a bare `AsyncGenerator<StreamChunk>`. Errors are signaled as `StreamChunk` items with `type: "error"`, not thrown exceptions. Alternative clients must follow this convention — `handleStreamingResponse` in `streaming.ts` relies on it.

### 3. Default Smoltalk Client

A thin wrapper that converts `PromptConfig` to `SmolPromptConfig` and delegates to smoltalk:

```typescript
class SmoltalkClient implements LLMClient {
  text(config: PromptConfig): Promise<Result<PromptResult>> {
    const smolConfig = this.toSmolConfig(config);
    return smoltalk.text(smolConfig);
  }
  textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    const smolConfig = this.toSmolConfig(config);
    return smoltalk.textStream(smolConfig);
  }
  private toSmolConfig(config: PromptConfig): SmolPromptConfig {
    // Map PromptConfig fields to SmolPromptConfig fields
    // Pass metadata fields through as extra config
  }
}
```

Created automatically. Zero-config backward compatibility — if a user never calls `setLLMClient`, everything works exactly as before.

### 4. RuntimeContext Integration

`RuntimeContext` gets a new `llmClient: LLMClient` field, defaulting to the smoltalk wrapper. `runPrompt` in `prompt.ts` builds a `PromptConfig` from the prompt, messages, tools, and user-provided options, then calls `ctx.llmClient.text()` / `ctx.llmClient.textStream()`.

Everything else in `prompt.ts` stays the same — tool call loop, message construction, interrupt handling, token tracking. The client only handles the actual LLM request/response.

`createExecutionContext` must explicitly copy `llmClient` since it manually copies each property.

### 5. Simple Reference Client

A minimal `LLMClient` class that hits the OpenAI API directly using `fetch` — no additional packages. Serves as a reference implementation for client authors, a test target for the abstraction, and a lightweight alternative to smoltalk.

```typescript
class SimpleOpenAIClient implements LLMClient {
  // ...private helpers: buildRequestBody, extractToolCalls, extractUsage
}
```

Lives in `lib/runtime/` alongside the interface definition. Reads `OPENAI_API_KEY` from `process.env`.

Key properties:
- **`text`:** Makes a `fetch` call to `https://api.openai.com/v1/chat/completions`. Parses the response into a `PromptResult`.
- **`textStream`:** Falls back to calling `text` and yields a single `"done"` chunk. No actual streaming.
- **Model:** Uses `config.model` if provided, otherwise defaults to `"gpt-4o-mini"`.
- **Structured output:** Passes `response_format` with the Zod schema's JSON schema representation when `responseFormat` is provided.

This client intentionally does not support every feature smoltalk supports. It is a minimal working implementation.

### 6. `setLLMClient` Builtin Function

A new builtin function available in Agency code:

```
import { MyClient } from "my-client-package"

const client = MyClient({ apiKey: "sk-..." })
setLLMClient(client)

node main() {
  const result = llm("Hello!")
  print(result)
}
```

`setLLMClient` must be called at the top level (before any node runs). It sets `__globalCtx.llmClient = client`.

Applies globally — all `llm()` calls in all nodes use the set client.

### 7. Implementation Phases

**Phase 1: Define the interface and refactor `prompt.ts`**
- Define `PromptConfig` and `LLMClient` types in `lib/runtime/`
- Create default `SmoltalkClient` wrapper with `PromptConfig` → `SmolPromptConfig` conversion
- Add `llmClient` field to `RuntimeContext` (constructor + `createExecutionContext`)
- Change `prompt.ts` to build a `PromptConfig` and use `ctx.llmClient` instead of `smoltalk` directly
- Zero user-facing behavior change

**Phase 2: Simple reference client**
- Implement `SimpleOpenAIClient` class using `fetch`
- Add tests that use the simple client to verify the abstraction works end-to-end

**Phase 3: Add `setLLMClient` builtin**
- Add `setLLMClient` as a builtin function (similar to `mcp`)
- Generated code wires it to set `__globalCtx.llmClient`
- Users can now swap in alternative clients

### 8. What Doesn't Change

- **Parser** — no new syntax
- **Message format** — still smoltalk `Message`/`MessageJSON` types for serialization
- **Tool calling** — still handled by `prompt.ts`
- **Streaming callbacks** — still handled by `prompt.ts`
- **Token tracking** — still extracted from `PromptResult`
- **Generated code for `llm()` calls** — still calls `runPrompt`
- **Interrupts, checkpoints, message threads** — untouched
- **CLI optimizer** — `optimizerIO.ts` calls `smoltalk.textSync()` directly. This is CLI tooling, not user-facing runtime code, and is intentionally excluded from the abstraction
