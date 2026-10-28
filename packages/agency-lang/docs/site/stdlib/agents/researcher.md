---
name: "researcher"
description: "Answers a question from web and Wikipedia sources and synthesizes"
---

# researcher

a cited answer, retrying until every claim is grounded.

  The grounding loop is this agent's own contract: a grounded, cited answer
  is what it produces. Checking that answer against a wider task is the
  caller's job, via reviewAgent.

  Two rules of the loop live here and not in `revise` (`std::strategy`),
  which other agents use for other work. An empty answer is never
  reviewed: the model is asked once more, with no tools, to write its
  answer from what it read, and a second empty reply is a failure naming
  the cause. And a rejected answer is fixed, not redone: the next attempt
  gets the answer and the findings, patches the gaps in a subthread under
  a small round cap, and uses a fact the review already gives with its
  source instead of looking it up again. See
  docs/dev/agents/research-loop.md.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L363))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the researcher's tools: the encyclopedia and fetch tools that need
  no key, a local file read for material the caller points at, and whichever
  search providers the environment has a key for.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L53))

### researcherAgent

```ts
@guarded(cost: maxCost, time: maxTime, keepDraft: keepDraft)
researcherAgent(
  task: string,
  context: string = "",
  maxAttempts: number = 3,
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
  cited answer, retrying while a review finds ungrounded claims.

  @param task - The research question
  @param context - Extra material folded into the prompt, or ""
  @param history - The conversation before the question, oldest first, so
    the question is read in its context; [] for none
  @param maxAttempts - Attempts before returning: one research pass, then
    fix passes that patch the review's findings
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
| maxAttempts | `number` | 3 |
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L297))
