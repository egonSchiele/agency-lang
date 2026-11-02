---
name: "explorer"
description: "Survey a codebase or documentation and return an organized answer."
---

# explorer

Use `explorerAgent` for documentation summaries, module tours, and explanations
that span many files. Its built-in tools read files and sources. Use
`oracleAgent` for a focused design judgment.

When called as an LLM tool, the explorer continues the caller's conversation.
From code, wrap the call in `thread { ... }` when you want an isolated survey.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the explorer's file, source, and web lookup tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L118))

### explorerAgent

```ts
@guarded(cost: maxCost, time: maxTime)
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

Survey a codebase or documentation and return an organized answer with sources.
  It never changes anything. It continues your conversation, and every file it
  reads stays in your history, so say how much ground to cover and scope the
  question tightly.

  @param question - The question and the scope to cover.
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.
  @param extraTools - Tools to add to the built-in lookup tools.

Called from code, this runs on the caller's thread like any function:
  the system prompt, the reads, and the answer stay there. Wrap the call
  in `thread { ... }` for an isolated survey.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/explorer.agency#L159))
