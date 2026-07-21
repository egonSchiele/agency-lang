---
name: "validation"
description: "Validators and format helpers for constrained types, for use with @validate(...) and @jsonSchema(...)."
---

# validation

Validators and format helpers for constrained types. Pair a validator with
  `@validate(...)` to check values at runtime, spread the pre-baked
  `@jsonSchema(...)` format fragments into your own schemas, or reach for the
  ready-made type aliases (`Email`, `URLString`, `UUIDString`, …) that combine
  both. Each validator takes a value and returns a `Result`.

  Single-argument validators plug straight in. Parameterized ones bind their
  config via partial application:

  ```ts
  import { isEmail, min, max } from "std::validation"

  @validate(isEmail)
  type Email = string

  @validate(min.partial(n: 0), max.partial(n: 150))
  type Age = number
  ```

  Validators only run on types annotated with `!` (the bang operator). See the
  [type validation guide](../guide/type-validation.md) for full details.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L166))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L172))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L178))

### NumberInRange

A number that must lie within the inclusive range `[low, high]`.
    Use as `NumberInRange(0, 100)` etc. Both bounds substitute into the
    `@validate(...)` and `@jsonSchema(...)` tags at the use site.

```ts
/** A number that must lie within the inclusive range `[low, high]`.
    Use as `NumberInRange(0, 100)` etc. Both bounds substitute into the
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L185))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L190))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L195))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L199))

### Json

A value that round-trips through JSON unchanged: null, booleans, strings,
    finite numbers, arrays of Json, and plain objects of Json. Class
    instances (Date, Map, ...), functions, NaN/Infinity, and cyclic
    structures are rejected.

```ts
/** A value that round-trips through JSON unchanged: null, booleans, strings,
    finite numbers, arrays of Json, and plain objects of Json. Class
    instances (Date, Map, ...), functions, NaN/Infinity, and cyclic
    structures are rejected. */
@validate(isJsonValue)
export type Json = any
```

**Validators:** `isJsonValue`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L237))

### JsonObject

A plain JSON-serializable object: non-null, non-array, and every value
    reachable from it is Json.

```ts
/** A plain JSON-serializable object: non-null, non-array, and every value
    reachable from it is Json. */
@validate(isJsonObject)
export type JsonObject = object
```

**Validators:** `isJsonObject`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L242))

## Constants

### emailFormat

```ts
export static const emailFormat = {
  format: "email"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L143))

### urlFormat

```ts
export static const urlFormat = {
  format: "uri"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L146))

### uuidFormat

```ts
export static const uuidFormat = {
  format: "uuid"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L149))

### dateTimeFormat

```ts
export static const dateTimeFormat = {
  format: "date-time"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L152))

### dateFormat

```ts
export static const dateFormat = {
  format: "date"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L155))

### ipv4Format

```ts
export static const ipv4Format = {
  format: "ipv4"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L158))

### ipv6Format

```ts
export static const ipv6Format = {
  format: "ipv6"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L161))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L29))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L39))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L49))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L59))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L69))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L78))

### min

```ts
min(n: number, value: number): Result
```

Returns success if `value >= n`, failure otherwise.

  @param n - The inclusive minimum allowed value.
  @param value - The number to check.

Bind `n` via PFA before use in `@validate(...)`, e.g. `@validate(min.partial(n: 0))`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L88))

### max

```ts
max(n: number, value: number): Result
```

Returns success if `value <= n`, failure otherwise.

  @param n - The inclusive maximum allowed value.
  @param value - The number to check.

Bind `n` via PFA before use in `@validate(...)`, e.g. `@validate(max.partial(n: 150))`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L99))

### minLength

```ts
minLength(n: number, value: string): Result
```

Returns success if `value.length >= n`, failure otherwise.

  @param n - The inclusive minimum allowed length.
  @param value - The string to check.

Bind `n` via PFA before use in `@validate(...)`, e.g. `@validate(minLength.partial(n: 3))`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L110))

### maxLength

```ts
maxLength(n: number, value: string): Result
```

Returns success if `value.length <= n`, failure otherwise.

  @param n - The inclusive maximum allowed length.
  @param value - The string to check.

Bind `n` via PFA before use in `@validate(...)`, e.g. `@validate(maxLength.partial(n: 80))`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| n | `number` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L121))

### matches

```ts
matches(pattern: string, value: string): Result
```

Returns success if `value` matches the regular expression `pattern`, failure otherwise.

  @param pattern - The regular expression source to match against.
  @param value - The string to check.

Bind `pattern` via PFA before use in `@validate(...)`, e.g. `@validate(matches.partial(pattern: "^[A-Z]"))`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| pattern | `string` |  |
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L132))

### isJsonValue

```ts
isJsonValue(value: any): Result
```

Returns success if value is a plain JSON tree that round-trips through
  JSON serialization unchanged, failure (naming the offending path)
  otherwise.

  @param value - The value to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L201))

### isJsonObject

```ts
isJsonObject(value: any): Result
```

Returns success if value is a plain JSON-serializable object (non-null,
  non-array), failure otherwise.

  @param value - The value to check.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L219))
