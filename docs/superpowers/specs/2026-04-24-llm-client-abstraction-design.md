# LLM Client Abstraction

## Problem

Agency currently hardcodes smoltalk as the LLM client. All `llm()` calls go through `smoltalk.text()` in `lib/runtime/prompt.ts`. Users who want to use a different LLM package (e.g., for a different provider, custom retry logic, or a proprietary API) have no way to swap it out.

## Solution

Define a minimal `LLMClient` interface using smoltalk's existing types. Users can provide an alternative client via a `setLLMClient()` builtin function. Smoltalk remains the default when no client is set.

## Design

### 1. LLM Client Interface

```typescript
type LLMClient = {
  text(config: SmolPromptConfig): Promise<Result<PromptResult>>
  textStream(config: SmolPromptConfig): AsyncGenerator<StreamChunk>
}
```

Uses smoltalk's types (`SmolPromptConfig`, `Result`, `PromptResult`, `StreamChunk`) as the shared format. Alternative clients import these types from smoltalk. This avoids defining Agency-owned types that mirror smoltalk — the message/tool/config format is essentially the OpenAI API format and unlikely to change.

**Trade-off:** `SmolPromptConfig` includes smoltalk-specific fields (`logLevel`, `provider`, `baseURL`, etc.) that alternative clients won't use. This is acceptable — clients can ignore fields they don't understand. The alternative (defining a minimal config subset) would lose configuration that `getSmoltalkConfig` merges in and would require mapping at the boundary.

Message construction (`smoltalk.userMessage()`, `assistantMessage()`, etc.) is NOT part of the interface — all clients use smoltalk's message format directly, so there's no reason for clients to provide their own message factories.

**Streaming vs non-streaming:** Currently `prompt.ts` calls `smoltalk.text()` with a `stream` flag — one function with overloads. The `LLMClient` interface splits this into two explicit methods (`text` and `textStream`) to avoid overload ambiguity. `prompt.ts` branches on the `stream` flag in the config and calls the appropriate method. The `(smoltalk.text as Function)` type cast in prompt.ts (currently used to bypass TypeScript overload resolution) is removed as part of Phase 1.

**Error contract for streaming:** `textStream` returns a bare `AsyncGenerator<StreamChunk>`. Errors are signaled as `StreamChunk` items with `type: "error"`, not thrown exceptions. Alternative clients must follow this convention — `handleStreamingResponse` in `streaming.ts` relies on it.

### 2. Default Smoltalk Client

A thin wrapper around the existing `smoltalk.*` calls:

```typescript
const defaultClient: LLMClient = {
  text: (config) => smoltalk.text(config),
  textStream: (config) => smoltalk.textStream(config),
}
```

Created automatically. Zero-config backward compatibility — if a user never calls `setLLMClient`, everything works exactly as before.

### 3. RuntimeContext Integration

`RuntimeContext` gets a new `llmClient: LLMClient` field, defaulting to the smoltalk wrapper. `runPrompt` in `prompt.ts` uses `ctx.llmClient.text()` / `ctx.llmClient.textStream()` instead of calling `smoltalk.text()` directly.

Everything else in `prompt.ts` stays the same — tool call loop, message construction, interrupt handling, token tracking, abort signals. The client only handles the actual LLM request/response.

### 4. Simple Reference Client

A minimal `LLMClient` implementation that hits the OpenAI API directly using `fetch` — no additional packages. Serves as a reference implementation for client authors, a test target for the abstraction, and a lightweight alternative to smoltalk for users who don't need its features.

Lives in `lib/runtime/` alongside the interface definition. Reads `OPENAI_API_KEY` from `process.env`.

Key properties:
- **`text`:** Makes a `fetch` call to `https://api.openai.com/v1/chat/completions` with the messages, tools, and response format from the config. Parses the response into a `PromptResult` (extracting `output`, `toolCalls`, `usage`, `cost`, `model`).
- **`textStream`:** Falls back to calling `text` and yields a single `"done"` chunk with the result. No actual streaming — keeps the implementation simple.
- **Model:** Uses `config.model` if provided, otherwise defaults to `"gpt-4o-mini"`.
- **Structured output:** Passes `response_format` with the Zod schema's JSON schema representation when `responseFormat` is provided in the config.

This client intentionally does not support every feature smoltalk supports (e.g., multiple providers, retries, caching). It is a minimal working implementation.

### 5. `setLLMClient` Builtin Function

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

### 6. Implementation Phases

**Phase 1: Define the interface and refactor `prompt.ts`**
- Define `LLMClient` type in `lib/runtime/`
- Create default smoltalk wrapper
- Add `llmClient` field to `RuntimeContext` (constructor + `createExecutionContext` — must explicitly copy the field since `createExecutionContext` manually copies each property)
- Change `prompt.ts` to use `ctx.llmClient` instead of `smoltalk` directly
- Zero user-facing behavior change

**Phase 2: Simple reference client**
- Implement the simple OpenAI-only client using `fetch`
- Add tests that use the simple client to verify the abstraction works end-to-end

**Phase 3: Add `setLLMClient` builtin**
- Add `setLLMClient` as a builtin function (similar to `checkpoint`, `restore`)
- Generated code wires it to set `__globalCtx.llmClient`
- Users can now swap in alternative clients

### 7. What Doesn't Change

- **Parser** — no new syntax
- **Message format** — still smoltalk types everywhere
- **Tool calling** — still handled by `prompt.ts`
- **Streaming callbacks** — still handled by `prompt.ts`
- **Token tracking** — still extracted from `PromptResult`
- **Generated code for `llm()` calls** — still calls `runPrompt`
- **Interrupts, checkpoints, message threads** — untouched
- **CLI optimizer** — `optimizerIO.ts` calls `smoltalk.textSync()` directly. This is CLI tooling, not user-facing runtime code, and is intentionally excluded from the abstraction
