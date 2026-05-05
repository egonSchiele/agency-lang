# strategy

## Functions

### sample

```ts
sample(n: number, block: () => any): any[]
```

Run a block n times in parallel. Returns an array of all results.

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

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L10))

### retry

```ts
retry(n: number, test: (any) => boolean, block: () => any): any
```

Run a block up to n times. Returns the first result that passes the test function. Returns null if all attempts fail.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L18))

### retryWithFeedback

```ts
retryWithFeedback(n: number, test: (any) => boolean, block: (any, number) => any): any
```

Run a block up to n times. Each attempt receives the previous result and the attempt number (starting from 1). Returns the first result that passes the test, or the last result if all fail.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| test | `(any) => boolean` |  |
| block | `(any, number) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L32))

### firstValid

```ts
firstValid(variants: any[], test: (any) => boolean, block: (any) => any): any
```

Run a block for each variant in parallel, then return the first result that passes the test. Returns null if none pass.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| variants | `any[]` |  |
| test | `(any) => boolean` |  |
| block | `(any) => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/strategy.agency#L48))
