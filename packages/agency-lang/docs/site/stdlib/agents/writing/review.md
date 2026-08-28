---
name: "review"
description: "Reviews prose for readability: the judgment layer above spelling"
---

# review

and grammar.

  The reviewer takes the text itself or a request naming the files that hold
  it, and reads those files itself. It judges whether a reader can follow
  the writing, using a small catalog of readability principles, and a
  caller can supply its own writing guidelines to extend or override them.
  It carries write and edit tools so it can apply its fixes, but only when
  the request asks for that; by default it reports and changes nothing.

## Types

### WritingReviewEvalInput

What an eval hands the reviewer: the task the text was written for, and
  the file holding that text, seeded into the working directory by the
  test's `files/`. The shape the `evals/writing-review` suite uses as its
  input.

```ts
/** What an eval hands the reviewer: the task the text was written for, and
  the file holding that text, seeded into the working directory by the
  test's `files/`. The shape the `evals/writing-review` suite uses as its
  input. */
export type WritingReviewEvalInput = {
  assignment: string;
  sourceFile: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L442))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the writing reviewer's tools: the file tools (to read the text
  under review, and to apply fixes when asked), the shipped skills, and
  progress reporting.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L316))

### writingReviewAgent

```ts
writingReviewAgent(
  work: string,
  task: string = "",
  guidelines: string = "",
  context: string = "",
  maxCost: number = $5.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Review prose for readability and return findings. error=true marks a
  passage a reader will misread or lose; error=false is advisory polish.
  Spelling and grammar are assumed checked separately: this agent reports
  only what needs judgment.

  @param work - The text under review, or a request naming the files that
    hold it (and, if the caller wants the fixes applied, saying so)
  @param task - Who the text is for and what it must get across, or ""
  @param guidelines - The caller's own writing guidelines, as text (for
    example the contents of a project's writing-tips document). Outranks
    the built-in catalog where they conflict; "" for the built-in catalog alone
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
| maxCost | `number` | $5.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L373))
