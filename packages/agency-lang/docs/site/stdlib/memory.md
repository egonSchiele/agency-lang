---
name: "memory"
---

# memory

## Types

### MemoryConfig

```ts
export type MemoryConfig = {
  dir: string;
  model?: string;
  autoExtract?: { interval: number | undefined };
  compaction?: { trigger: "token" | "messages" | undefined; threshold: number | undefined };
  embeddings?: { model: string | undefined }
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L40))

## Functions

### isMemoryActive

```ts
isMemoryActive(): boolean
```

Return `true` iff there is an active memory frame on the current
  branch's stateStack — i.e. memory is on and `remember`/`recall` will
  reach a real store. Returns `false` when memory was never enabled,
  was explicitly turned off via `disableMemory()`, or the call is
  outside any runtime frame.

  Useful for branching in user code (`if (isMemoryActive()) { ... }`)
  and for integration tests that want to verify push/pop semantics
  without poking at the stateStack directly.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L48))

### setMemoryId

```ts
setMemoryId(id: string)
```

Set the memory scope for this agent run. Call this before other
  memory operations to scope reads and writes to a specific user,
  thread, or workspace. If never called, the scope defaults to "default".

  Memory must be enabled (either via `agency.json` or via
  `enableMemory(...)`) for this to do anything; without configuration
  this is a no-op.

  The id is orthogonal to which memory frame is active — it persists
  across `enableMemory` / `disableMemory` calls. If you want a fresh
  scope when switching stores, call `setMemoryId(...)` explicitly.

  @param id - A unique identifier for the memory scope (e.g. user ID)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L63))

### getMemoryId

```ts
getMemoryId(): string
```

Return the current memory scope id (the value last passed to
  `setMemoryId`, or "default" if it was never set or memory is not
  active). Reads the scope visible to the current execution branch.

  @returns The active memory scope id

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L82))

### enableMemory

```ts
enableMemory(config: MemoryConfig)
```

Turn memory on for the current execution branch using `config`.

  Pushes a new memory frame onto the active stateStack. Storage is
  shared process-wide by absolute directory, so multiple calls
  (across runs, forks, or modules) that point at the same dir share
  one underlying store.

  Same-dir push is a no-op — the common pattern of declaring
  `static const _ = enableMemory({...})` AND calling
  `enableMemory({...})` from `main()` is safe. Pushing a different
  dir stacks the new frame on top; pop with `disableMemory()` or
  use the block form `memory({...}) as { ... }` for lexical scoping.

  `config.dir` is resolved against `process.cwd()` (NOT the module
  dir, deliberately — mirrors how `agency.json`'s `memory.dir` is
  resolved so the same string in JSON and in code points at the same
  place). The directory is auto-created if missing.

  Per-fork: each fork branch has its own frame stack, so an
  `enableMemory` in one branch does not affect siblings.

  @param config - Memory configuration with `dir` required

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  |

**Throws:** `std::memory::enableMemory`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L93))

### disableMemory

```ts
disableMemory()
```

Pop the top memory frame from the current branch's stateStack.

  Frame-scoped: a `disableMemory()` inside a fork branch only
  affects that branch.

  WARNING: this pops whatever is on top, including the JSON-seeded
  bottom frame from `agency.json`. Library authors should not call
  this casually — they will shadow the caller's configured memory.
  Prefer the block form `memory({...}) as { ... }` for lexical
  scoping, which restores the previous frame on exit.

**Throws:** `std::memory::disableMemory`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L125))

### memory

```ts
memory(config: MemoryConfig, block: () => any): Result
```

Run `block` with `config` pushed as the active memory frame; pop
  the frame when the block returns (or fails). Mirrors the `guard()`
  pattern in `std::thread` so push/pop balancing flows through the
  same `try` expression — Agency has no `finally`, so the agency-side
  body uses `try block()` to capture the result and runs `pop` after.

  The pop only fires when the push actually happened: `_pushMemoryFrame`
  returns `false` if the new frame's dir matches the current top
  (dedup), and the matching no-pop preserves the caller's frame
  instead of unbalancing it. This fixes the prior `_memoryBlock`
  unbalanced-pop bug.

  Returns a `Result` (success holds the block's return value, failure
  holds an error from inside the block). Same convention as `guard()`.

  Example:
  const r = memory({ dir: "./mem-user-a" }) as {
  remember("alice's favorite color is blue")
  }

  @param config - Memory configuration with `dir` required
  @param block - The code to run with the frame active

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  |
| block | `() => any` | null |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L143))

### remember

```ts
remember(content: string)
```

Extract and store structured facts from the given text into the
  knowledge graph. Uses the LLM to identify entities, observations,
  and relations.

  The LLM call is wrapped in a thread block so memory's prompts run
  on an isolated message history and don't pollute the agent's main
  conversation. Cost and tokens still flow through the runtime's
  per-run accounting.

  @param content - Natural language text containing facts to remember

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Throws:** `std::memory::remember`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L176))

### recall

```ts
recall(query: string): string
```

Retrieve relevant facts from the knowledge graph as a formatted
  string. Combines structured lookup, embedding similarity, and
  LLM-powered retrieval; returns up to 10 entities ranked by match
  quality.

  Returns an empty string if memory is not configured or nothing matches.

  @param query - A natural language query describing what to recall

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Returns:** `string`

**Throws:** `std::memory::recall`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L202))

### forget

```ts
forget(query: string)
```

Soft-delete facts matching the query from the knowledge graph.
  Does not erase data — affected observations are marked with a
  validTo timestamp so the audit trail is preserved.

  The LLM call is wrapped in a thread block so memory's prompts run
  on an isolated message history and don't pollute the agent's main
  conversation.

  @param query - A natural language description of what to forget

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Throws:** `std::memory::forget`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L220))
