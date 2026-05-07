# strategy

## Functions

### sample

```ts
sample(n: number, block: () => any): any[]
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L1))

### consensus

```ts
consensus(n: number, block: () => any): any
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L13))

### retry

```ts
retry(n: number, test: (any) => boolean, block: () => any): any
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L24))

### retryWithFeedback

```ts
retryWithFeedback(n: number, test: (any) => boolean, block: (any, number) => any): any
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L42))

### firstValid

```ts
firstValid(variants: any[], test: (any) => boolean, block: (any) => any): any
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L62))
