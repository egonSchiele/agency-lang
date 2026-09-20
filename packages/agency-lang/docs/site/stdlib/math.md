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

Round a number to a given number of decimal places. With no precision it
  rounds to a whole number.

  @param num - The number to round
  @param precision - The number of decimal places. Defaults to 0.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| num | `number` |  |
| precision | `number` | 0 |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L7))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L18))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L23))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L28))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L33))
