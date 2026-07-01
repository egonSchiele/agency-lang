---
name: "thread"
---

# thread

Current-thread message history, cost/token accounting, and
guards, plus cross-thread context sharing: `listThreads()` enumerates
every thread in the current run (active + closed), `getThread(id,
offset, limit)` reads a slice of a thread's messages. The registry is
built on the public `agency.threads.*` primitives — the same surface
you'd reach for to build your own variants (tag-threads, thread-diff,
etc.) in user space.

  ```ts
  import { listThreads, getThread } from "std::thread"

  // Inspect the run's other threads:
  const info = listThreads()

  // Read a slice of a prior thread's messages:
  const lines = getThread("t1", 0, 20)
  ```

`label` is set at `thread {}` create time (template-level intent set
via `thread(label: "...") { ... }`); `summary` is per-instance and
generated lazily on first `listThreads()` call against a closed
thread. Both fields live directly on the underlying `MessageThread`
so the registry is per-run and survives interrupt-resume via the
existing checkpoint serialization.

The eager-summarize flag (`thread(summarize: true) { ... }`) is
parsed and forwarded to the `onThreadEnd` hook payload as
`eagerSummarize: true`. A global TS-side `onThreadEnd` hook
registered in `lib/stdlib/threads.ts` consumes the payload and
triggers a one-shot LLM summarize at close time, stashing the
result on the underlying `MessageThread`. Threads that did NOT opt
in eagerly fall back to the lazy summarize path in `summaryFor()`
below, which runs on the first `listThreads()` call against a
closed thread.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L70))

### Attachment

```ts
export type Attachment =
  | { type: "image"; source: AttachmentSource }
  | { type: "file"; source: AttachmentSource; filename: string
  | null }
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L75))

### ModelCost

```ts
export type ModelCost = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L178))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L201))

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L281))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L286))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L79))

### userMessage

```ts
userMessage(msg: string | (string | Attachment)[])
```

Add a user message to the current thread's message history. Accepts a
  plain string, or an array mixing text strings and image()/file()
  attachments. Use this when you want to seed the conversation with prior
  user context that wasn't actually typed by the user this turn.

  @param msg - The user message content: a string, or an array of strings and attachments.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string \| (string \| Attachment)[]` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L90))

### image

```ts
image(source: string, mimeType: string, base64: boolean): Attachment
```

Build an image attachment for a multimodal llm() call or userMessage().
  `source` is a local path, an http(s) URL, or a data: URI. Pass base64: true
  to treat `source` as raw base64 data (a mimeType is then required).
  smoltalk reads/fetches and MIME-infers the source at send time.

  @param source - Path, http(s) URL, data: URI, or raw base64 (with base64: true)
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| mimeType | `string` | "" |
| base64 | `boolean` | false |

**Returns:** [Attachment](#attachment)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L102))

### file

```ts
file(source: string, filename: string, mimeType: string, base64: boolean): Attachment
```

Build a file (e.g. PDF) attachment for a multimodal llm() call or
  userMessage(). `source` is a local path, an http(s) URL, or a data: URI.
  Pass base64: true to treat `source` as raw base64 data (mimeType required).
  `filename` defaults to the source's basename.

  @param source - Path, http(s) URL, data: URI, or raw base64 (with base64: true)
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L120))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L140))

### getCost

```ts
getCost(): number
```

Get the cumulative cost (USD, floating point) of all LLM calls
  contributing to the current execution branch.

  Inside a fork/race branch, this returns the parent's accumulated
  cost plus the cost incurred so far inside this branch. After all
  branches join, the parent sees the sum of its own cost plus every
  branch's cost (race losers included — their LLM calls really
  happened and cost real money).

  To measure a specific section, capture getCost() before and after:
  const before = getCost()
  // ... do work ...
  const sectionCost = getCost() - before

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L151))

### getTokens

```ts
getTokens(): number
```

Get the cumulative token count for the current execution branch.
  Same per-branch semantics as getCost().

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L170))

### getModelCosts

```ts
getModelCosts(): ModelCost[]
```

Get a per-model breakdown of cumulative LLM usage, one entry per
  model that has been called, sorted by cost descending.

  Unlike getCost()/getTokens() (which read the per-branch accumulator),
  this reads the process-wide totals across every branch — including
  subagents and tool calls that run on a different model. Useful for a
  cost summary that attributes spend per model.

  Each entry has `model` (the model name), `inputTokens`,
  `outputTokens`, and `cost` (USD).

**Returns:** `ModelCost[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L185))

### guard

```ts
guard(cost: number | null, time: number | null, block: () => any): Result
```

Run a block under a cost limit, a time limit, or both. The block
  aborts as soon as either limit is exceeded; whichever fires first
  wins. At least one of `cost` or `time` must be supplied.

  On success, returns `success(blockReturnValue)`. The block's local
  variables are scoped to the block — only the block's return value
  is observable from the caller. Use isFailure(result) to branch on
  the trip; inspect `result.error.type` to distinguish:
  - "guardFailure" — cumulative LLM cost exceeded `cost`. Read
  `result.error.maxCost` and `result.error.actualCost`.
  - "timeoutFailure" — compute time inside the block exceeded
  `time`. Read `result.error.maxTime` and `result.error.actualTime`
  (milliseconds).

  Time semantics are compute-time: wall clock only ticks while a
  Runner is actively executing inside the guarded scope. Time spent
  paused on an interrupt (e.g. waiting for user input) does NOT count
  against the budget; on resume the timer is re-armed with the
  remaining budget.

  Nested guards are independent: an inner trip does not trip an outer
  guard. Fork/race branches: cost guards are cloned per branch (each
  branch independently tracks cost-since-push); time guards are NOT
  cloned — the parent's timer is the single source of truth and the
  abort cascade propagates to every branch.

  `thread { ... }` and `subthread { ... }` isolate message history
  but NOT cost or abort plumbing. A guard wrapping a thread block
  sees every LLM call inside it.

  Limitations: tool calls whose body is a JS function (rather than
  Agency code) cannot be aborted mid-execution — the JS function runs
  to completion in the background and its result is discarded. Memory
  layer LLM calls (memory.text / memory.embed) currently bypass cost
  guards. Cost deltas from inside a fork only propagate to an outer
  cost guard at fork completion, not mid-flight.

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

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cost | `number \| null` | null |
| time | `number \| null` | null |
| block | `() => any` | null |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L213))

### listThreads

```ts
listThreads(lazySummarize: boolean): Result
```

Return every thread in the current run, including the active one.

  Summary generation: threads opened with `thread(summarize: true)`
  are summarized eagerly when they close (see the global onThreadEnd
  hook in `lib/stdlib/threads.ts`), so their summary is already
  cached by the time `listThreads()` runs. Threads that did NOT opt
  in eagerly trigger exactly one LLM round-trip the first time
  `listThreads()` is called on them (the "lazy" path). Active
  threads are skipped on both paths so the in-flight conversation
  is not summarized mid-stream. The computed summary is stashed on
  the underlying `MessageThread` so subsequent calls read it back
  without re-prompting.

  Pass `lazySummarize: false` to skip the on-demand LLM round-trip
  entirely. Threads without a cached summary fall back to their
  label (or `""` if no label is set), so the call stays free even
  when no eager summary is available. Useful in tests and in
  performance-sensitive surfaces where you'd rather see "no summary
  yet" than pay for one synchronously.

  Returns a `Result` — success holds `ThreadInfo[]`, failure holds
  the error (e.g. called outside an Agency frame). See
  [error handling](https://agency-lang.com/guide/error-handling).

  @param lazySummarize - When true (default), generate summaries
                         on-demand for any thread that doesn't have
                         one cached. When false, fall back to the
                         label (or `""`).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| lazySummarize | `boolean` | true |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L337))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L409))

### getThread

```ts
getThread(id: string, offset: number, limit: number): Result
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L419))
