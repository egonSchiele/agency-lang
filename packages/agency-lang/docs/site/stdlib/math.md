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
round(num: number, precision: number): number
```

Round a number to a given number of decimal places.

  @param num - The number to round
  @param precision - The number of decimal places

**Parameters:**

| Name | Type | Default |
|---|---|---|
| num | `number` |  |
| precision | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L7))

### add

```ts
add(a: number, b: number): number
```

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

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L21))

### multiply

```ts
multiply(a: number, b: number): number
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L25))

### divide

```ts
divide(a: number, b: number): Result<number>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number` |  |
| b | `number` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/math.agency#L29))
