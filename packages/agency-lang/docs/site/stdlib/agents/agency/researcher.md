---
name: "researcher"
description: "Answers questions about the Agency language itself from the"
---

# researcher

bundled documentation and from Agency source.

  Use it for questions whose answer lives in the language: syntax, types,
  control flow, the CLI, a diagnostic code, what a std:: module offers. For
  anything outside the language, use researcherAgent, which searches the web
  and Wikipedia. This agent has neither, on purpose: an answer about Agency
  assembled from the open web is usually an answer about some other language.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency researcher's tools: the bundled documentation, read-only
  access to the project, and the source inspectors it checks answers with.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/researcher.agency#L35))

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
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set
  @param keepDraft - When false, a run the budget cut short is a failure naming the budget, even when a draft was saved; the draft is in the failure's data as `draft`

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
