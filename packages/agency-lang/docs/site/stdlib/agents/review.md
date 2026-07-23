---
name: "review"
description: "Reviews a work product against a task and returns findings."
---

# review

Review reads the work and looks things up. The verifier runs the work and
  measures it. This agent never touches the file system and never executes
  what it is reviewing, but it can consult the web to check a claim: whether
  an API is used correctly, whether a cited source says what the work says it
  does. For Agency source specifically, agencyReviewAgent adds parse and
  typecheck findings.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the reviewer's lookup tools. It reads and checks; it has no tools
  that change anything.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/review.agency#L30))

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
  extraTools: any[] = [],
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
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

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
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/review.agency#L70))
