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
  See the [validation annotations guide](../guide/annotations.md) for details.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L26))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L36))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L56))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L66))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/validators.agency#L75))
