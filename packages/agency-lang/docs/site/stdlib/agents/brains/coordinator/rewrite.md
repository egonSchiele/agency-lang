---
name: "rewrite"
description: "The rewriter of the Agency agent's coordinator brain. The"
---

# rewrite

rewrite lives in `std::agents/writing/rewrite`. This wrapper only
  separates the prose from the request around it and adds the thread and
  memory an agent turn needs.

## Functions

### rewriteAgent

```ts
rewriteAgent(settings: AgentSettings, userMsg: string): string
```

Rewrite prose for readability and return the rewritten text. Runs the
  writing reviewer, then applies its findings; text the reviewer finds
  nothing wrong with comes back unchanged.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | the text to rewrite, and who it is for if known. |

**Returns:** `string`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/rewrite.agency#L27))
