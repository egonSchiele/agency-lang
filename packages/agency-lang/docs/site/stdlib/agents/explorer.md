---
name: "explorer"
description: "A read-only surveyor: give it a broad question about a codebase or"
---

# explorer

a body of docs and it reads widely, then synthesizes an organized answer.

  Reach for it when the answer needs many files read and pulled together:
  summarize these docs, tour this module, explain how this works across the
  codebase. It reads and organizes; it never changes anything.

  Broad and descriptive, where oracleAgent is sharp and narrow. Ask the
  explorer to survey many things; ask the oracle to judge one.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the explorer's tools. Read-only by design: it surveys and
  describes, and a surveyor that can edit is no longer a surveyor.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L113))

### explorerAgent

```ts
explorerAgent(
  question: string,
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  inheritContext: boolean = false,
): Result<string>
```

Survey a codebase or a body of documentation and return an organized
  answer: a summary, a tour, or an explanation of how something works across
  many files. Reads widely before synthesizing, and cites what it read. It
  never changes anything.

  By default this agent starts fresh and cannot see your conversation, so
  pass a self-contained question and say how much ground to cover. With
  `inheritContext` it runs in a subthread that sees the conversation so far,
  and the question only needs to name the questions and the scope.

  @param question - The question, and the scope you want covered
  @param context - Extra material folded into the prompt, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated. Ignored with `inheritContext`, since a subthread cannot be resumed
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set
  @param inheritContext - true to run in a subthread that inherits the caller's conversation so far; false for an isolated thread

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |
| inheritContext | `boolean` | false |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L151))
