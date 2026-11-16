---
name: "spawning"
description: "The minimal brain plus a tool that starts another agent as a separate process."
---

# spawning

A brain of the Agency agent for a message that holds several unrelated
  tasks. It is the minimal brain with one more tool, `startAgent`, which
  starts another agent on a task as a process of its own.

  A started agent is a separate program, started with
  [`spawn`](/guide/spawning-processes). It keeps running after this agent's reply, and after this agent has
  exited. Its reply does not come back here: it is saved in the process's
  output file. It is started with no approval rules, so every question it
  raises waits for a person, who answers it with `agency attach`.

## Functions

### startAgent

```ts
startAgent(
  settings: AgentSettings,
  task: string,
  name: string = "agent",
): Result<ProcessInfo>
```

Start another agent on one task as a separate process, and return at once with its process id, its name, and the file its output is saved to. The agent keeps running after you reply. Its result does not come back to you. It sees none of this conversation, so put everything it needs in the task.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](settings.md#agentsettings) |  |  |
| task | `string` |  | What the agent should do, with everything it needs to know |
| name | `string` | "agent" | A short name for the process, such as "review-pr-12" |

**Returns:** `Result<ProcessInfo>`

**Throws:** `std::spawn`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/spawning.agency#L45))

### spawningBrain

```ts
spawningBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the minimal brain's tool loop, plus a tool that
  starts another agent as a process of its own.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the brain's own |

**Returns:** `Result<string>`

**Throws:** `std::spawn`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/spawning.agency#L66))
