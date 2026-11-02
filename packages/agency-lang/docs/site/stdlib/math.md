---
name: "math"
description: "Small deterministic arithmetic helpers: round, add, subtract, multiply, and a divide that returns a Result so you can handle division by zero."
---

# math

Small deterministic arithmetic helpers: round, add, subtract, multiply,
and a divide that returns a Result so you can handle division by zero.

## Functions

### round

```ts
round(num: number, precision: number = 0): number
```

Round a number to the requested decimal places.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| num | `number` |  |  |
| precision | `number` | 0 | Number of digits after the decimal point. |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L8))

### add

```ts
add(a: number, b: number): number
```

Add two numbers.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L17))

### subtract

```ts
subtract(a: number, b: number): number
```

Subtract b from a.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L22))

### multiply

```ts
multiply(a: number, b: number): number
```

Multiply two numbers.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L27))

### divide

```ts
divide(a: number, b: number): Result<number>
```

Divide a by b. Fails when b is zero.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L32))
