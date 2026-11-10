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

Every message class takes an optional `metadata` record in its options and keeps it through `toJSON` and `fromJSON`:

```ts
const m = smoltalk.userMessage("hi", { metadata: { label: "seed" } });
smoltalk.messageFromJSON(JSON.parse(JSON.stringify(m))).metadata; // { label: "seed" }
```

smoltalk never reads `metadata` and never sends it to a provider. Agency keeps a message's debug label and its expiry there, through `lib/runtime/state/messageMetadata.ts` (see `docs/dev/runtime/expiring-messages.md`). A message without metadata serializes exactly as it would without the field.

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
| `StopReason` | Why a turn ended, normalized across providers |

### Why a turn ended

Every provider has its own word for running out of room: OpenAI says
`length`, Anthropic says `max_tokens`, Google says `MAX_TOKENS`, and the
OpenAI Responses API reports `max_output_tokens` inside an `incomplete`
status. Smoltalk maps them all to one `StopReason` of `"length"` on
`PromptResult.stopReason`, and keeps the provider's own word in
`rawStopReason`.

The field is spelled **`stopReason`**. `PromptResult` has no `finishReason`
and no `finish_reason`, so reading either of those silently gives you
`undefined` rather than an error. The statelog event calls its field
`finishReason`, which is why `prompt.ts` assigns `completion.stopReason` to
a key of a different name.

`runPrompt` carries the last round's stop reason to
`decideValidationRetry`, which uses it to tell two different failures
apart. A response that fails its schema because the model wrote the wrong
shape is the model's fault. A response that fails because it was cut off
mid-sentence is a budget problem, and the error says so and points at
`maxTokens`. That distinction matters most with a reasoning model, which
spends the same token budget thinking before it writes anything visible:
set `maxTokens` too low and the visible output is the empty string, which
otherwise surfaces as a baffling "expected object, received string".

### A 400 that is really a server hiccup

Anthropic sometimes answers a valid request with a 400 whose whole message
is `Invalid request data`, several seconds into generation. The same
request succeeds unchanged on the next try. It showed up on
`claude-opus-4-8` when a call combined structured output with tools: the
reviewer in `std::agents/review` hit it on four of eleven calls one day.

Since smoltalk 0.13.1 the Anthropic client maps that exact shape to
`SmolOverloadedError` and leaves the 400 on `status`. Agency's
`normalizeError` turns the class into `kind: "overloaded"`, and the retry
classifier checks the kind before the status, so the call is retried under
the normal policy (two retries with backoff) instead of failing at once. A
400 that names the field it rejected, such as `messages.1.content: ...`, is
still terminal.

## What an OpenRouter call records

OpenRouter passes each call on to one of several companies that host the model. Its reply names that company in a top-level `provider` field (for example `"OpenInference"`), and a reasoning model's thinking arrives as plain text in `message.reasoning`. smoltalk puts these on the result as `servedBy` and `reasoning`.

Both reach the log with no Agency code: `emitPromptCompletion` (`lib/runtime/promptEvents.ts`) copies the whole completion into the `promptCompletion` event. The logs viewer shows `servedBy` after the model name and `reasoning` above the reply.

`servedBy` does not go on the assistant message in the thread, so `lastReply()` does not return it: `buildReplyMessage` (`lib/runtime/utils.ts`) copies named fields only. The reasoning does, as a reasoning record. See the next section.

Two request options go the other way. `openRouter.provider` chooses which companies OpenRouter may use, for example `{ provider: { ignore: ["open-inference"] } }`; it can be set per call, with `setLlmOptions`, or as `client.openRouter` in `agency.json`. `rawAttributes` is spread into the request body for a field Agency has no option for, such as `top_k`. It is spread after the fields the client builds, so today it can also replace them, the model included (smoltalk#73).

## Reasoning sent back to the model

smoltalk turns each reply's reasoning into a reasoning record on `PromptResult.reasoningRecord`. The record names the provider and the model that produced it. When a later request is built, smoltalk sends each record back only to that same provider and model, in the field it arrived in: OpenRouter's `reasoning_details` or `reasoning`, a compatible server's `reasoning_content`, or the Responses API's encrypted reasoning items. Reasoning from another model is dropped, and it is never turned into visible text. Anthropic and Google thinking blocks are separate, and smoltalk sends them back by provider. smoltalk's `CLAUDE.md` has the full rules.

Agency keeps the record and smoltalk decides who receives it:

- **The reply message.** `buildReplyMessage` copies the record onto the reply as its `reasoning`. Like the other extras, it goes through `serializableExtra`, so a record that does not match `ReasoningRecordSchema` is dropped and cannot break a checkpoint.
- **A model switch.** A `/model` switch, preset slots, and the router leave records in place. The next request goes to the new model, and smoltalk leaves out the old model's records. If the conversation switches back, they are sent again.
- **The statelog.** `withMessageLabels` (`lib/runtime/promptEvents.ts`) leaves `reasoning` out of the thread it dumps on every `promptCompletion` event. Each call's reasoning is already on that call's own event, and dumping it with the whole thread on every call would grow a long run's log with the square of its reasoning.
- **A cut-off reply.** The cut-off retry (`docs/dev/agents/tool-loop-guards.md`) removes an empty reply that the output limit cut off, and its record goes with it. That reasoning stopped in the middle, so it should not go back.

Records stay on the thread for as long as the thread exists, so they ride in every checkpoint and saved agent session. On the SWE-bench run on GLM 5.3 Flash on 2026-11-10, before reasoning was sent back:

| Task | Model calls | Reasoning per call | Reasoning on the thread by the end |
|---|---|---|---|
| `astropy-13398` | 101 | 5,515 characters | about 557,000 characters |
| `sympy-13615` | 34 | 6,543 characters | about 222,000 characters |
| `pytest-10356` | 50 | 3,938 characters | about 197,000 characters |
| the other seven | 11 to 50 | 130 to 770 characters | under 40,000 characters |

These fit under hosted resume's 10 MB request limit (`MAX_BODY_BYTES` in `lib/serve/constants.ts`). The larger cost is input tokens: every request carries all of the same model's earlier reasoning, and the provider bills it. If that costs too much, the fallback is to keep only the newest records up to a size budget. Dropping a call's records when the call returns would not help the coding agent, whose whole task is one `llm()` call.

Two other places grow with the reasoning:

- **Traces.** A trace stores a whole checkpoint at every step (`docs/dev/runtime/trace.md`), so reasoning makes an `.agencytrace` file grow with the square of the run.
- **Compaction size.** Memory compaction's `estimateTokens` (`lib/runtime/memory/compaction.ts`) counts message content only. Once reasoning goes back to the model, the real request is larger than the estimate, so token-triggered compaction fires late. The agent's own compaction (`contextTokens` in `lib/stdlib/agentCompaction.ts`) starts from the usage the provider reported for the last reply, which counts the reasoning sent back, so it does not undercount.

**Open issue.** Anthropic's newest models and OpenAI's newer models use earlier reasoning only while the system prompt, the tools, and the messages before it are unchanged. After a change, the API drops the reasoning that follows it. Every provider's prompt cache also matches by exact prefix, so the same change makes everything after it a cache miss. Agency changes earlier history in several places:

- an expiring message is removed when its owner ends: the memory facts after a request, the round warning and the agent's global instructions after an `llm()` call, and a handoff's persona after the handoff;
- the tool list shrinks at the round cap, and removed tools leave it;
- memory compaction replaces older messages with a summary.

This is Linear ADI-294.

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