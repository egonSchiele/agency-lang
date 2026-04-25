# Custom LLM Clients

Agency uses [smoltalk](https://www.npmjs.com/package/smoltalk) as its default LLM client, but you can swap it out for any client that implements the `LLMClient` type.

## Using the built-in simple client

Agency ships with `SimpleOpenAIClient`, a lightweight client that hits the OpenAI API directly using `fetch` with no extra dependencies. To use it:

```
import { SimpleOpenAIClient } from "agency-lang/runtime"

const client = SimpleOpenAIClient()
setLLMClient(client)

node main() {
  const result = llm("Hello!")
  print(result)
}
```

`SimpleOpenAIClient` reads `OPENAI_API_KEY` from your environment by default. You can also pass options:

```
const client = SimpleOpenAIClient({ apiKey: "sk-...", model: "gpt-4o" })
```

The simple client does not support real streaming — `textStream` falls back to making a non-streaming call and yielding the result as a single chunk. It also does not calculate cost estimates.

## Building your own client

A custom LLM client is a class that implements the `LLMClient` type:

```typescript
import type { LLMClient, PromptConfig } from "agency-lang/runtime";
import type { PromptResult, StreamChunk } from "smoltalk";
import type { Result } from "smoltalk";

class MyClient implements LLMClient {
  async text(config: PromptConfig): Promise<Result<PromptResult>> {
    // Make your LLM call here
    // Return { success: true, value: promptResult } or { success: false, error: "message" }
  }

  async *textStream(config: PromptConfig): AsyncGenerator<StreamChunk> {
    // Yield StreamChunk objects as the response streams in
    // If you don't need streaming, fall back to text():
    const result = await this.text(config);
    if (result.success) {
      yield { type: "done", result: result.value } as StreamChunk;
    } else {
      yield { type: "error", error: result.error } as StreamChunk;
    }
  }
}
```

Then in your Agency code:

```
import { MyClient } from "./myClient.js"

const client = MyClient()
setLLMClient(client)

node main() {
  const result = llm("Hello!")
  print(result)
}
```

### PromptConfig

Your `text` and `textStream` methods receive a `PromptConfig` with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Conversation history (smoltalk Message objects) |
| `tools` | `ToolDefinition[]` | Available tools with name, description, and Zod schema |
| `model` | `string` | Model identifier |
| `apiKey` | `string` | API key |
| `maxTokens` | `number` | Max tokens to generate |
| `temperature` | `number` | Sampling temperature (0-2) |
| `responseFormat` | `ZodType` | Zod schema for structured output |
| `thinking` | `{ enabled, budgetTokens? }` | Extended thinking configuration |
| `reasoningEffort` | `"low" \| "medium" \| "high"` | Reasoning effort level |
| `provider` | `string` | Provider override |
| `abortSignal` | `AbortSignal` | Cancellation signal |
| `metadata` | `Record<string, any>` | Additional client-specific options |

All fields except `messages` are optional. Your client can ignore fields it doesn't support.

### Converting Zod schemas

`tools[].schema` and `responseFormat` are Zod objects. To convert them to JSON Schema for APIs that expect it (like OpenAI), use Zod's built-in conversion:

```typescript
const jsonSchema = config.responseFormat.toJSONSchema();
```

### Return types

`text()` must return a `Result<PromptResult>`:

```typescript
// Success
{ success: true, value: { output: "Hello!", toolCalls: [], usage: { ... }, model: "gpt-4o" } }

// Failure
{ success: false, error: "API error message" }
```

`PromptResult` fields:
- `output` — the model's text response (string)
- `toolCalls` — array of tool call objects with `id`, `name`, and `arguments`
- `usage` — token counts: `{ inputTokens, outputTokens, cachedInputTokens, totalTokens }`
- `cost` — cost estimate: `{ inputCost, outputCost, totalCost, currency }` (optional)
- `model` — the model that was used (optional)

### Streaming

`textStream()` must yield `StreamChunk` objects:

- `{ type: "text", text: "partial response..." }` — streamed text
- `{ type: "tool_call", toolCall: { id, name, arguments } }` — tool invocation
- `{ type: "done", result: promptResult }` — final result
- `{ type: "error", error: "message" }` — error

Errors must be signaled as chunks, not thrown exceptions. Agency's streaming handler (`handleStreamingResponse`) relies on this convention.

## How it works

`setLLMClient(client)` sets the client on the global runtime context. All subsequent `llm()` calls in all nodes use that client. If `setLLMClient` is never called, the default `SmoltalkClient` is used.

`setLLMClient` must be called at the top level of your Agency file, before any node runs. The client is not serialized — if execution resumes in a new process (e.g., from a checkpoint), the top-level code re-runs and re-sets the client.

## Source code

- `lib/runtime/llmClient.ts` — `LLMClient` type, `PromptConfig` type, `SmoltalkClient` default
- `lib/runtime/simpleOpenAIClient.ts` — `SimpleOpenAIClient` reference implementation
- `lib/runtime/prompt.ts` — where `ctx.llmClient` is called
