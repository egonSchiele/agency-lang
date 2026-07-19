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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L105))

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
): Result<string>
```

Survey a codebase or a body of documentation and return an organized
  answer: a summary, a tour, or an explanation of how something works across
  many files. Reads widely before synthesizing, and cites what it read. It
  never changes anything.

  Pass a self-contained question and say how much ground to cover: this agent
  starts fresh and cannot see your conversation.

  @param question - The question, and the scope you want covered
  @param context - Extra material folded into the prompt, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

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

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L142))
