---
name: "scripttest"
description: "A trial brain: the minimal brain, plus tools that write and run a short Agency program in place of a node or shell script."
---

# scripttest

A brain of the Agency agent. It is the minimal brain with two more
  tools and a short primer on Agency in its system message:

  - `runAgency` type-checks a program the model wrote and runs it.
  - `agencyScript` hands a task to the stdlib Agency writer, which writes
    and checks the program on a thread of its own, then runs it.

  The primer is about 2 KB. The writer's full tutorial stays on the
  writer's own thread, so it costs nothing on the calls where
  `agencyScript` is not used.

  A program run either way runs in a separate process, and every file
  read, file write, and command in it raises its own interrupt, which
  reaches the same handlers as the agent's other tools. So the user
  approves what the program does, and does not have to read the program
  first, as they would for `node -e '<script>'`.

## Functions

### runAgency

```ts
runAgency(source: string): Result
```

Type-check an Agency program and, when it has no errors, run it in a separate process and return the value its main node returns. Each file it reads or writes and each command it runs asks for approval as your other tools do. When the program has type errors, they are returned and nothing runs.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| source | `string` |  | A complete Agency program with `export node main()`, which returns the value you want to see |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L84))

### agencyScript

```ts
agencyScript(task: string): Result
```

Have a separate writer write a short Agency program for a task, run it, and return the program's result and its source. The writer writes Agency only, so do not ask it for Python or a shell script. Each file the program reads or writes and each command it runs asks for approval as your other tools do. The writer does not see this conversation, so the task must name every file and say what result to return.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | What the program should do and return, with every file path it needs |

**Returns:** `Result`

**Throws:** `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L110))

### scripttestBrain

```ts
scripttestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the minimal brain, plus tools that write and run
  a short Agency program in place of a node or shell script.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the brain's own |

**Returns:** `Result<string>`

**Throws:** `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L139))
