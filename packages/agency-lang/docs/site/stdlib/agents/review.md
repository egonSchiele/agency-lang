---
name: "review"
description: "Reviews a work product against a task and returns findings."
---

# review

The work is handed in as text; review reads it and judges it. It never
  touches the file system and never runs anything. To verify work on disk by
  measuring it, use verifierAgent instead. For Agency source specifically,
  agencyReviewAgent adds parse and typecheck findings.

## Functions

### reviewAgent

```ts
reviewAgent(
  work: string,
  task: string = "",
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
): Result<Feedback[]>
```

Review a work product against a task and return findings. error=true marks
  a way the work fails the task; error=false marks a satisfied point.

  @param work - The work product to review, as text
  @param task - What the work should accomplish
  @param context - Extra material for the judgment, or ""
  @param maxCost - Hard spend cap
  @param maxTime - Hard wall-clock cap
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param session - Session name to share a thread across calls, or "" for isolated

**Parameters:**

| Name | Type | Default |
|---|---|---|
| work | `string` |  |
| task | `string` | "" |
| context | `string` | "" |
| maxCost | `number` | $10.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/review.agency#L36))
