---
name: "validators"
---

# validators

Validator functions intended for use with `@validate(...)` annotations.

  Each validator takes a single value and returns a `Result` — `success(value)`
  if the value is valid (optionally transformed), or `failure(reason)` if not.

  Single-argument validators (`isEmail`, `isUrl`, …) can be used directly:

  ```ts
  import { isEmail } from "std::validators"

  @validate(isEmail)
  type Email = string
  ```

  Parameterized validators (`min`, `max`, `minLength`, `maxLength`,
  `matches`) take their configuration as a first argument. Bind the
  configuration parameter via Agency [partial
  application](../guide/partial-application.html) so the result is a
  single-argument validator the chain can call with each value:

  ```ts
  import { min, max } from "std::validators"

  @validate(min.partial(n: 0), max.partial(n: 150))
  type Age = number
  ```

  Validators only run for types annotated with `!` (the bang operator).
  See the [type validation guide](../guide/type-validation.md) for full
  details on `@validate(...)` and how it integrates with `!` validation.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L36))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L56))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L66))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L76))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L85))

### min

```ts
min(n: number, value: number): Result
```

Returns success if `value >= n`, failure otherwise. Bind `n` via PFA
  before passing to `@validate(...)`, e.g. `@validate(min.partial(n: 0))`.

  @param n - The inclusive minimum allowed value.
  @param value - The number to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L94))

### max

```ts
max(n: number, value: number): Result
```

Returns success if `value <= n`, failure otherwise. Bind `n` via PFA
  before passing to `@validate(...)`, e.g. `@validate(max.partial(n: 150))`.

  @param n - The inclusive maximum allowed value.
  @param value - The number to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L105))

### minLength

```ts
minLength(n: number, value: string): Result
```

Returns success if `value.length >= n`, failure otherwise. Bind `n`
  via PFA before passing to `@validate(...)`, e.g.
  `@validate(minLength.partial(n: 3))`.

  @param n - The inclusive minimum allowed length.
  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L116))

### maxLength

```ts
maxLength(n: number, value: string): Result
```

Returns success if `value.length <= n`, failure otherwise. Bind `n`
  via PFA before passing to `@validate(...)`, e.g.
  `@validate(maxLength.partial(n: 80))`.

  @param n - The inclusive maximum allowed length.
  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L128))

### matches

```ts
matches(pattern: string, value: string): Result
```

Returns success if `value` matches the regular expression `pattern`,
  failure otherwise. Bind `pattern` via PFA before passing to
  `@validate(...)`, e.g. `@validate(matches.partial(pattern: "^[A-Z]"))`.

  @param pattern - The regular expression source to match against.
  @param value - The string to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validators.agency#L140))
