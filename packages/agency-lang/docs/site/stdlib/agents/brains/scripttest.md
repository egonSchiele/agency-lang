---
name: "scripttest"
description: "A trial brain: the minimal brain, plus a tool that runs a short Agency program in place of a node or shell script."
---

# scripttest

A brain of the Agency agent. It is the minimal brain with one more tool,
  `runAgency`, the Agency docs tools, and a system message that tells the
  model to write a quick check as an Agency program instead of `node -e`
  or a shell script.

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

### scripttestBrain

```ts
scripttestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the minimal brain, plus a tool that runs a short
  Agency program in place of a node or shell script, and the Agency docs
  tools.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the brain's own |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/scripttest.agency#L78))
