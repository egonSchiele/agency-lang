---
name: "scripttest"
description: "A trial brain: the coordinator, plus a tool that runs a short Agency program in place of a node or shell script."
---

# scripttest

A brain of the Agency agent. It is the coordinator brain with one more
  tool, `runAgency`, the Agency docs tools, and a system message that tells
  the model to write a quick check as an Agency program instead of
  `node -e` or a shell script.

  A program run this way runs in a separate process, and every file read,
  file write, and command in it raises its own interrupt, which reaches the
  same handlers as the agent's other tools. So the user approves what the
  program does, and does not have to read the program first, as they would
  for `node -e '<script>'`.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L47))

### withScriptToolsForCoders

```ts
withScriptToolsForCoders(settings: AgentSettings): AgentSettings
```

The settings with the script tools added to the coders' tools. A turn
  the router sends to the coder never reaches the coordinator, and the
  coordinator hands script work to the coder, so the coders need the tools
  too. They see the rules already: they run on the same thread.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| settings | [AgentSettings](settings.md#agentsettings) |  |

**Returns:** [AgentSettings](settings.md#agentsettings)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L82))

### scripttestBrain

```ts
scripttestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the coordinator brain, plus a tool that runs a
  short Agency program in place of a node or shell script, and the Agency
  docs tools. The coders get them too.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the coordinator's own |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L89))
