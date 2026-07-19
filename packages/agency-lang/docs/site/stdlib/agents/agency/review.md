---
name: "review"
description: "Reviews Agency source code: parse findings, typecheck findings, and"
---

# review

an optional LLM judgment of whether the code accomplishes a task.

  Review reads; it never runs the code. To execute a program and judge its
  actual result, use agencyVerifierAgent instead.

## Functions

### reportFeedback

```ts
reportFeedback(report: TypeCheckReport): Feedback[]
```

Convert a typecheck report into findings: one error item per error, one
  advisory item per warning.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| report | [TypeCheckReport](../../agency.md#typecheckreport) |  |

**Returns:** `Feedback[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L17))

### agencyReviewAgent

```ts
agencyReviewAgent(
  source: string,
  task: string = "",
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
): Result<Feedback[]>
```

Review Agency source code and return findings. Always includes parse and
  typecheck findings. When a task is given, an LLM also judges whether the
  code accomplishes it.

  @param source - Agency source code to review
  @param task - What the code should do, or "" for static checks only
  @param context - Extra material for the judgment, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated

**Parameters:**

| Name | Type | Default |
|---|---|---|
| source | `string` |  |
| task | `string` | "" |
| context | `string` | "" |
| maxCost | `number` | $10.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L69))
