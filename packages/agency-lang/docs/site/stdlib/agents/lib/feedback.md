---
name: "feedback"
description: "The Feedback type the agents use to report findings, with helpers"
---

# feedback

to merge, flatten, render, and inspect feedback lists.

## Types

### Feedback

```ts
export type Feedback = {
  error: boolean;
  feedback: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L6))

## Functions

### mergeFeedback

```ts
mergeFeedback(a: Result<Feedback[]>, b: Result<Feedback[]>): Result<Feedback[]>
```

Merge two feedback Results by concatenating their success arrays or
  returning the first failure.

  @param a - First feedback Result
  @param b - Second feedback Result

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `Result<Feedback[]>` |  |
| b | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L11))

### flattenFeedback

```ts
flattenFeedback(feedback: Result<Feedback[]>[]): Result<Feedback[]>
```

Flatten an array of feedback Results into a single Result.

  @param feedback - An array of feedback Results

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>[]` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L34))

### renderFeedback

```ts
renderFeedback(feedback: Result<Feedback[]>): string
```

Render a feedback Result as human-readable text, one line per finding.

  @param feedback - The Result review() returned

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L55))

### feedbackHasErrors

```ts
feedbackHasErrors(feedback: Result<Feedback[]>): boolean
```

True when any finding is an error, or when the feedback Result itself
  is a failure.

  @param feedback - The feedback wrapped in a Result

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L67))

### failOpenFeedback

```ts
failOpenFeedback(feedback: Result<Feedback[]>): Result<Feedback[]>
```

Pass a successful feedback list through unchanged; map any failure to no
  findings. Use this to make a checker fail open: a checker that could not run
  reports nothing rather than a blocking error.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L84))
