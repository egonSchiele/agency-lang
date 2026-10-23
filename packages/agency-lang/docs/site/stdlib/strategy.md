---
name: "strategy"
description: "Run a block several times and combine the results."
---

# strategy

Run a block several times and combine the results. `sample` collects
every result, `consensus` takes the majority vote, and `retry` /
`retryWithFeedback` re-run a block until one result passes a test. The
`@guard` decorator runs a whole function under a cost and time budget.

```ts
import { consensus } from "std::strategy"

node main() {
  // Run the same prompt 5 times and keep the majority answer.
  let answer = consensus(5) as {
    return llm("Is 17 prime? Answer yes or no.")
  }
  print(answer)
}
```

## Types

### Critique

What a `revise` check decides about one attempt: whether to accept it,
  and if not, the critique the next attempt should address. `feedback` is
  ignored when `accepted` is true.

```ts
/** What a `revise` check decides about one attempt: whether to accept it,
  and if not, the critique the next attempt should address. `feedback` is
  ignored when `accepted` is true. */
export type Critique = {
  accepted: boolean;
  feedback: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L97))

## Functions

### sample

```ts
sample(n: number, block: () -> any): any[]
```

Run a block n times in parallel. Returns an array of all results.

  @param n - Number of times to run
  @param block - The block to execute

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| block | `() => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L29))

### consensus

```ts
consensus(n: number, block: () -> any): any
```

Run a block n times in parallel and return the most common result (majority vote).

  @param n - Number of times to run
  @param block - The block to execute

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L41))

### retry

```ts
retry(n: number, test: (any) -> boolean, block: () -> any): any
```

Run a block up to n times. Returns the first result that passes the test function. Returns null if all attempts fail.

  @param n - Maximum number of attempts
  @param test - The function that returns true when the result is acceptable
  @param block - The block to execute

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L52))

### retryWithFeedback

```ts
retryWithFeedback(
  n: number,
  test: (any) -> boolean,
  block: (any, number) -> any,
): any
```

Run a block up to n times. Each attempt receives the previous result and the attempt number (starting from 1). Returns the first result that passes the test, or the last result if all fail.

  @param n - Maximum number of attempts
  @param test - The function that returns true when the result is acceptable
  @param block - The block receiving (previousResult, attemptNumber)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `(any, number) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L70))

### revise

```ts
revise(
  maxAttempts: number,
  check: (any) -> Critique,
  block: (string) -> any,
): any
```

Run a block until its result is accepted, up to maxAttempts times. Each
  rejected attempt passes its critique to the next one, which receives it as
  its argument (an empty string on the first attempt). Returns the first
  accepted result, or the last result when every attempt is rejected.

  @param maxAttempts - Maximum number of attempts
  @param check - Judges a result and returns the critique to address next
  @param block - The work, receiving the previous critique

**Parameters:**

| Name | Type | Default |
|---|---|---|
| maxAttempts | `number` |  |
| check | `(any) => Critique` |  |
| block | `(string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L102))

### firstValid

```ts
firstValid(variants: any[], test: (any) -> boolean, block: (any) -> any): any
```

Run a block for each variant in parallel, then return the first result that passes the test. Returns null if none pass.

  @param variants - Array of variants to try
  @param test - The function that returns true for valid results
  @param block - The block receiving each variant

**Parameters:**

| Name | Type | Default |
|---|---|---|
| variants | `any[]` |  |
| test | `(any) => boolean` |  |
| block | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L139))

### guard

```ts
guard(
  call: Call,
  cost: number | null = null,
  time: number | null = null,
  label: string | null = null,
  draftsAreAnswers: boolean = false,
  block: () -> any = null,
): Result raises <std::guard>
```

Run the decorated function under a cost and time budget, labelled with
  the function's name. A finished answer is the result, even if the budget
  runs out just after. A budget that runs out before an answer is a failure
  naming the budget, with the draft so far in its data.

  @param cost - Spend cap in dollars, or null for none
  @param time - Working-time cap, or null for none
  @param label - The guard's label; the function's name when null
  @param draftsAreAnswers - true only when every draft the body can send up
    is a finished answer, such as the last attempt revise saved. Leave it
    false when a model in the body can call saveDraft.

The `@guard` decorator: the `guard` block put around a whole function,
  with three rules added. A finished answer is the result, even if the
  budget runs out just after. A budget that runs out before an answer is a
  failure naming it ("its time budget of 30m ran out"), with the draft so
  far in its data. A finished `""` is a failure, "it returned no answer".

  ```ts
  import { guard } from "std::strategy"

  @guard(cost: $1.00, time: 5m)
  def summarize(text: string): Result<string> {
    return llm("Summarize: ${text}")
  }
  ```

  A draft saved inside the body never reaches the guard as an answer: the
  model can call `saveDraft` halfway through and the half-written text
  would read as finished. `draftsAreAnswers: true` lets the body's draft
  through, for a body whose only draft is a finished attempt, such as the
  last one `revise` saved. The decorator answers its own budget trip, so a
  caller cannot grant more budget; pass a larger limit instead. See
  docs/dev/agents/subagent-budgets.md.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| call | [Call](index.md#call) |  |
| cost | `number \| null` | null |
| time | `number \| null` | null |
| label | `string \| null` | null |
| draftsAreAnswers | `boolean` | false |
| block | `() => any` | null |

**Returns:** `Result`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L185))
