---
name: "oracle"
description: "A read-only senior reviewer: give it a hard problem and it reads"
---

# oracle

the code, thinks, and returns a direct verdict.

  Reach for it before acting, when a second opinion is worth more than
  another attempt: is this plan sound, does this already exist, why does this
  bug persist, what is wrong with this design. It reads and reasons; it never
  changes anything.

  Sharp and narrow, where explorerAgent is broad and descriptive. Ask the
  oracle to judge one thing; ask the explorer to survey many.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the oracle's tools. Read-only by design: it inspects, consults, and
  judges, and a reviewer that can edit is no longer a reviewer.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/oracle.agency#L85))

### oracleAgent

```ts
oracleAgent(
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

Ask for a second opinion on a hard problem: whether a plan is sound,
  whether the code already exists, why a bug persists, what is wrong with a
  design. Reads the code and returns a written analysis ending in a concrete
  recommendation. It never changes anything.

  By default this agent starts fresh and cannot see your conversation, so
  pass a self-contained question: include the plan, the relevant file paths,
  and what you have already tried. With `inheritContext` it runs in a
  subthread that sees the conversation so far, and the question only needs
  to say what you want answered.

  @param question - The question, with all the context needed to answer it
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/oracle.agency#L123))
