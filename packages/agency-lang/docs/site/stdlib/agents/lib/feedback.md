---
name: "feedback"
description: "Combine and inspect findings returned by reviewer and verifier agents."
---

# feedback

Use `feedbackHasErrors` to decide whether another attempt is needed and
`renderFeedback` to give the findings to that attempt. `mergeFeedback` and
`flattenFeedback` preserve failures. `failOpenFeedback` discards failures
when the caller deliberately allows an unavailable review.

## Types

### Feedback

One review or verification finding. `error` marks a blocking problem.
A false value can mark advice or a satisfied point. `source` links to a
page used to check the finding.

```ts
/** One review or verification finding. `error` marks a blocking problem.
A false value can mark advice or a satisfied point. `source` links to a
page used to check the finding. */
export type Feedback = {
  error: boolean;
  feedback: string;
  source?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L13))

## Functions

### mergeFeedback

```ts
mergeFeedback(a: Result<Feedback[]>, b: Result<Feedback[]>): Result<Feedback[]>
```

Concatenate successful finding lists, returning the first failure if either input failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `Result<Feedback[]>` |  |
| b | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L19))

### flattenFeedback

```ts
flattenFeedback(feedback: Result<Feedback[]>[]): Result<Feedback[]>
```

Combine finding lists, returning the first failed Result if one is present.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>[]` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L38))

### renderFeedback

```ts
renderFeedback(feedback: Result<Feedback[]>): string
```

Render findings as paragraphs, or return the failure message when the review failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L60))

### feedbackHasErrors

```ts
feedbackHasErrors(feedback: Result<Feedback[]>): boolean
```

Return whether findings include an error or the review itself failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `boolean`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L70))

### failOpenFeedback

```ts
failOpenFeedback(feedback: Result<Feedback[]>): Result<Feedback[]>
```

Keep successful findings and turn failures into an empty finding list.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| feedback | `Result<Feedback[]>` |  |

**Returns:** `Result<Feedback[]>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/feedback.agency#L80))
