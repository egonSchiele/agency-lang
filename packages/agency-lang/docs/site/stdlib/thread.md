---
name: "thread"
description: "Manage LLM conversation history, attachments, and usage records."
---

# thread

Use message helpers to seed the active conversation, attachment builders
to provide images or files, and `lastReply` for reply metadata. The thread
inspection helpers can read other conversations in the same run.

```ts
import { systemMessage, currentThreadId, getThread } from "std::thread"

node main() {
  thread {
    systemMessage("Answer in one sentence.")
    const answer: string = llm("What causes rain?")
    const id = currentThreadId()
    print(getThread(id))
  }
}
```

`listThreads` may call an LLM to summarize closed threads. Pass
`lazySummarize: false` to inspect the registry without generating summaries.

## Types

### AttachmentSource

Attachment data can come from a path, a URL, or inline base64 with a MIME type.
Use `image`, `file`, and `audio` to construct these values.

```ts
/** Attachment data can come from a path, a URL, or inline base64 with a MIME type.
Use `image`, `file`, and `audio` to construct these values. */
export type AttachmentSource =
  | { kind: "path"; path: string; mimeType: string
  | null }
  | { kind: "url"; url: string; mimeType: string
  | null }
  | { kind: "base64"; base64: string; mimeType: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L60))

### Attachment

An image or file that can be sent in a message or queued by `attachToReply`.

```ts
/** An image or file that can be sent in a message or queued by `attachToReply`. */
export type Attachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L66))

### MessageAttachment

An image, file, or audio input for `llm` or `userMessage`.
Audio inputs require a model that supports audio.

```ts
/** An image, file, or audio input for `llm` or `userMessage`.
Audio inputs require a model that supports audio. */
export type MessageAttachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
  | { type: "audio"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L72))

### ModelCost

Usage for one kind and model across the run. `cost` is in USD.
Cache-read and cache-creation tokens are billed separately from ordinary
input tokens.

```ts
/** Usage for one kind and model across the run. `cost` is in USD.
Cache-read and cache-creation tokens are billed separately from ordinary
input tokens. */
export type ModelCost = {
  // "completion", "image", "embedding", "transcription", "speech" or "manual".
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L316))

### ThinkingBlock

One block of a reasoning model's visible thinking. `signature` is the
  provider's token for it, opaque to you.

```ts
/** One block of a reasoning model's visible thinking. `signature` is the
  provider's token for it, opaque to you. */
export type ThinkingBlock = {
  text: string;
  signature: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L339))

### ReplyUsage

The tokens one reply consumed.

```ts
/** The tokens one reply consumed. */
export type ReplyUsage = {
  inputTokens: number;
  outputTokens: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L345))

### NoulAnswer

A decision model's answer to a yes-or-no question. `noul` is the
  probability that the answer is yes, from 0 to 1.

```ts
/** A decision model's answer to a yes-or-no question. `noul` is the
  probability that the answer is yes, from 0 to 1. */
export type NoulAnswer = {
  type: "noul";
  noul: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L352))

### ChoiceAnswer

A decision model's answer to a pick-one question: the option picked,
  a provider-specific confidence score, and the probability of every option.
  Read `probabilities[choice]` for the selected option's probability.

```ts
/** A decision model's answer to a pick-one question: the option picked,
  a provider-specific confidence score, and the probability of every option.
  Read `probabilities[choice]` for the selected option's probability. */
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L360))

### ScoreAnswer

A decision model's answer on an ordered scale. `score` is the expected
  level and may be fractional; `legend` maps each level to its description.
  No Agency annotation produces a score question yet.

```ts
/** A decision model's answer on an ordered scale. `score` is the expected
  level and may be fractional; `legend` maps each level to its description.
  No Agency annotation produces a score question yet. */
export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L370))

### DecisionAnswer

One answer from a decision model. Check `type` before reading the rest:
  `if (answer.type == "choice") { answer.confidence }`.

```ts
/** One answer from a decision model. Check `type` before reading the rest:
  `if (answer.type == "choice") { answer.confidence }`. */
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L380))

### TokenAlternative

A token the model could have produced at a position, and the log of
  its probability.

```ts
/** A token the model could have produced at a position, and the log of
  its probability. */
export type TokenAlternative = {
  token: string;
  logprob: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L384))

### TokenLogprob

One generated token and the log of its probability. `top` lists the
  likeliest alternatives at that position, most likely first, when the
  call asked for them with `logprobs: { top: n }`; otherwise it is empty.

```ts
/** One generated token and the log of its probability. `top` lists the
  likeliest alternatives at that position, most likely first, when the
  call asked for them with `logprobs: { top: n }`; otherwise it is empty. */
export type TokenLogprob = {
  token: string;
  logprob: number;
  top: TokenAlternative[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L392))

### Reply

What the model attached to its last reply, beyond the text. `answers`
  is filled only by a decision model such as Jev: one answer per question,
  with a probability per option. `rawData` is whatever the provider put
  there, untyped. Null fields mean the reply carried nothing of that kind.

```ts
/** What the model attached to its last reply, beyond the text. `answers`
  is filled only by a decision model such as Jev: one answer per question,
  with a probability per option. `rawData` is whatever the provider put
  there, untyped. Null fields mean the reply carried nothing of that kind. */
export type Reply = {
  content: string;
  thinkingBlocks: ThinkingBlock[];
  logprobs: TokenLogprob[];
  usage?: ReplyUsage;
  cost?: number;
  answers?: Record<string, DecisionAnswer>;
  rawData: any
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L402))

### GuardFailureData

The structured detail on a tripped guard's failure. It is the failure's
  `data`; the failure's message is a sentence naming the guard and its
  budget.

```ts
/** The structured detail on a tripped guard's failure. It is the failure's
  `data`; the failure's message is a sentence naming the guard and its
  budget. */
export type GuardFailureData = {
  type: string;
  label?: string;
  maxCost?: number;
  actualCost?: number;
  maxTime?: number;
  actualTime?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L432))

### ThreadMessage

A thread message rendered as text, with placeholders for attachments.

```ts
/** A thread message rendered as text, with placeholders for attachments. */
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L450))

### ThreadInfo

A conversation registered in the current run, including its parent and activity state.

```ts
/** A conversation registered in the current run, including its parent and activity state. */
export type ThreadInfo = {
  id: string;
  label?: string;
  summary?: string;
  parentId?: string;
  threadType: string;
  messageCount: number;
  isActive: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L456))

## Effects

### std::viewFile

```ts
@alwaysUnder(dir)
effect std::viewFile {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L219))

## Functions

### systemMessage

```ts
systemMessage(
  msg: string,
  label: string = "",
  expires: "never" | "llmCall" = "never",
)
```

Add a system message to the current thread's message history.
  The message becomes part of the conversation context for subsequent
  llm() calls.

  @param msg - The system message content
  @param label - Optional debug label shown in statelog. Never sent to the model.
  @param expires - "never" (the default) keeps the message on the thread; "llmCall" removes it when the next llm() call on this thread returns.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |
| label | `string` | "" |
| expires | `"never" \| "llmCall"` | "never" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L77))

### userMessage

```ts
userMessage(
  msg: string | (string | MessageAttachment)[],
  label: string = "",
  expires: "never" | "llmCall" = "never",
)
```

Add a user message to the current thread's message history. Use this
  to seed the conversation with prior user context that wasn't actually
  typed by the user this turn.

  @param msg - The user message content: a string, or an array mixing text strings and attachments.
  @param label - Optional debug label shown in statelog. Never sent to the model.
  @param expires - "never" (the default) keeps the message on the thread; "llmCall" removes it when the next llm() call on this thread returns.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string \| (string \| MessageAttachment)[]` |  |
| label | `string` | "" |
| expires | `"never" \| "llmCall"` | "never" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L90))

### toolMessage

```ts
toolMessage(name: string, args: any, result: string, label: string = "")
```

Add a synthetic tool call and result to the active conversation without executing it.
  Call only when no tool exchange is waiting for its result.

  @param args - Call arguments to serialize as JSON.
  @param label - Debug tag in statelog that is not sent to the model.

Use this to record work done outside the model's tool loop. The model
sees the synthetic call and result on its next request.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| args | `any` |  |
| result | `string` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L109))

### image

```ts
image(
  source: string,
  mimeType: string = "",
  base64: boolean = false,
): Attachment
```

Build an image attachment for a multimodal llm() call. The source is
  read, fetched, and MIME-inferred when the message is sent.

  @param source - A local path, an http(s) URL, a base64-encoded data: URI, or raw base64 with base64: true.
  @param mimeType - Overrides inference and is required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [Attachment](#attachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L125))

### file

```ts
file(
  source: string,
  filename: string = "",
  mimeType: string = "",
  base64: boolean = false,
): Attachment
```

Build a file (e.g. PDF) attachment for a multimodal llm() call.

  @param source - A local path, an http(s) URL, a base64-encoded data: URI, or raw base64 with base64: true.
  @param filename - Name shown to the model, defaulting to the source basename.
  @param mimeType - Overrides inference and is required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| filename | `string` | "" |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [Attachment](#attachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L141))

### audio

```ts
audio(
  source: string,
  filename: string = "",
  mimeType: string = "",
  base64: boolean = false,
): MessageAttachment
```

Build an audio attachment for a multimodal llm() call. Only usable in
  `llm` and `userMessage` calls with a model that accepts audio input.
  It cannot be queued with `attachToReply`.

  @param source - A local path, an http(s) URL, a base64-encoded data: URI, or raw base64 with base64: true.
  @param filename - Name shown to the model, defaulting to the source basename.
  @param mimeType - Overrides inference and is required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| filename | `string` | "" |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [MessageAttachment](#messageattachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L158))

### attachToReply

```ts
attachToReply(attachment: Attachment)
```

Show an image or file to the model after the current tool call finishes.
  Use only inside a tool invoked by `llm`; calls elsewhere have no effect.

Queued images and files appear in a user message after the tool round.
Prefer path sources for generated files. The reply pipeline enforces model
modality, size, and attachment-count limits.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| attachment | [Attachment](#attachment) |  |

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L181))

### endTurn

```ts
endTurn(scope: "llm" | "turn" = "llm")
```

Use the current tool's return value as the LLM answer without a follow-up call.
  Call only inside an LLM tool invocation with a successful result matching
  the caller's requested output type and no queued reply attachments.

  @param scope - Use "turn" only when the answer covers the whole request and should end enclosing LLM calls too.

The tool's result must match the caller's output contract. Failed tools,
ordinary tools sharing a round, incompatible return values, and queued
attachments cause the LLM call to continue. A handoff can end the call after
other tools in its round, since it runs last. Code after `endTurn` still runs.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| scope | `"llm" \| "turn"` | "llm" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L193))

### handBack

```ts
handBack(message: string)
```

Set the message that returns control to the caller after a handoff.
  Call from inside a handoff function invoked as an LLM tool.

This replaces the default user-role message after a handoff returns.
An empty message, a rejected handoff, or a successful `endTurn` leaves the
custom message unused. Calls from ordinary tools have no effect.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L207))

### viewFile

```ts
viewFile(path: string): Result<string>
```

Show an image or PDF file to yourself. The file is attached to the
  message that follows this tool result. Only works when called as a
  tool inside an llm() call. Accepts .png, .jpg, .jpeg, .gif, .webp,
  and .pdf.

  @param path - Path to the image or PDF file

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<string>`

**Throws:** `std::viewFile`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L222))

### assistantMessage

```ts
assistantMessage(msg: string, label: string = "")
```

Add an assistant message to the current thread's message history.
  Use this to inject prior assistant turns when reconstructing a
  conversation programmatically.

  @param msg - The assistant message content
  @param label - Optional debug label shown in statelog. Never sent to the model.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L262))

### getCost

```ts
getCost(): number
```

Return cumulative usage cost in USD for the current execution branch.

A fork branch includes its parent's accumulated cost plus its own spend.
After joining, the parent includes every branch, including race losers.
Subtract values taken before and after a section to measure its cost.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L277))

### threadIsNew

```ts
threadIsNew(): boolean
```

True when the current message thread has no messages yet. Use it inside a
  thread block to send a system prompt only on the first entry.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L284))

### ensureSystemMessage

```ts
ensureSystemMessage(msg: string)
```

Push `msg` as a system message unless the active thread already holds it.

  @param msg - The system message

For an agent's persona. An agent called twice from code on one thread
  keeps one persona; a handoff, whose system messages are removed when it
  hands back, pushes the persona fresh on every dispatch.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L295))

### getTokens

```ts
getTokens(): number
```

Return the cumulative token count for the current execution branch.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L306))

### getModelCosts

```ts
getModelCosts(): ModelCost[]
```

Return total run usage by kind and model, sorted by cost from highest to lowest.

Unlike the per-branch cost/token accessors, this covers every branch of
  the run, so it attributes spend per model even for
  subagents and tool calls that run on a different model.

**Returns:** `ModelCost[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L330))

### lastReply

```ts
lastReply(): Reply | null
```

Return the last assistant reply and its metadata on the active thread,
  or null when there is no reply.

Call after `llm` to inspect decision answers, thinking, log probabilities,
and usage. `answers.answer` holds a bare decision answer; object annotations
use the corresponding field names. Check an answer's `type` before reading
its fields.

For text models, request token probabilities with `logprobs: { top: 3 }`.
Providers that do not return log probabilities leave `logprobs` empty.
Values are natural logarithms, so zero means probability one.
Messages added by `assistantMessage` also count as replies.

**Returns:** `Reply | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L421))

### listThreads

```ts
listThreads(lazySummarize: boolean = true): Result
```

List active and closed conversations in the current run.

  @param lazySummarize - False avoids LLM calls and uses cached summaries or labels for missing summaries.

Success holds a `ThreadInfo[]` list. Failure means thread inspection could not run.
Closed threads may already have summaries from `thread(summarize: true)`.
With lazy summarization enabled, missing summaries are generated and cached.
Active threads are left unsummarized. Disable lazy summarization to use a
cached summary, the label, or an empty string without another LLM call.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| lazySummarize | `boolean` | true |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L512))

### sessionThreadId

```ts
sessionThreadId(name: string): string
```

Slug-form id of the thread that `thread(session: name)` resumes (e.g.
  "t3"), or `""` when nothing has been opened under that name yet.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L559))

### currentThreadId

```ts
currentThreadId(): string
```

Return the active thread id, such as "t3", or "" outside a runtime frame.

Save this id before leaving a thread block when you want to reopen it
later with `thread(continue: id)`.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L569))

### getThread

```ts
getThread(id: string, offset: number = 0, limit: number = 50): Result
```

Read a slice of a conversation's messages, returning an empty list for an unknown id.

  @param id - Thread id from `listThreads` or `currentThreadId`.
  @param offset - Zero-based index of the first message to return.

Success holds a `ThreadMessage[]` slice. Tool calls and structured content
are rendered as text, and attachment payloads become placeholders.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| offset | `number` | 0 |
| limit | `number` | 50 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L578))
