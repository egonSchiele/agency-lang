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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L53))

### Attachment

```ts
export type Attachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L58))

### ModelCost

```ts
export type ModelCost = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L164))

### GuardFailureData

```ts
export type GuardFailureData = {
  type: string;
  label?: string;
  maxCost?: number;
  actualCost?: number;
  maxTime?: number;
  actualTime?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L183))

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L206))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L211))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L62))

### userMessage

```ts
userMessage(msg: string | (string | Attachment)[], label: string = "")
```

Add a user message to the current thread's message history. Use this
  to seed the conversation with prior user context that wasn't actually
  typed by the user this turn.

  @param msg - The user message content: a string, or an array mixing text strings and attachments.
  @param label - Optional debug label shown in statelog. Never sent to the model.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string \| (string \| Attachment)[]` |  |
| label | `string` | "" |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L74))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L86))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L102))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L119))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L132))

### getCost

```ts
getCost(): number
```

Return the cumulative cost in USD of all LLM calls contributing to the
  current execution branch.

Inside a fork/race branch this includes the parent's accumulated cost
 *  plus what this branch has spent so far. After branches join, the parent
 *  sees its own cost plus every branch's cost, including race losers.
 *  Their LLM calls really happened and cost real money. To measure a
 *  section, capture the value before and after and subtract.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L149))

### getTokens

```ts
getTokens(): number
```

Return the cumulative token count for the current execution branch.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L157))

### getModelCosts

```ts
getModelCosts(): ModelCost[]
```

Return a per-model breakdown of cumulative LLM usage across the whole
  process, one entry per model that has been called, sorted by cost
  descending.

Unlike the per-branch cost/token accessors, this reads process-wide
 *  totals across every branch, so it attributes spend per model even for
 *  subagents and tool calls that run on a different model.

**Returns:** `ModelCost[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L174))

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
 *  summarized eagerly when they close, so their summary is already cached
 *  here. Other closed threads are summarized on first read via one LLM
 *  round-trip, and the result is cached for later calls. The active thread
 *  is never summarized (the in-flight conversation should not be
 *  summarized mid-stream). A cached summary is reused without re-prompting.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| lazySummarize | `boolean` | true |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L283))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L336))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L346))
