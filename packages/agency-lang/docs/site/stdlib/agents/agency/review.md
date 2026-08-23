---
name: "review"
description: "Reviews Agency source code: parse findings, typecheck findings, and"
---

# review

an optional LLM judgment of whether the code accomplishes a task.

  Review reads the work and looks things up. The verifier runs the work and
  measures it. This agent never executes the code it reviews, but it can
  consult the bundled Agency documentation and the web to check a claim.

## Types

### ReviewEvalInput

What an eval hands the reviewer: the task and the source written for it.
  The shape the `evals/agency-review` suite uses as its input.

```ts
/** What an eval hands the reviewer: the task and the source written for it.
  The shape the `evals/agency-review` suite uses as its input. */
export type ReviewEvalInput = {
  task: string;
  source: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L148))

## Functions

### reportFeedback

```ts
reportFeedback(report: TypeCheckReport): Feedback[]
```

Convert a typecheck report into findings: one error item per error,
  one advisory item per warning.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| report | [TypeCheckReport](../../agency.md#typecheckreport) |  |

**Returns:** `Feedback[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L20))

### buildTools

```ts
buildTools(): any[]
```

Return the Agency reviewer's lookup tools: the bundled language
  documentation, plus web lookups for anything outside it.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L35))

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
  extraTools: any[] = [],
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
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

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
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L93))

## Nodes

### evalMain

```ts
evalMain(input: ReviewEvalInput): Feedback[]
```

Eval entry point: `agency eval run stdlib/agents/agency/review.agency:evalMain
  --suite <dir>`. A node in a library module never runs when the module is
  imported; it only exists so a suite can score this reviewer without a
  wrapper file. Any other reviewer scored on the same suite supplies a node
  with this signature.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| input | [ReviewEvalInput](#reviewevalinput) |  |

**Returns:** `Feedback[]`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L158))
