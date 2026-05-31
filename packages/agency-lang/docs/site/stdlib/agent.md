# agent

## Types

### Todo

```ts
type Todo = {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L4))

### AgentSpec

```ts
export type AgentSpec = {
  systemPrompt: string;
  tools: any[];
  memory?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L39))

### RouterConfig

```ts
export type RouterConfig = {
  start: string;
  agents: Record<string, AgentSpec>;
  maxHops: number;
  context?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L45))

## Functions

### todoWrite

```ts
todoWrite(todos: Todo[]): Todo[]
```

Replace the current todo list. Each todo has an id, text, and status (one of 'pending', 'in_progress', 'completed'). Use this to track multi-step work as you go: mark a todo 'in_progress' before starting it and 'completed' when done. Returns the new list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| todos | `Todo[]` |  |

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L12))

### todoList

```ts
todoList(): Todo[]
```

Return the current todo list.

**Returns:** `Todo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L20))

### question

```ts
question(prompt: string): string
```

Ask the user a question and wait for their reply. Unlike input(), this raises an interrupt so the host (CLI, web UI, etc.) can present the prompt in its own way; the host resolves the interrupt with the answer string.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |

**Returns:** `string`

**Throws:** `std::question`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L27))

### handoff

```ts
handoff(category: string, reason: string, validCategories: string[]): string
```

Re-route the user's current message to a different specialist.
  After you call this, your turn closes and the original message
  is re-routed to the chosen specialist. Anything you say after
  `handoff()` is discarded — return immediately.

  Bias toward staying: most follow-ups are continuations of the
  current topic. Only call this when the message clearly needs
  a different specialist's tools.

  @param category - The specialist to re-route to
  @param reason - Brief explanation (recorded for debugging)
  @param validCategories - PFA-bound by `route()` — do not set manually

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| reason | `string` |  |
| validCategories | `string[]` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L63))

### consumeHandoff

```ts
consumeHandoff(): string
```

Read and clear the pending handoff target. Returns "" when no
  handoff was requested. Used internally by `route()`; exposed for
  tests + advanced users writing custom dispatch loops.

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L90))

### runOneTurn

```ts
runOneTurn(category: string, userMsg: string, config: RouterConfig, allowHandoff: boolean): string
```

Single iteration of route()'s hop loop. Owns the thread block,
  memory scoping, first-entry system-message seeding, and tool-array
  assembly. Returns the LLM's reply (string).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| category | `string` |  |
| userMsg | `string` |  |
| config | [RouterConfig](#routerconfig) |  |
| allowHandoff | `boolean` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L101))

### route

```ts
route(config: RouterConfig, userMsg: string): string
```

Run one user turn through a multi-specialist agent. Owns the hop
  loop, handoff signal, and force-answer fallback. The router
  injects a `handoff(category, reason)` tool into each specialist's
  toolset so the LLM can re-route the message when it's out of scope.
  When `maxHops` is reached, the handoff tool is stripped from the
  last call so the LLM is forced to answer.

  @param config - Start category, per-category agent specs, max hops, optional context string
  @param userMsg - The user's input message for this turn

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | [RouterConfig](#routerconfig) |  |
| userMsg | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/agent.agency#L137))
