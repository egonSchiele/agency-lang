---
name: "minimal"
description: "A coding brain of the Agency agent with four tools and a short"
---

# minimal

prompt: one tool loop on the caller's conversation thread, with no
  subagents. For benchmarks and sandboxed runs, where every tool definition
  and prompt line is paid for on every request.

## Functions

### minimalOptions

```ts
minimalOptions(settings: AgentSettings, extraTools: any[]): any
```

Return the `llm` options of the minimal brain: the main model, the four
  coding tools followed by `extraTools`, and the spill limit.

A brain built on this one calls this for an `llm` call of its own, so
  the call gets the same model, tools, and spill limit as `minimalBrain`'s.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the four |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/minimal.agency#L15))

### minimalBrain

```ts
minimalBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with one tool loop over read, bash, edit, and write,
  plus `extraTools`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the four |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/minimal.agency#L30))
