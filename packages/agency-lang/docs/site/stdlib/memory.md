---
name: "memory"
description: "Store facts across runs and recall them for an agent."
---

# memory

Enable memory for a directory, then use `remember` to extract facts and
`recall` to retrieve them. Memory configuration and scope changes stay
local to the current execution branch. The files persist across runs.

```ts
import { enableMemory, setMemoryId, remember, recall } from "std::memory"

node main() {
  enableMemory({ dir: "./mem" }) with approve
  setMemoryId("alice")
  remember("Alice's favorite color is blue") with approve
  const facts = recall("Alice's favorite color") with approve
  print(facts)
}
```

`remember` and `forget` do nothing while memory is disabled. `recall`
still raises its approval request and then returns an empty string.

## Types

### MemoryConfig

Configure the storage directory and optional memory model, extraction,
compaction, and embedding settings. The same settings can be supplied in
the `memory` block of `agency.json`. Relative `dir` paths use the working
directory, and `~` expands to the home directory.

```ts
/** Configure the storage directory and optional memory model, extraction,
compaction, and embedding settings. The same settings can be supplied in
the `memory` block of `agency.json`. Relative `dir` paths use the working
directory, and `~` expands to the home directory. */
export type MemoryConfig = {
  dir: string;
  model?: string;
  autoExtract?: { interval: number | null };
  compaction?: { trigger: "token" | "messages" | null; threshold: number | null };
  embeddings?: { model: string | null; provider: string | null }
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L59))

## Effects

### std::memory::enableMemory

```ts
effect std::memory::enableMemory {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L67))

### std::memory::disableMemory

```ts
effect std::memory::disableMemory {}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L68))

### std::memory::remember

```ts
effect std::memory::remember {
  contentLength: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L69))

### std::memory::recall

```ts
effect std::memory::recall {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L70))

### std::memory::forget

```ts
effect std::memory::forget {
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L71))

## Functions

### isMemoryActive

```ts
isMemoryActive(): boolean
```

Return whether memory is enabled for the current execution branch.

Check this before offering memory tools when memory may be disabled.

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L74))

### setMemoryId

```ts
setMemoryId(id: string)
```

Choose the user, conversation, or workspace scope for memory reads and writes.
  Enable memory before setting the scope.

A branch inherits its memory scope when it forks. Changing the scope
inside a branch leaves the parent's scope unchanged. Switching storage
directories keeps the scope, so set it again when you want a different one.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| id | `string` |  | Nonempty scope using letters, digits, dots, underscores, or hyphens, excluding `.` and `..`. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L84))

### getMemoryId

```ts
getMemoryId(): string
```

Return the memory scope, or "default" when no scope is set or memory is disabled.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L94))

### enableMemory

```ts
enableMemory(config: MemoryConfig)
```

Enable persistent memory for the current execution branch.
  Enabling the active directory again leaves its configuration unchanged.

Runs on the same host that use the same absolute directory share a store.
Enabling the active directory again leaves its configuration unchanged.
A different directory becomes the active configuration until it is popped
by `disableMemory`. Prefer the `memory` block form for temporary changes.
The storage directory is created when the store first writes data.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  | Supply a nonempty `dir` for the memory store. |

**Throws:** `std::memory::enableMemory`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L107))

### disableMemory

```ts
disableMemory()
```

Remove the current branch's most recently enabled memory configuration.
  An earlier configuration becomes active again if one remains.

This also removes a configuration loaded from `agency.json`.
Use the `memory` block form when the previous configuration must be restored.

**Throws:** `std::memory::disableMemory`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L123))

### memory

```ts
memory(config: MemoryConfig, block: () -> any = null): Result
```

Run a block with a temporary memory configuration, then restore the previous one.

```ts
const result = memory({ dir: "./temporary-memory" }) as {
  remember("Alice's favorite color is blue") with approve
}
```

The block returns a `Result` and restores the prior configuration after
normal completion or failure. This helper does not raise the enable-memory
approval, so the caller decides when to expose it.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| config | [MemoryConfig](#memoryconfig) |  | Supply a nonempty `dir` for the memory store. |
| block | `() => any` | null | Required block whose return value becomes the successful result. |

**Returns:** `Result`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L143))

### remember

```ts
remember(content: string)
```

Extract facts from text and persist them to memory.
  Does nothing while memory is disabled.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

**Throws:** `std::memory::remember`

**Needs:** `fileRead`, `fileWrite`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L159))

### recall

```ts
recall(query: string): string
```

Retrieve relevant stored facts as text for a question or topic.
  Return an empty string when memory is disabled or no facts match.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Returns:** `string`

**Throws:** `std::memory::recall`

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L188))

### forget

```ts
forget(query: string)
```

Stop recalling facts that match a natural-language description.
  This preserves stored history and does nothing while memory is disabled.

Forgetting expires matching observations and relations. The stored history
remains available for auditing.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

**Throws:** `std::memory::forget`

**Needs:** `fileRead`, `fileWrite`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/memory.agency#L203))
