---
name: "thread"
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L54))

### Attachment

```ts
export type Attachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L59))

### ModelCost

```ts
export type ModelCost = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L162))

### GuardFailureData

```ts
export type GuardFailureData = {
  type: string;
  maxCost?: number;
  actualCost?: number;
  maxTime?: number;
  actualTime?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L181))

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L253))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L258))

## Functions

### systemMessage

```ts
systemMessage(msg: string)
```

Add a system message to the current thread's message history.
  The message becomes part of the conversation context for subsequent
  llm() calls.

  @param msg - The system message content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L63))

### userMessage

```ts
userMessage(msg: string | (string | Attachment)[])
```

Add a user message to the current thread's message history. Use this
  to seed the conversation with prior user context that wasn't actually
  typed by the user this turn.

  @param msg - The user message content: a string, or an array mixing text strings and attachments.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string \| (string \| Attachment)[]` |  |

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L85))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L101))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L118))

### assistantMessage

```ts
assistantMessage(msg: string)
```

Add an assistant message to the current thread's message history.
  Use this to inject prior assistant turns when reconstructing a
  conversation programmatically.

  @param msg - The assistant message content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L131))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L147))

### getTokens

```ts
getTokens(): number
```

Return the cumulative token count for the current execution branch.

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L155))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L172))

### guard

```ts
guard(
  cost: number | null = null,
  time: number | null = null,
  block: () -> any = null,
): Result
```

Run a block under a cost limit, a time limit, or both, aborting the
  block as soon as either limit is exceeded. At least one of `cost` or
  `time` must be supplied.

  Returns a `Result`. On success it holds the block's return value. On a
  trip it holds a failure whose `error.type` is either "guardFailure"
  (cost exceeded, read `error.maxCost` and `error.actualCost`) or
  "timeoutFailure" (compute time exceeded, read `error.maxTime` and
  `error.actualTime`, in milliseconds).

  @param cost - Maximum cost in dollars (e.g. $2.00 or 2.00). null = no cost limit.
  @param time - Maximum compute time in milliseconds (e.g. 30s, 5m, or a raw number). null = no time limit.
  @param block - The work to run under the guard.

  Example:

  ```ts
  const result = guard(cost: $2.0, time: 30s) as {
    const a = llm("step 1")
    const b = llm("step 2")
    return a + b
  }
  if (isFailure(result)) {
    print("Guard tripped: " + result.error.type)
  } else {
    print(result.value)
  }
  ```

* Time semantics are compute-time: the clock only ticks while a Runner is
 * actively executing inside the guarded scope. Time spent paused on an
 * interrupt (e.g. waiting for user input) does not count. On resume the
 * timer is re-armed with the remaining budget.
 *
 * Nested guards are independent. An inner trip does not trip an outer
 * guard. Across fork/race branches, cost guards are cloned per branch, so
 * each tracks its own cost-since-push. The time guard is shared: the
 * parent's timer is the single source of truth, and its abort cascade
 * reaches every branch. `thread`/`subthread` isolate message history but
 * not cost or abort plumbing, so a guard sees every LLM call inside them.
 *
 * Limitations: a tool whose body is a JS function (not Agency code) cannot
 * be aborted mid-execution. It runs to completion in the background, and
 * its result is discarded. Memory-layer LLM calls currently bypass cost
 * guards. Cost from inside a fork only propagates to an outer cost guard at
 * fork completion, not mid-flight.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cost | `number \| null` | null |
| time | `number \| null` | null |
| block | `() => any` | null |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L212))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L330))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L383))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L393))
