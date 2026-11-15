---
name: "explorer"
description: "The explorer of the Agency agent's coordinator brain. The agent"
---

# explorer

is `std::agents/explorer`; this file adds the reasoning model and the
  start event. It is a handoff: it continues the coordinator's
  conversation. The docstring is written for routing, not for the agent's
  own behaviour.

## Functions

### explorerAgent

```ts
explorerAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

Ask the explorer — a read-only researcher — to survey many files and
  return a synthesized answer. Use it only when the answer genuinely
  requires broad coverage:

  - "Summarize the Agency docs" / "give me a tour of module Y"
  - "How does Z work across the codebase?"

  Do NOT use this when a handful of targeted reads would answer the
  question — do those reads yourself with your own file tools. Do not
  send it to "map the structure": name the specific questions you need
  answered and the scope to cover ("all of docs/site/guide/", "the
  lib/parsers/ module").

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | the specific questions to answer and the scope to cover, with any context from the conversation the explorer needs |
| maxSeconds | `number \| null` | null | working-time cap in seconds, when the user gave a deadline; null for the default (15 minutes). |
| maxDollars | `number \| null` | null | spend cap in dollars, when the user gave one; null for the default ($20). |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/explorer.agency#L13))
