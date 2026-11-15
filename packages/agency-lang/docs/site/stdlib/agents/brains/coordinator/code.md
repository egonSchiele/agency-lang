---
name: "code"
description: "The two coders of the Agency agent's coordinator brain. Both are"
---

# code

the stdlib coding agent (`std::agents/coding`), and both are handoffs:
  they continue the coordinator's conversation, so they see the request and
  whatever was read before it, and their edits and test output stay in its
  history.

  `codeAgent` is for every language but Agency. `agencyCodeAgent` adds the
  Agency prompt, the bundled docs tools, and the typecheck and test tools.
  The docstrings are written for routing, not for the agents' own
  behaviour. The coordinator binds `settings` with `.partial`, so the model
  never sees it.

  Relative paths resolve against the agent working directory
  (`setAgentCwd`/`getAgentCwd`).

## Constants

### agencyTutorial

```ts
export static const agencyTutorial = agentPrompt("agency-tutorial.md") catch ""
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L66))

### agencyCodeRules

```ts
export static const agencyCodeRules = agentPrompt("agency-code.md") catch ""
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L70))

### agencyCodePrompt

```ts
export static const agencyCodePrompt = """${agencyCodeRules}

<agency_tutorial>
${agencyTutorial}
</agency_tutorial>
"""
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L74))

## Functions

### agencyCli

```ts
agencyCli(args: string[]): any
```

Run the `agency` CLI with the given arguments. Returns an object with
  `stdout`, `stderr`, and `exitCode` (same shape as `bash`). `test`,
  `typecheck`, `ast`, `fmt`, and `run <file>` run in-process through the
  matching std::agency function (testFile, typecheckFile, parseAST,
  format, runFile), which you can also call directly. Other subcommands
  run the executable, which may not be installed. Arguments are passed
  directly (no shell interpretation).

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| args | `string[]` |  | CLI arguments, e.g. ["typecheck", "foo.agency"]. The first element is the subcommand. |

**Returns:** `any`

**Throws:** `std::read`, `std::guard`, `std::run`, `std::exec`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L28))

### codeAgent

```ts
codeAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

Hand a coding task to the coder: reading, writing, and editing code,
  running commands, builds, and tests. Use it for every language except
  Agency. It continues this conversation, so it sees everything above, and
  its edits and command output stay in your history.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | what needs doing. |
| maxSeconds | `number \| null` | null | working-time cap in seconds, when the user gave a deadline; null for the default (15 minutes). |
| maxDollars | `number \| null` | null | spend cap in dollars, when the user gave one; null for the default ($20). |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L117))

### agencyCodeAgent

```ts
agencyCodeAgent(
  settings: AgentSettings,
  userMsg: string,
  maxSeconds: number | null = null,
  maxDollars: number | null = null,
): Result<string>
```

Hand a task about Agency code to the Agency coder: writing, editing,
  typechecking, running, and testing `.agency` files, and questions about
  Agency syntax, the standard library, or the `agency` CLI. It has the
  Agency documentation and the typechecker, which the general coder does
  not. It continues this conversation, so it sees everything above, and
  its edits and command output stay in your history.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](../settings.md#agentsettings) |  |  |
| userMsg | `string` |  | what needs doing. |
| maxSeconds | `number \| null` | null | working-time cap in seconds, when the user gave a deadline; null for the default (15 minutes). |
| maxDollars | `number \| null` | null | spend cap in dollars, when the user gave one; null for the default ($20). |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/code.agency#L139))
