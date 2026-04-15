# retry

## Functions

### retry

```ts
retry(n: number, test: (any) => boolean, block: () => any): any
```

Run a block up to n times. Returns the first result that passes the test function. Returns null if all attempts fail.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | number |  |
| test | (any) => boolean |  |
| block | () => any |  |

**Returns:** any

### retryWithFeedback

```ts
retryWithFeedback(n: number, test: (any) => boolean, block: (any, number) => any): any
```

Run a block up to n times. Each attempt receives the previous result and the attempt number (starting from 1). Returns the first result that passes the test, or the last result if all fail.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | number |  |
| test | (any) => boolean |  |
| block | (any, number) => any |  |

**Returns:** any
