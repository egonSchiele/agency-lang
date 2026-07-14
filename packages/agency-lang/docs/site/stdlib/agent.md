---
name: "agent"
---

# agent

Helpers for building user-facing agents. This module offers two
independent tools:
- `question` asks the user something through an interrupt the host UI
can render, and
- `todoWrite` / `todoList` give the LLM a small todo
list to track multi-step work across turns.

## Types

## Effects

### std::question

```ts
effect std::question {
  prompt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L18))

## Functions

### todoAdd

```ts
todoAdd(todo: Todo): Todo[]
```

Add a new todo to the list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todo | [Todo](#todo) |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L22))

### todoUpdate

```ts
todoUpdate(id: string, status: "pending" | "in_progress" | "completed"): Todo[]
```

Update the status of a todo by id.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| id | `string` |  |
| status | `"pending" \| "in_progress" \| "completed"` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L30))

### todoWrite

```ts
todoWrite(todos: Todo[]): Todo[]
```

Replace the current todo list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todos | `Todo[]` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L46))

### todoList

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L54))

### question

```ts
question(prompt: string): string
```

Ask the user a question and wait for their reply.

  @param prompt - The question to show the user

Alternative to the `input` function, raises an interrupt instead,
so it can be used anywhere (eg a web server) instead of just the CLI.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L65))
