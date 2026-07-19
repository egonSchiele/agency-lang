---
name: "researcher"
description: "Answers a question from web and Wikipedia sources and synthesizes"
---

# researcher

a cited answer, retrying until every claim is grounded.

  The grounding loop is this agent's own contract: a grounded, cited answer
  is what it produces. Checking that answer against a wider task is the
  caller's job, via reviewAgent.

## Functions

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
): Result<string>
```

Answer a research question from web and Wikipedia sources and return a
  cited answer, retrying while a review finds ungrounded claims.

  @param task - The research question
  @param context - Extra material folded into the prompt, or ""
  @param maxAttempts - Answer-and-fix attempts before returning
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated

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

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L101))
