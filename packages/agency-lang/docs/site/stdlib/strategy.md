---
name: "strategy"
description: "Sample alternatives, retry work, and revise results using feedback."
---

# strategy

Use `sample` to collect parallel attempts and `consensus` to choose the
most common result. `retry` accepts the first result that passes a test.
`revise` gives each new attempt the prior attempt's critique.

```ts
import { retry } from "std::strategy"

node main() {
  const answer = retry(3, test: \text -> text.length > 0) as {
    return llm("Suggest a short title for a gardening guide")
  }
  print(answer)
}
```

Function budget decorators live in `std::decorators`.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L89))

## Functions

### sample

```ts
sample(n: number, block: () -> any): any[]
```

Run a block several times in parallel and collect the results in attempt order.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| block | `() => any` |  |

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L31))

### consensus

```ts
consensus(n: number, block: () -> any): any
```

Run a block several times in parallel and return its most common result.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L40))

### retry

```ts
retry(n: number, test: (any) -> boolean, block: () -> any): any
```

Retry a block until its result passes a test.
  Return the first passing result, or null when no attempt passes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L48))

### retryWithFeedback

```ts
retryWithFeedback(
  n: number,
  test: (any) -> boolean,
  block: (any, number) -> any,
): any
```

Retry a block using the prior result to improve each attempt.
  Return the first passing result, or the last result if no attempt passes.

  @param block - Receives null on the first attempt, then the previous result, followed by a one-based attempt number.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `(any, number) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L63))

### revise

```ts
revise(
  maxAttempts: number,
  check: (any) -> Critique,
  block: (string) -> any,
): any
```

Revise work using critiques until a check accepts it or attempts run out.
  Return the accepted result, or the last result when all attempts are rejected.

  @param block - Receives an empty string first, then the prior critique's feedback.

The first attempt receives an empty critique. Later attempts receive the
feedback from the last rejected result. When a budget guard stops the work,
the last completed attempt can reach the guard as a partial result.
If no attempt completed, an attempt's saved draft can be used instead.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| maxAttempts | `number` |  |
| check | `(any) => Critique` |  |
| block | `(string) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L98))

### firstValid

```ts
firstValid(variants: any[], test: (any) -> boolean, block: (any) -> any): any
```

Run a block for each variant in parallel and return the first passing result
  in input order, or null when none passes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| variants | `any[]` |  |
| test | `(any) => boolean` |  |
| block | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/strategy.agency#L144))
