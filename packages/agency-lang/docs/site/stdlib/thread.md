---
name: "thread"
description: "Read and share LLM conversation history across a run: inspect the current thread's messages, cost, and tokens, and reach into other threads."
---

# thread

Read and share LLM conversation history across a run. Inspect the
current thread's messages, cost, and token usage, and reach into
other threads. `listThreads()` lists every thread in the run, active
and closed. `getThread(id, offset, limit)` reads a slice of one
thread's messages. These build on the public `agency.threads.*`
primitives, so you can compose your own variants in user code.

  ```ts
  import { listThreads, getThread } from "std::thread"

  // Inspect the run's other threads:
  const info = listThreads()

  // Read a slice of a prior thread's messages:
  const lines = getThread("t1", 0, 20)
  ```

## Types

### AttachmentSource

```ts
export type AttachmentSource =
  | { kind: "path"; path: string; mimeType: string
  | null }
  | { kind: "url"; url: string; mimeType: string
  | null }
  | { kind: "base64"; base64: string; mimeType: string }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L66))

### Attachment

```ts
export type Attachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L75))

### MessageAttachment

```ts
export type MessageAttachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
  | { type: "audio"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L84))

### ModelCost

```ts
export type ModelCost = {
  // "completion", "image", "embedding", "transcription", "speech" or "manual".
  kind: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  // Tokens read back from a cache entry, and tokens written to a new one.
  // Both are input-side and both are billed, at rates that differ from
  // `inputTokens` — so a total that leaves them out understates a cached
  // conversation by most of its size.
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L327))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L357))

### ReplyUsage

The tokens one reply consumed.

```ts
/** The tokens one reply consumed. */
export type ReplyUsage = {
  inputTokens: number;
  outputTokens: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L363))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L370))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L378))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L388))

### DecisionAnswer

One answer from a decision model. Check `type` before reading the rest:
  `if (answer.type == "choice") { answer.confidence }`.

```ts
/** One answer from a decision model. Check `type` before reading the rest:
  `if (answer.type == "choice") { answer.confidence }`. */
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L398))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L402))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L410))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L420))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L471))

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L494))

### ThreadInfo

```ts
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L499))

## Effects

### std::viewFile

```ts
@alwaysUnder(dir)
effect std::viewFile {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L231))

## Functions

### systemMessage

```ts
systemMessage(msg: string, label: string = "")
```

Add a system message to the current thread's message history.
  The message becomes part of the conversation context for subsequent
  llm() calls.

  @param msg - The system message content
  @param label - Optional debug label shown in statelog. Never sent to the model.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L89))

### userMessage

```ts
userMessage(msg: string | (string | MessageAttachment)[], label: string = "")
```

Add a user message to the current thread's message history. Use this
  to seed the conversation with prior user context that wasn't actually
  typed by the user this turn.

  @param msg - The user message content: a string, or an array mixing text strings and attachments.
  @param label - Optional debug label shown in statelog. Never sent to the model.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string \| (string \| MessageAttachment)[]` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L101))

### toolMessage

```ts
toolMessage(name: string, args: any, result: string, label: string = "")
```

Add a synthetic tool call and its result to the current thread, as if the
  model had made the call. Nothing runs; this only shapes the conversation the
  model reads on its next llm() call. Use it to make the model see work a
  scaffold did on its behalf. Call it at a clean point in the thread, not in
  the middle of a tool exchange still waiting for its result.

  @param name - The tool name the model will see it "called"
  @param args - The call arguments, as an object (serialized to JSON)
  @param result - The tool response content
  @param label - Optional debug tag shown in statelog. Never sent to the model.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| args | `any` |  |
| result | `string` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L113))

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

  @param source - A local path, an http(s) URL, a data: URI, or raw base64 (with base64: true)
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [Attachment](#attachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L134))

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

  @param source - A local path, an http(s) URL, a data: URI, or raw base64 (with base64: true)
  @param filename - Name shown to the model; defaults to the source basename.
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| filename | `string` | "" |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [Attachment](#attachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L150))

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
  ordinary messages (llm() / userMessage()), not attachToReply(). Currently
  supported only by models that accept audio input (e.g. gpt-audio-1.5).

  @param source - A local path, an http(s) URL, a data: URI, or raw base64 (with base64: true)
  @param filename - Name shown to the model; defaults to the source basename.
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| filename | `string` | "" |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [MessageAttachment](#messageattachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L167))

### attachToReply

```ts
attachToReply(attachment: Attachment)
```

Queue an attachment to be shown to the model after the current tool
  call completes. Only meaningful while running as a tool inside an
  llm() call: the attachment follows the tool's text result as a user
  message the model can see. Prefer path-based sources. Outside a tool
  invocation the attachment is dropped.

  @param attachment - The attachment to show the model

**Parameters:**

| Name | Type | Default |
|---|---|---|
| attachment | [Attachment](#attachment) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L186))

### endTurn

```ts
endTurn(scope: "llm" | "turn" = "llm")
```

End the current llm() call when this tool returns. The tool's return
  value becomes the answer and no follow-up LLM call is made. Only
  meaningful while running as a tool inside an llm() call; ignored
  elsewhere. The turn still goes on if the tool fails, if it ran beside
  other tool calls in the same response (a handoff is exempt, since it
  runs last), if the value is not a string (or does not match the
  caller's structured output type), or if a reply attachment is waiting.

  @param scope - "llm" ends the nearest enclosing llm() call. "turn" also ends every llm() call above it, up to the user's turn; use it only when the answer covers the whole request.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| scope | `"llm" \| "turn"` | "llm" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L199))

### handBack

```ts
handBack(message: string)
```

For a handoff function: the message that hands control back to the
  caller when this handoff returns, in place of the default
  "[name finished. <result>] Continue with the user's request." Ignored
  from an ordinary tool, when the handoff was rejected, when the message
  is empty, and when endTurn() ends the turn.

  @param message - The user-role message to put on the thread

**Parameters:**

| Name | Type | Default |
|---|---|---|
| message | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L214))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L233))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L273))

### getCost

```ts
getCost(): number
```

Return the cumulative cost in USD of all LLM calls contributing to the
  current execution branch.

Inside a fork/race branch this includes the parent's accumulated cost
 plus what this branch has spent so far. After branches join, the parent
 sees its own cost plus every branch's cost, including race losers.
 Their LLM calls really happened and cost real money. To measure a
 section, capture the value before and after and subtract.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L290))

### threadIsNew

```ts
threadIsNew(): boolean
```

True when the current message thread has no messages yet. Use it inside a
  thread block to send a system prompt only on the first entry.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L298))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L309))

### getTokens

```ts
getTokens(): number
```

Return the cumulative token count for the current execution branch.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L320))

### getModelCosts

```ts
getModelCosts(): ModelCost[]
```

Return what the run has spent since it began, one entry per kind
  and model (completions, images, embeddings, speech), sorted by cost
  descending. This is the same figure the host reads from the run result's
  usage entries.

Unlike the per-branch cost/token accessors, this covers every branch of
 the run, so it attributes spend per model even for
 subagents and tool calls that run on a different model.

**Returns:** `ModelCost[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L345))

### lastReply

```ts
lastReply(): Reply | null
```

Return what the model attached to its last reply on the current thread,
  or null if the thread has no reply yet. Use it right after an `llm()` call
  to read what the call's return value leaves out: a decision model's answers
  and probabilities, a reasoning model's thinking, and the reply's tokens and
  cost. For a decision model, `answers` holds one answer per question —
  `answers.answer` for a bare annotation, `answers.<field>` for an object one;
  check an answer's `type` before reading its fields.

  For a text model, `logprobs` holds one entry per generated token when the
  call asked for them with `llm(prompt, { logprobs: { top: 3 } })`. Only
  OpenAI models return them today; other providers leave the list empty. Each
  value is the natural log of the token's probability, so a value near 0
  means near certainty and -2.3 means about one chance in ten.

  ```ts
  type Dept = "billing" | "support" | "sales"
  const dept: Dept = llm("Which team should handle this?", { model: "jev-1.13" })
  const reply = lastReply()
  if (reply == null || reply.answers == null) {
    return dept
  }
  const answer = reply.answers.answer
  if (answer.type == "choice" && answer.confidence < 0.6) {
    // not sure enough: hand it to a person
  }
  ```

Reads the last assistant message on the active thread. A message a program
pushed with `assistantMessage()` counts as a reply here too — to the thread
it is an assistant message like any other — so this returns the most recent
one either way.

**Returns:** `Reply | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L436))

### listThreads

```ts
listThreads(lazySummarize: boolean = true): Result
```

Return every thread in the current run, including the active one, as a
  `Result`: success holds `ThreadInfo[]`, failure holds the error (e.g.
  called outside an Agency frame). Each closed thread carries a short
  summary; the active thread is not summarized.

  @param lazySummarize - When true (default), generate a summary
                         on-demand for any closed thread that lacks one.
                         When false, skip the LLM call and fall back to
                         the thread's label (or `""`).

Summary sourcing: threads opened with `thread(summarize: true)` are
 summarized eagerly when they close, so their summary is already cached
 here. Other closed threads are summarized on first read via one LLM
 round-trip, and the result is cached for later calls. The active thread
 is never summarized (the in-flight conversation should not be
 summarized mid-stream). A cached summary is reused without re-prompting.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| lazySummarize | `boolean` | true |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L571))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L624))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L632))

### getThread

```ts
getThread(id: string, offset: number = 0, limit: number = 50): Result
```

Read a slice of a thread's messages. Returns success holding `[]`
  for an unknown id; returns failure when called outside an Agency
  frame.

  Pagination: `offset` is 0-indexed; `limit` defaults to 50. Pass
  larger explicit values for full-thread reads.

  Returns a `Result` — success holds `ThreadMessage[]`. See
  [error handling](https://agency-lang.com/guide/error-handling).

  @param id - Thread slug (e.g. "t1") from `listThreads()`
  @param offset - 0-indexed start of the message slice
  @param limit - Maximum number of messages to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| offset | `number` | 0 |
| limit | `number` | 50 |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L642))
