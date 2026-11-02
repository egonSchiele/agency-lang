---
name: "researcher"
description: "Answer Agency-language questions using bundled documentation and source."
---

# researcher

Use this agent for syntax, types, control flow, CLI usage, diagnostics, and
standard-library APIs. Its built-in tools include the packaged docs and
source checks. It can also read the caller's project.

As an LLM tool it continues the caller's conversation. From code, use a
`thread` block when you want an isolated answer.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return bundled documentation, project lookup, and Agency source-checking tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/researcher.agency#L36))

### agencyResearcherAgent

```ts
@guarded(cost: maxCost, time: maxTime, keepDraft: keepDraft)
agencyResearcherAgent(
  question: string,
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  keepDraft: boolean = true,
): Result<string>
```

Answer a question about the Agency language from the bundled documentation,
  naming the page each claim came from.

  @param question - The question about Agency
  @param context - Extra material folded into the prompt, or ""
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override, ignored when model is empty.
  @param session - Reserved and currently unused, since this agent uses the active thread.
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set
  @param keepDraft - False returns a budget failure even when a draft was saved.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| question | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $10.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |
| keepDraft | `boolean` | true |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/researcher.agency#L62))
