# memory

## Types

### ExtractionResult

```ts
type ExtractionResult = {
  entities: { name: string; type: string; observations: string[] }[];
  relations: { from: string; to: string; type: string }[];
  expirations: { entityName: string; observationContent: string }[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L16))

### ForgetResult

```ts
type ForgetResult = {
  observations: { entityName: string; observationContent: string }[];
  relations: { fromName: string; toName: string; type: string }[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L22))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L34))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L48))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L70))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/memory.agency#L84))
