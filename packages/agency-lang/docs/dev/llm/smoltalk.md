# Smoltalk

## Overview

[Smoltalk](https://www.npmjs.com/package/smoltalk) is the external LLM client library that Agency depends on for all LLM interactions. It provides a unified API for structured output requests across providers, and it handles messages, tool calls, and streaming. Agency never calls LLM APIs directly, so all LLM communication goes through smoltalk.

## How Agency uses smoltalk

### Making LLM requests

Agency does not call `smoltalk.text()` from its prompt loop. It goes through an interface, `LLMClient` (`lib/runtime/llmClient.ts`), and smoltalk sits behind the default implementation, `SmoltalkClient`:

```typescript
async text(config: PromptConfig): Promise<Result<PromptResult>> {
  const result = await smoltalk.text({ ...toSmolConfig(config), stream: false });
  if (!result.success || isEmptyPromptResult(result.value)) {
    rejectIfAborted(config.abortSignal);
  }
  return result;
}
```

`smoltalk.text()` returns either a `Promise<Result<PromptResult>>` (normal mode) or an `AsyncGenerator<StreamChunk>` (streaming mode). `SmoltalkClient.textStream()` wraps the streaming form.

The interface exists so a run can swap the client: `DeterministicClient` for tests, a local-model client, a hosted client. `LLMClient` also declares optional `embed`, `image`, `transcribe`, `speak`, and `normalizeError` methods. `PromptConfig` is Agency's own request shape; `toSmolConfig()` translates it into smoltalk's `SmolConfig`.

Cancellation is worth knowing about. The `LLMClient` contract is that an aborted call REJECTS with the branch's abort reason. Smoltalk instead resolves with `failure("Request was aborted")`, or with a success carrying no content. `SmoltalkClient` detects both shapes against its own signal and calls `rejectIfAborted` to convert them.

### Message construction

Smoltalk provides factory functions for creating typed messages:

- `smoltalk.userMessage(content)` — creates a user message
- `smoltalk.assistantMessage(content, { toolCalls })` — creates an assistant response
- `smoltalk.toolMessage(result, metadata)` — creates a tool result message

The runtime calls these throughout to build conversation histories. `lib/runtime/prompt.ts` is the heaviest user; `lib/runtime/threadRepair.ts` and `lib/runtime/intrinsicTools.ts` also synthesize messages.

### Message serialization

Messages can be serialized to JSON via `message.toJSON()` and deserialized via `smoltalk.messageFromJSON(json)`. This is critical for:
- **Message threads** — `MessageThread` (`lib/runtime/state/messageThread.ts`) stores messages and needs to serialize/deserialize them
- **Interrupts** — when execution pauses, the in-flight message history is saved as `MessageJSON[]` in the interrupt state

### Token tracking

Smoltalk provides `TokenUsage` and `CostEstimate` types for tracking LLM costs. Agency stores cumulative token stats in the `GlobalStore` under the `__internal` module and updates them after each LLM call via `updateTokenStats()` in `lib/runtime/utils.ts`.

## Key types from smoltalk

| Type | Used for |
|------|----------|
| `Message` | In-memory message objects |
| `MessageJSON` | Serialized messages (for state persistence) |
| `ToolCallJSON` | Tool call data (function name, arguments) |
| `UserContentInput` | Multimodal user content parts |
| `PromptResult` | LLM response (output text, tool calls, usage) |
| `Result<T>` | Wrapper for success/error results |
| `StreamChunk` | Streaming response chunks |
| `SmolConfig` | Client configuration (model, API keys, etc.) |
| `ModelName` | Model identifier (e.g., `"gpt-4o-mini"`) |
| `TokenUsage` | Input/output/cached token counts |
| `CostEstimate` | Dollar cost estimates |
| `EmbedResult` / `ImageGenResult` | Embedding and image-generation responses |

## Where smoltalk is used

- **`lib/runtime/llmClient.ts`** — the only place `smoltalk.text()` is called
- **`lib/runtime/prompt.ts`** — the tool loop and message construction
- **`lib/runtime/streaming.ts`** / **`lib/runtime/llmDispatch.ts`** — stream chunk and result handling
- **`lib/runtime/state/messageThread.ts`** — message storage and serialization
- **`lib/runtime/interrupts.ts`** — message/tool call data in interrupt state
- **`lib/runtime/hooks.ts`** — callback type definitions reference smoltalk types
- **`lib/runtime/types.ts`** — `TokenUsage` and `CostEstimate` for token tracking
- **`lib/runtime/providerModules.ts`** — registers extra providers via smoltalk's `registerProvider`
- **`lib/runtime/invocationUsage.ts`** — per-invocation cost and token accounting
- **`lib/statelogClient.ts`** — `ModelName` for logging
- **`lib/index.ts`** — re-exports the whole library as the `smoltalk` namespace

## Configuration

`AgencyConfig.client` configures the smoltalk defaults (see [config.md](../runtime/config.md)). The compiler bakes them into the generated module, and `RuntimeContext` holds them as `smoltalkDefaults`, a `Partial<SmolConfig>`. `RuntimeContext` merges them under every per-call config. The settings include `defaultModel`, `defaultProvider`, `logLevel`, and per-provider API keys.

## More docs
- https://github.com/egonSchiele/smoltalk
- https://raw.githubusercontent.com/egonSchiele/smoltalk/refs/heads/main/README.md