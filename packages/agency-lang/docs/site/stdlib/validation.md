---
name: "validation"
---

# validation

Validation surface: validator functions for `@validate(...)`, pre-baked
  `@jsonSchema(...)` format fragments, and opaque validated type aliases
  that combine the two.

  Each validator takes a single value and returns a `Result` — `success(value)`
  if the value is valid (optionally transformed), or `failure(reason)` if not.

  Single-argument validators (`isEmail`, `isUrl`, …) can be used directly:

  ```ts
  import { isEmail } from "std::validation"

  @validate(isEmail)
  type Email = string
  ```

  Parameterized validators (`min`, `max`, `minLength`, `maxLength`,
  `matches`) take their configuration as a first argument. Bind the
  configuration parameter via Agency [partial
  application](../guide/partial-application.html) so the result is a
  single-argument validator the chain can call with each value:

  ```ts
  import { min, max } from "std::validation"

  @validate(min.partial(n: 0), max.partial(n: 150))
  type Age = number
  ```

  Validators only run for types annotated with `!` (the bang operator).
  See the [type validation guide](../guide/type-validation.md) for full
  details on `@validate(...)` and how it integrates with `!` validation.

  The `@jsonSchema(...)` format fragments are plain object constants —
  nothing magic. Spread them into your own `@jsonSchema(...)` annotations
  to attach the matching JSON Schema `format` field:

  ```ts
  import { emailFormat } from "std::validation"

  @jsonSchema({ ...emailFormat, description: "primary contact" })
  type Email = string
  ```

  They exist to spare callers from typing `{ format: "..." }` every time
  and to keep format names consistent across a codebase.

  The type aliases combine `@validate(...)` and `@jsonSchema(...)` for the
  most common string-shaped opaque types. Use them in place of plain
  `string` whenever the value must conform to one of these formats:

  ```ts
  import { Email } from "std::validation"

  def main() {
    const e: Email! = "user@example.com"   // validated at runtime
  }
  ```

  Aliases here only carry annotations — they are still plain `string` from
  TypeScript's perspective. Validation runs on `!` sites; structured-output
  LLM calls get the JSON Schema `format` hint via `.meta(...)`.

## Types

### Email

A syntactically valid email address.

```ts
/** A syntactically valid email address. */
@validate(isEmail)
@jsonSchema({
  ...emailFormat
})
export type Email = string
```

**Validators:** `isEmail`

**JSON Schema metadata:**

```agency
{
  ...emailFormat
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L208))

### URLString

An http:// or https:// URL. (Named `URLString` so it does not shadow
    JavaScript's global `URL` constructor.)

```ts
/** An http:// or https:// URL. (Named `URLString` so it does not shadow
    JavaScript's global `URL` constructor.) */
@validate(isUrl)
@jsonSchema({
  ...urlFormat
})
export type URLString = string
```

**Validators:** `isUrl`

**JSON Schema metadata:**

```agency
{
  ...urlFormat
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L214))

### UUIDString

A canonical 8-4-4-4-12 hex UUID string. (Named `UUIDString` for symmetry
    with `URLString`.)

```ts
/** A canonical 8-4-4-4-12 hex UUID string. (Named `UUIDString` for symmetry
    with `URLString`.) */
@validate(isUuid)
@jsonSchema({
  ...uuidFormat
})
export type UUIDString = string
```

**Validators:** `isUuid`

**JSON Schema metadata:**

```agency
{
  ...uuidFormat
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L220))

### NumberInRange

A number that must lie within the inclusive range `[low, high]`.
    Use as `NumberInRange(0, 100)` etc. — both bounds substitute into the
    `@validate(...)` and `@jsonSchema(...)` tags at the use site.

```ts
/** A number that must lie within the inclusive range `[low, high]`.
    Use as `NumberInRange(0, 100)` etc. — both bounds substitute into the
    `@validate(...)` and `@jsonSchema(...)` tags at the use site. */
@validate(min.partial(n: low), max.partial(n: high))
@jsonSchema({
  minimum: low,
  maximum: high
})
export type NumberInRange(low: number, high: number) = number
```

**Validators:** `min.partial(n: low)`, `max.partial(n: high)`

**JSON Schema metadata:**

```agency
{
  minimum: low,
  maximum: high
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L227))

### StringWithLength

A string whose length is in the inclusive range `[min, max]`.

```ts
/** A string whose length is in the inclusive range `[min, max]`. */
@validate(minLength.partial(n: min), maxLength.partial(n: max))
@jsonSchema({
  minLength: min,
  maxLength: max
})
export type StringWithLength(min: number, max: number) = string
```

**Validators:** `minLength.partial(n: min)`, `maxLength.partial(n: max)`

**JSON Schema metadata:**

```agency
{
  minLength: min,
  maxLength: max
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L232))

### MatchesPattern

A string that matches the given regular expression `pat`.

```ts
/** A string that matches the given regular expression `pat`. */
@validate(matches.partial(pattern: pat))
@jsonSchema({
  pattern: pat
})
export type MatchesPattern(pat: string) = string
```

**Validators:** `matches.partial(pattern: pat)`

**JSON Schema metadata:**

```agency
{
  pattern: pat
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L237))

### BoundedArray

An array whose length is in the inclusive range `[min, max]`.

```ts
/** An array whose length is in the inclusive range `[min, max]`. */
@jsonSchema({
  minItems: min,
  maxItems: max
})
export type BoundedArray<T>(min: number, max: number) = T[]
```

**JSON Schema metadata:**

```agency
{
  minItems: min,
  maxItems: max
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L241))

## Constants

### emailFormat

```ts
export static const emailFormat = {
  format: "email"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L185))

### urlFormat

```ts
export static const urlFormat = {
  format: "uri"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L188))

### uuidFormat

```ts
export static const uuidFormat = {
  format: "uuid"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L191))

### dateTimeFormat

```ts
export static const dateTimeFormat = {
  format: "date-time"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L194))

### dateFormat

```ts
export static const dateFormat = {
  format: "date"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L197))

### ipv4Format

```ts
export static const ipv4Format = {
  format: "ipv4"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L200))

### ipv6Format

```ts
export static const ipv6Format = {
  format: "ipv6"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L203))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L68))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L78))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L88))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L98))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L108))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L117))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L126))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L137))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L148))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L160))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L172))
