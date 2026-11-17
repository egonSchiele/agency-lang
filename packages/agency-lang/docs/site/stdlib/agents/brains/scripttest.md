---
name: "scripttest"
description: "A trial brain: the minimal brain, plus a subagent that writes and runs a short Agency program in place of a node or shell script."
---

# scripttest

A brain of the Agency agent. It is the minimal brain with one more tool,
  `agencyScript`, and a short system message that tells the model to use
  it instead of `node -e` or a shell script.

  `agencyScript` is a subagent. The stdlib Agency writer writes and checks
  the program on a thread of its own, and the program then runs in a
  separate process. The writer's tutorial and tools stay on its own
  thread, so they cost nothing on the calls where the tool is not used.

  Every file read, file write, and command in the program raises its own
  interrupt, which reaches the same handlers as the agent's other tools.
  So the user approves what the program does, and does not have to read
  the program first, as they would for `node -e '<script>'`.

## Functions

### agencyScript

```ts
agencyScript(task: string): Result
```

Write and run a short Agency program for a task, and return what the program returns. Each file it reads or writes and each command it runs asks for approval as your other tools do. The writer does not see this conversation, so the task must name every file and say what result to return.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What the program should do and return, with every file path it needs |

**Returns:** `Result`

**Throws:** `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L34))

### scripttestBrain

```ts
scripttestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the minimal brain, plus a subagent that writes
  and runs a short Agency program in place of a node or shell script.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the brain's own |

**Returns:** `Result<string>`

**Throws:** `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L57))
