---
name: "coordinator"
description: "The coordinator brain of the Agency agent: one model that answers"
---

# coordinator

a turn itself or hands it to the code, research, oracle, explorer,
  review, writing, and rewrite subagents. An optional router model sends a
  plain message straight to the coder or the researcher. See
  docs/dev/agents/agent-brains.md.

## Functions

### coordinatorPromptOrFailure

```ts
coordinatorPromptOrFailure(prompt: Result<string>): Result<string>
```

Return the coordinator's prompt, or a failure that names the prompt file
  when it could not be read.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `Result<string>` |  | The result of reading the prompt file |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator.agency#L42))

### coordinatorTools

```ts
coordinatorTools(settings: AgentSettings, turnStart: any): any[]
```

Return the coordinator's own tools. The subagents get `settings` bound,
  so the model does not see it, and `elapsedTime` counts from `turnStart`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| turnStart | `any` |  | When the turn started |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator.agency#L55))

### coordinatorBrain

```ts
coordinatorBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message as the coordinator: route it, or answer it with one
  tool loop over the subagents, the file tools, and `extraTools`. Runs on
  the caller's thread.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the coordinator's own |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator.agency#L134))
