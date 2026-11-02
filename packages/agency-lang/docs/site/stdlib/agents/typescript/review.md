---
name: "review"
description: "Review TypeScript readability, architecture, and project conventions."
---

# review

Pass a diff or source text and optional project guidelines. The reviewer
can read repository files and Git history to check duplication and
conventions. It assumes compilers, linters, and tests run separately.

A stopped review may return saved partial findings. A failed review
returns no findings, so an empty list alone does not prove a completed review.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L221))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return repository and web lookup tools for TypeScript reviews.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L87))

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

Review TypeScript readability, architecture, and project conventions.
  A failed review returns no findings.

  @param work - A diff, a file, or several files supplied as text.
  @param guidelines - Project standards that override conflicting built-in review rules.
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.
  @param session - Name a conversation to reuse across calls, or "" for an isolated thread.
  @param extraTools - Tools added to the repository and source lookup tools.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/typescript/review.agency#L148))
