# threads

## Types

### ThreadMessage

```ts
export type ThreadMessage = {
  role: string;
  content: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L32))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L37))

## Functions

### summarize

```ts
summarize(messages: ThreadMessage[]): string
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| messages | `ThreadMessage[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L50))

### summaryFor

```ts
summaryFor(id: string, messages: ThreadMessage[] | null): string | null
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| messages | `ThreadMessage[] \| null` | null |

**Returns:** `string | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L65))

### listThreads

```ts
listThreads(): ThreadInfo[]
```

Return every thread in the current run, including the active one.

  Lazy summary generation: a thread that doesn't yet have a cached
  summary triggers exactly one LLM round-trip the first time
  `listThreads()` is called on it. Active threads are skipped so the
  in-flight conversation is not summarized mid-stream.

  Eager summarization (one summary call per `thread {}` close instead
  of all-at-once on first `listThreads()`) is opt-in:
  `thread(summarize: true) { ... }`.

**Returns:** `ThreadInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L87))

### currentThreadId

```ts
currentThreadId(): string
```

Slug-form id of the active thread (e.g. "t3"), or `""` outside any
  runtime frame. Useful with `thread(continue: id)` when you want to
  capture a thread's id at the moment it was active so you can
  resume it later.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L126))

### getThread

```ts
getThread(id: string, offset: number, limit: number): ThreadMessage[]
```

Read a slice of a thread's messages. Returns `[]` for an unknown id.

  Pagination: `offset` is 0-indexed; `limit` defaults to 50. Pass
  larger explicit values for full-thread reads.

  @param id - Thread slug (e.g. "t1") from `listThreads()`
  @param offset - 0-indexed start of the message slice
  @param limit - Maximum number of messages to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| offset | `number` | 0 |
| limit | `number` | 50 |

**Returns:** `ThreadMessage[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/threads.agency#L136))
