---
name: "researcher"
description: "Answer Agency-language questions using bundled documentation and source."
---

# researcher

Use this agent for syntax, types, control flow, CLI usage, diagnostics, and
standard-library APIs. Its built-in tools include the packaged docs and
source checks. It can also read the caller's project. For anything outside
the language, use `researcherAgent` from `std::agents/researcher`, which
searches the web and Wikipedia.

This agent has no web or Wikipedia tools, on purpose: an answer about
Agency assembled from the open web is usually an answer about some other
language.

As an LLM tool it continues the caller's conversation. From code, use a
`thread` block when you want an isolated answer.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return bundled documentation, project lookup, and Agency source-checking tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/researcher.agency#L42))

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
  extraTools: any[] = [],
  keepDraft: boolean = true,
): Result<string>
```

Answer a question about the Agency language from the bundled documentation,
  naming the page each claim came from.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| question | `string` |  | The question about Agency |
| context | `string` | "" | Extra material folded into the prompt, or "" |
| maxCost | `number` | $10.00 | Cost budget in USD. |
| maxTime | `number` | 10m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |
| keepDraft | `boolean` | true | False returns a budget failure even when a draft was saved. |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/researcher.agency#L68))
