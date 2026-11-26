---
name: "learntest"
description: "A trial brain: the minimal brain, plus a tool that learns new"
---

# learntest

tools from Agency files on disk.

  A brain of the Agency agent. It is the minimal brain with one more tool
  and a few lines in its system message:

  - `learn` takes the path of an Agency file and the names of functions in
    it, and continues the turn with those functions as tools.
  - The lines say where the stdlib's Agency files are, and where the list
    of the ones worth learning is.

  The model finds a tool with its own `read` and `bash` tools, so the
  whole library costs a few lines of context until a tool is learned.

  The brain installs no handler. Reading the stdlib folder raises the
  ordinary read effects. `learn` raises `std::run` to inspect the file, and
  each call of a learned tool raises `std::run` and then the function's own
  effects. Learned tools belong to the run, so two calls of `agencyAgent`
  in one run share them.

## Functions

### learntestBrain

```ts
learntestBrain(
  prompt: string | (string | Attachment)[],
  settings: AgentSettings,
  extraTools: any[],
): Result<string>
```

Answer one message with the minimal brain, plus a tool that learns new
  tools from Agency files on disk.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string \| (string \| Attachment)[]` |  | The message, alone or followed by its attachments |
| settings | [AgentSettings](settings.md#agentsettings) |  | The call's settings |
| extraTools | `any[]` |  | Tools added to the brain's own |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/learntest.agency#L93))
