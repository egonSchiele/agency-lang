---
name: "threads"
---

# threads

Cross-thread context sharing: `listThreads()` enumerates
every thread in the current run (active + closed), `getThread(id,
offset, limit)` reads a slice of a thread's messages. The registry is
built on the public `agency.threads.*` primitives — the same surface
you'd reach for to build your own variants (tag-threads, thread-diff,
etc.) in user space.

  ```ts
  import { listThreads, getThread } from "std::threads"

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

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L43))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L48))

## Functions

### summarize

```ts
summarize(messages: ThreadMessage[]): string
```

One-shot LLM summarization used by the lazy summarize path.
  Wrapped in a `thread {}` block so the summarizer prompt runs on
  an isolated message history and doesn't pollute the agent's main
  conversation. Uses structured output so the returned text comes
  back on a known field instead of free-form completion text.

  @param messages - The thread's messages to summarize

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages | `ThreadMessage[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L62))

### summaryFor

```ts
summaryFor(id: string, existing: string | null, messages: ThreadMessage[]): string | null
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| existing | `string \| null` |  |
| messages | `ThreadMessage[]` |  |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L90))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L99))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L171))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/threads.agency#L181))
