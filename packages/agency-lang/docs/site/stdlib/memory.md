---
name: "memory"
---

# memory

Give an agent long-term memory. `remember` extracts facts from text
and saves them to a knowledge graph, and `recall` retrieves the
relevant ones later. Memory is off until you turn it on with
`enableMemory`, and it stays local to the current branch.

Memory reads and writes raise an approval interrupt, so call them
`with approve` (or your own policy) to let them through.

```ts
import { enableMemory, remember, recall } from "std::memory"

node main() {
  enableMemory({ dir: "./mem" }) with approve
  remember("Alice's favorite color is blue") with approve
  const facts: string = recall("What is Alice's favorite color?") with approve
  print(facts)
}
```

## Types

### MemoryConfig

```ts
export type MemoryConfig = {
  dir: string;
  model?: string;
  autoExtract?: { interval: number | null };
  compaction?: { trigger: "token" | "messages" | null; threshold: number | null };
  embeddings?: { model: string | null; provider: string | null }
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L62))

## Effects

### std::memory::enableMemory

```ts
effect std::memory::enableMemory {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L70))

### std::memory::disableMemory

```ts
effect std::memory::disableMemory {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L71))

### std::memory::remember

```ts
effect std::memory::remember {
  contentLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L72))

### std::memory::recall

```ts
effect std::memory::recall {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L73))

### std::memory::forget

```ts
effect std::memory::forget {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L74))

## Functions

### isMemoryActive

```ts
isMemoryActive(): boolean
```

Return `true` when memory is on for the current branch and reads and
  writes will reach a real store. Returns `false` when memory was never
  enabled, was turned off, or the call is outside any runtime frame.

Useful for branching in user code (`if (isMemoryActive()) { ... }`)
 *  and for tests that verify memory is on without inspecting internal
 *  state.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L79))

### setMemoryId

```ts
setMemoryId(id: string)
```

Set the memory scope for this agent run, so reads and writes target a
  specific user, thread, or workspace. Call before other memory
  operations. The scope defaults to "default" if never set. Memory must
  be enabled for this to have any effect.

  @param id - A unique identifier for the memory scope (e.g. user ID)

The id is independent of which memory configuration is active. It
 *  persists as memory is turned on and off. Re-set it explicitly when
 *  switching stores. Branch-scoped: a fork/race branch inherits the id
 *  active at fork time, and a change inside a branch stays local to that
 *  branch.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L93))

### getMemoryId

```ts
getMemoryId(): string
```

Return the current memory scope id, or "default" if it was never set
  or memory is not active.

  @returns The active memory scope id

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L105))

### enableMemory

```ts
enableMemory(config: MemoryConfig)
```

Turn memory on for the current execution branch using `config`. The
  directory in `config.dir` is created if missing. Enabling a directory
  that is already active is a no-op.

  @param config - Memory configuration with `dir` required

Storage is shared process-wide by absolute directory, so calls
 *  (across runs, forks, or modules) that point at the same dir share one
 *  store. Enabling the same dir again is a no-op, so declaring
 *  `static const _ = enableMemory({...})` AND calling it from `main()` is
 *  safe. Enabling a different dir stacks on top. Turn it off with
 *  `disableMemory()` or use the block form for lexical scoping.
 *
 *  `config.dir` is resolved against `process.cwd()`, not the module dir.
 *  This deliberately mirrors how `agency.json`'s `memory.dir` resolves, so
 *  the same string in JSON and in code points at the same place.
 *
 *  Branch-scoped: a fork/race branch inherits the config active at fork
 *  time, and enabling/disabling inside a branch stays local to that
 *  branch.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  |

**Throws:** `std::memory::enableMemory`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L129))

### disableMemory

```ts
disableMemory()
```

Turn off memory for the current branch by removing the most recently
  enabled memory configuration.

Removes whatever memory configuration is on top, including a bottom
 *  frame seeded from `agency.json`. Library authors should not call this
 *  casually. It shadows the caller's configured memory. Prefer the block
 *  form `memory({...}) as { ... }`, which restores the previous
 *  configuration on exit. Branch-scoped: a call inside a fork branch stays
 *  local to that branch.

**Throws:** `std::memory::disableMemory`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L150))

### memory

```ts
memory(config: MemoryConfig, block: () => any): Result
```

Run `block` with `config` as the active memory configuration, then
  restore the previous configuration when the block returns or fails.
  Returns a `Result`: success holds the block's return value, failure
  holds an error raised inside the block.

  Example:
  const r = memory({ dir: "./mem-user-a" }) as {
  remember("alice's favorite color is blue")
  }

  @param config - Memory configuration with `dir` required
  @param block - The code to run with the configuration active

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  |
| block | `() => any` | null |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L160))

### remember

```ts
remember(content: string)
```

Extract structured facts (entities, observations, and relations) from
  the given text and store them in the knowledge graph.

  @param content - Natural language text containing facts to remember

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Throws:** `std::memory::remember`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L183))

### recall

```ts
recall(query: string): string
```

Retrieve relevant facts from the knowledge graph as a formatted
  string. Combines structured lookup, embedding similarity, and
  LLM-powered retrieval. Returns up to 10 entities ranked by match
  quality.

  Returns an empty string if memory is not configured or nothing matches.

  @param query - A natural language query describing what to recall

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Returns:** `string`

**Throws:** `std::memory::recall`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L211))

### forget

```ts
forget(query: string)
```

Soft-delete facts matching the query from the knowledge graph. Data is
  not erased. Affected observations are marked with a validTo timestamp,
  preserving the audit trail.

  @param query - A natural language description of what to forget

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Throws:** `std::memory::forget`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L229))
