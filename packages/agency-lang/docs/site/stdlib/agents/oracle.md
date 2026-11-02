---
name: "oracle"
description: "Get a focused second opinion on a plan, design, or persistent bug."
---

# oracle

The oracle reads the code and returns an analysis with a recommendation.
Its built-in tools inspect files and sources. Use `explorerAgent` for a
broad overview of a codebase or body of documentation.

When called as an LLM tool, the oracle continues the caller's conversation.
From code, wrap the call in `thread { ... }` when you want an isolated consult.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the oracle's file, Agency-source, and web lookup tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/oracle.agency#L88))

### oracleAgent

```ts
@guarded(cost: maxCost, time: maxTime)
oracleAgent(
  question: string,
  context: string = "",
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  extraTools: any[] = [],
): Result<string>
```

Read the code and give a focused second opinion on a plan, design, or bug.
  It never changes anything. It continues your conversation and sees
  everything said so far, so ask the question itself without restating the
  context.

Called from code, this runs on the caller's thread like any function:
  the system prompt, the reads, and the answer stay there. Wrap the call
  in `thread { ... }` for an isolated consult.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| question | `string` |  |  |
| context | `string` | "" |  |
| maxCost | `number` | $20.00 | Cost budget in USD. |
| maxTime | `number` | 15m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| extraTools | `any[]` | [] | Tools to add to the built-in lookup tools. |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/oracle.agency#L129))
