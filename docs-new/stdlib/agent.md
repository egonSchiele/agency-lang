# agent

[View source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency)

## Types

### Todo [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L0)

```ts
type Todo = {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed"
}
```

## Functions

### todoWrite [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L8)

```ts
todoWrite(todos: Todo[]): Todo[]
```

Replace the current todo list. Each todo has an id, text, and status (one of 'pending', 'in_progress', 'completed'). Use this to track multi-step work as you go: mark a todo 'in_progress' before starting it and 'completed' when done. Returns the new list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todos | Todo[] |  |

**Returns:** Todo[]

### todoList [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L16)

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** Todo[]

### question [source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L23)

```ts
question(prompt: string): string
```

Ask the user a question and wait for their reply. Unlike input(), this raises an interrupt so the host (CLI, web UI, etc.) can present the prompt in its own way; the host resolves the interrupt with the answer string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | string |  |

**Returns:** string
