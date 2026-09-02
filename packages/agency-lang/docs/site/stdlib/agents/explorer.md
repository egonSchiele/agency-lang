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
  extraTools: any[] = [],
): Result<string>
```

Survey a codebase or a body of documentation and return an organized
  answer: a summary, a tour, or an explanation of how something works across
  many files. Reads widely before synthesizing, and cites what it read. It
  never changes anything.

  Called as a tool, the explorer continues your conversation: it sees
  everything said so far, and every file it reads stays in your history
  when it hands back. Say how much ground to cover; the reads are yours to
  keep afterwards, so scope the question.

  Called from code, it runs on your current thread like any function, and
  its system prompt, reads, and answer stay there. Wrap the call in
  `thread { ... }` for an isolated survey.

  @param question - The question, and the scope you want covered
  @param context - Extra material folded into the prompt, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
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
| extraTools | `any[]` | [] |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L149))
