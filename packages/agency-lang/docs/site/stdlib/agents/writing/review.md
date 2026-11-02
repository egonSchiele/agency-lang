---
name: "review"
description: "Review prose for readability using built-in or caller-supplied guidelines."
---

# review

Pass prose or a request naming files. The reviewer reports findings and
can apply edits when the request explicitly asks for them. Separate passes
look for unnecessary passages, verbal tics, and readability problems.

By default, a failed review returns no findings. Pass `failOpen: false` to
receive failures. A budget stop may still return saved partial findings.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L509))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the writing reviewer's file editing, skill, and communication tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L341))

### writingReviewAgent

```ts
writingReviewAgent(
  text: string,
  task: string = "",
  guidelines: string = "",
  context: string = "",
  maxCost: number = $5.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  failOpen: boolean = true,
): Result<Feedback[]>
```

Review prose for readability and return findings, applying edits only when requested.

  @param text - Prose or a request naming files, explicitly asking for edits if wanted.
  @param task - The intended reader and what the text must communicate.
  @param guidelines - Writing guidelines that override conflicting built-in review rules.
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.
  @param session - Name a conversation for the main review, or "" for an isolated thread.
  @param extraTools - Tools added to the main review only.
  @param failOpen - False returns review failures, while saved partial findings can still succeed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| task | `string` | "" |
| guidelines | `string` | "" |
| context | `string` | "" |
| maxCost | `number` | $5.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |
| failOpen | `boolean` | true |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/review.agency#L396))
