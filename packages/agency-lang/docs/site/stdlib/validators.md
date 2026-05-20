# validators

Validator functions intended for use with `@validate(...)` annotations.

  Each validator takes a single value and returns a `Result` — `success(value)`
  if the value is valid (optionally transformed), or `failure(reason)` if not.

  ## Usage

  ```ts
  import { isEmail } from "std::validators"

  @validate(isEmail)
  type Email = string

  def main() {
    const e: Email! = "foo@example.com"   // validated
  }
  ```

  Validators are only run for types annotated with `!` (the bang operator).
  See the [annotations guide](../guide/annotations.md) for details on
  `@validate(...)` and how it integrates with `!` validation.

## Constants

### min

```ts
export static const min = _min
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L100))

### max

```ts
export static const max = _max
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L101))

### minLength

```ts
export static const minLength = _minLength
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L102))

### maxLength

```ts
export static const maxLength = _maxLength
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L103))

### matches

```ts
export static const matches = _matches
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L104))

## Functions

### isEmail

```ts
isEmail(value: string): Result
```

Returns success if value is a syntactically valid email address,
  failure otherwise.

  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L27))

### isUrl

```ts
isUrl(value: string): Result
```

Returns success if value is an http:// or https:// URL,
  failure otherwise.

  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L37))

### isUuid

```ts
isUuid(value: string): Result
```

Returns success if value is a canonical UUID string
  (8-4-4-4-12 hex), failure otherwise.

  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L47))

### isInt

```ts
isInt(value: number): Result
```

Returns success if value is an integer (no fractional component),
  failure otherwise.

  @param value - The number to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L57))

### isPositive

```ts
isPositive(value: number): Result
```

Returns success if value > 0, failure otherwise.

  @param value - The number to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L67))

### isNegative

```ts
isNegative(value: number): Result
```

Returns success if value < 0, failure otherwise.

  @param value - The number to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L76))
