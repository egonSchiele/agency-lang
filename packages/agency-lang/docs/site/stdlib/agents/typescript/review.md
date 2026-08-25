---
name: "review"
description: "Reviews TypeScript code for readability and architecture."
---

# review

The judgment layer above what compilers and linters catch.

  Review reads the work and looks things up. This agent never executes the
  code it reviews and never changes anything, but unlike the other
  reviewers it carries read-only repository tools: its central checks —
  "does this duplicate a helper the codebase already has", "does this
  follow the conventions around it" — cannot be made from the diff alone.

## Types

### TsReviewEvalInput

What an eval hands the reviewer: the task the code was written for, and
  the file holding that code, seeded into the working directory by the
  test's `files/`. The shape the `evals/typescript-review` suite uses as
  its input.

```ts
/** What an eval hands the reviewer: the task the code was written for, and
  the file holding that code, seeded into the working directory by the
  test's `files/`. The shape the `evals/typescript-review` suite uses as
  its input. */
export type TsReviewEvalInput = {
  assignment: string;
  sourceFile: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L205))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the TypeScript reviewer's lookup tools: read-only access to the
  repository under review (for duplication and convention checks), plus
  web lookups for API claims. Nothing that changes anything.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L84))

### typescriptReviewAgent

```ts
typescriptReviewAgent(
  work: string,
  task: string = "",
  guidelines: string = "",
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Review TypeScript code for readability and architecture and return
  findings. error=true marks a problem the change should not merge with;
  error=false is advisory. Compilers and linters are assumed to run
  separately: this agent reports only what needs human-style judgment.

  @param work - The code under review: a diff, a file, or several files as text
  @param task - What the change is supposed to accomplish, or ""
  @param guidelines - The project's own coding standards, as text (for
    example the contents of its anti-pattern catalog). Outranks the
    built-in catalog where they conflict; "" for the built-in catalog alone
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
| guidelines | `string` | "" |
| context | `string` | "" |
| maxCost | `number` | $10.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L145))
