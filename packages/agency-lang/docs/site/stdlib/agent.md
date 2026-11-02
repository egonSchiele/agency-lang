---
name: "agent"
description: "Ask the user questions and track an agent's todo list."
---

# agent

Give `question` to an LLM when it needs information only the user can
provide. Its interrupt lets a terminal, an application, or a handler supply
the reply. Use `todoWrite` to set a plan and `todoUpdate` to track progress.

```ts
import { todoWrite, todoUpdate } from "std::agent"

todoWrite([{ id: "review", text: "Review the draft", status: "pending" }])
todoUpdate("review", "completed")
```

## Effects

### std::question

```ts
effect std::question {
  prompt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L24))

## Functions

### todoAdd

```ts
todoAdd(todo: Todo): Todo[]
```

Add a new todo to the list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todo | `Todo` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L28))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L36))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L52))

### todoList

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L60))

### question

```ts
question(prompt: string): string
```

Ask the user for information needed to continue and wait for their reply.
  Use it for facts only the user can provide, after checking available sources.

Use this for user input in terminal, hosted, or embedded runs.
A handler can answer with `approve("reply")`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agent.agency#L69))
