# Smoltalk

## Overview

[Smoltalk](https://www.npmjs.com/package/smoltalk) is the external LLM client library that Agency depends on for all LLM interactions. It provides a unified API for making structured output requests to OpenAI (and other providers), handling messages, tool calls, and streaming. Agency never calls LLM APIs directly — all LLM communication goes through smoltalk.

## How Agency uses smoltalk

### Making LLM requests

The primary integration point is `lib/runtime/prompt.ts`, which uses `smoltalk.text()` to make LLM requests:

```typescript
const result = await smoltalk.text({
  messages,
  tools,
  model,
  responseFormat,
  ...config,
});
```

`smoltalk.text()` returns either a `Promise<Result<PromptResult>>` (normal mode) or an `AsyncGenerator<StreamChunk>` (streaming mode).

### Message construction

Smoltalk provides factory functions for creating typed messages:

- `smoltalk.userMessage(content)` — creates a user message
- `smoltalk.assistantMessage(content, { toolCalls })` — creates an assistant response
- `smoltalk.toolMessage(result, metadata)` — creates a tool result message

These are used throughout the runtime to build conversation histories for LLM calls.

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
| `ToolMessageJSON` | Tool result metadata |
| `PromptResult` | LLM response (output text, tool calls, usage) |
| `Result<T>` | Wrapper for success/error results |
| `StreamChunk` | Streaming response chunks |
| `SmolPromptConfig` | Client configuration (model, API keys, etc.) |
| `ModelName` | Model identifier (e.g., `"gpt-4o-mini"`) |
| `TokenUsage` | Input/output/cached token counts |
| `CostEstimate` | Dollar cost estimates |
| `Strategy` / `StrategyJSON` | LLM strategy configuration |

## Where smoltalk is used

- **`lib/runtime/prompt.ts`** — core LLM call logic (`smoltalk.text()`, message construction)
- **`lib/runtime/state/messageThread.ts`** — message storage and serialization
- **`lib/runtime/state/stateStack.ts`** — types for serialized messages in state frames
- **`lib/runtime/interrupts.ts`** — message/tool call data in interrupt state
- **`lib/runtime/hooks.ts`** — callback type definitions reference smoltalk types
- **`lib/runtime/types.ts`** — `TokenUsage` and `CostEstimate` for token tracking
- **`lib/statelogClient.ts`** — `ModelName` for logging, `mergeResults` utility
- **`lib/index.ts`** — re-exports all of smoltalk's public API

## Configuration

Smoltalk client defaults are configured via `AgencyConfig.client` (see `docs/dev/config.md`) and stored on `RuntimeContext.smoltalkDefaults`. These defaults are merged into every `smoltalk.text()` call and include settings like `defaultModel`, `logLevel`, and API keys.

## More docs
- https://github.com/egonSchiele/smoltalk
- https://raw.githubusercontent.com/egonSchiele/smoltalk/refs/heads/main/README.md