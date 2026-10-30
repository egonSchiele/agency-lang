---
name: "researcher"
description: "Answers a question from web and Wikipedia sources and returns a"
---

# researcher

cited answer.

  One research pass answers the question. When that pass ends with no
  answer, the model is asked once more, with no tools, to write its answer
  from what it read, and a second empty reply is a failure naming the
  cause. See docs/dev/agents/research-loop.md.

## Types

### ResearchEvalInput

What an eval hands the researcher: the question, and the conversation
  before it when the test has one. The shape the `evals/researcher` suite
  uses as its input.

```ts
/** What an eval hands the researcher: the question, and the conversation
  before it when the test has one. The shape the `evals/researcher` suite
  uses as its input. */
export type ResearchEvalInput = {
  task: string;
  history?: ThreadMessage[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L194))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the researcher's tools: the encyclopedia and fetch tools that need
  no key, a local file read for material the caller points at, and whichever
  search providers the environment has a key for.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L40))

### researcherAgent

```ts
@guarded(cost: maxCost, time: maxTime, keepDraft: keepDraft)
researcherAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  history: ThreadMessage[] = [],
  keepDraft: boolean = true,
): Result<string>
```

Answer a research question from web and Wikipedia sources and return a
  cited answer.

  @param task - The research question
  @param context - Extra material folded into the prompt, or ""
  @param history - The conversation before the question, oldest first, so
    the question is read in its context; [] for none
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
| task | `string` |  |
| context | `string` | "" |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |
| history | `ThreadMessage[]` | [] |
| keepDraft | `boolean` | true |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L133))
