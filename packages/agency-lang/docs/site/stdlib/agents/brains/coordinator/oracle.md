---
name: "oracle"
description: "The oracle of the Agency agent's coordinator brain. The agent is"
---

# oracle

`std::agents/oracle`; this file adds the reasoning model and the start
  event. It is a handoff: it continues the coordinator's conversation. The
  docstring is written for routing, not for the agent's own behaviour.

## Functions

### oracleAgent

```ts
oracleAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

Ask the oracle — a read-only senior reviewer — for a second opinion
  before acting on something that would be expensive to get wrong. Call
  this when:

  - You're about to execute a non-trivial plan or diff and a flaw would
    be costly to undo
  - You're stuck on a bug after one or two failed attempts
  - You suspect existing code already solves the problem and a targeted
    look hasn't settled it

  Do NOT consult the oracle for conversational questions, opinions, or
  advice the user asked *you* for — answer those yourself from what you
  know and what you can read directly. A second opinion is worth its cost
  when you're about to act, not when you're about to reply.

  The oracle continues this conversation: it sees everything above, and
  its reading and reasoning stay in your history. Ask the question itself.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | the question |
| maxSeconds | `number \| null` | null | working-time cap in seconds, when the user gave a deadline; null for the default (15 minutes). |
| maxDollars | `number \| null` | null | spend cap in dollars, when the user gave one; null for the default ($20). |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/oracle.agency#L12))
