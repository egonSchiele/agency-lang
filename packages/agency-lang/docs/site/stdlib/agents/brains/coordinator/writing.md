---
name: "writing"
description: "The writing reviewer of the Agency agent's coordinator brain."
---

# writing

The review itself lives in `std::agents/writing/review`. That reviewer
  reads the files a message names and applies fixes only when asked, so
  all that is left here is the thread and memory an agent turn needs.

## Functions

### writingAgent

```ts
writingAgent(settings: AgentSettings, userMsg: string): string
```

Review prose for readability: passages a reader will misread, lose the
  thread in, or did not need. Reports findings by default; changes the
  files only when the message asks for the fixes to be applied.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | the text to review or the files holding it, who the text is for if known, and whether to apply the fixes. |

**Returns:** `string`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/writing.agency#L13))
