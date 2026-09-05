---
name: "researcher"
description: "Answers a question from web and Wikipedia sources and synthesizes"
---

# researcher

a cited answer, retrying until every claim is grounded.

  The grounding loop is this agent's own contract: a grounded, cited answer
  is what it produces. Checking that answer against a wider task is the
  caller's job, via reviewAgent.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L221))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the researcher's tools: the encyclopedia and fetch tools that need
  no key, a local file read for material the caller points at, and whichever
  search providers the environment has a key for.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L42))

### researcherAgent

```ts
researcherAgent(
  task: string,
  context: string = "",
  maxAttempts: number = 2,
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  history: ThreadMessage[] = [],
): Result<string>
```

Answer a research question from web and Wikipedia sources and return a
  cited answer, retrying while a review finds ungrounded claims.

  @param task - The research question
  @param context - Extra material folded into the prompt, or ""
  @param history - The conversation before the question, oldest first, so
    the question is read in its context; [] for none
  @param maxAttempts - Answer-and-fix attempts before returning
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| maxAttempts | `number` | 2 |
| maxCost | `number` | $50.00 |
| maxTime | `number` | 30m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |
| history | `ThreadMessage[]` | [] |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L150))
