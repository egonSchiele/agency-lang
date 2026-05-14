# memory

## Functions

### setMemoryId

```ts
setMemoryId(id: string)
```

Set the memory scope for this agent run. Call this before other
  memory operations to scope reads and writes to a specific user,
  thread, or workspace. If never called, the scope defaults to "default".

  Memory must be enabled in agency.json for this to do anything; without
  configuration this is a no-op.

  @param id - A unique identifier for the memory scope (e.g. user ID)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L3))

### remember

```ts
remember(content: string)
```

Extract and store structured facts from the given text into the
  knowledge graph. Uses the LLM to identify entities, observations,
  and relations.

  @param content - Natural language text containing facts to remember

**Parameters:**

| Name | Type | Default |
|---|---|---|
| content | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L17))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L28))

### forget

```ts
forget(query: string)
```

Soft-delete facts matching the query from the knowledge graph.
  Does not erase data — affected observations are marked with a
  validTo timestamp so the audit trail is preserved.

  @param query - A natural language description of what to forget

**Parameters:**

| Name | Type | Default |
|---|---|---|
| query | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L42))
