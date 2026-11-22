---
name: "simple"
description: "The simplest brain of the Agency agent: one LLM call with no"
---

# simple

tools of its own, on the caller's conversation thread.

## Functions

### simpleBrain

```ts
simpleBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with one LLM call. The call offers `extraTools` and
  nothing else.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | The tools the call offers |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/simple.agency#L11))
