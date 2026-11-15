---
name: "minimal"
description: "A coding brain of the Agency agent with four tools and a short"
---

# minimal

prompt: one tool loop on the caller's conversation thread, with no
  subagents. For benchmarks and sandboxed runs, where every tool definition
  and prompt line is paid for on every request.

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/minimal.agency#L12))
