---
name: "validation"
description: "Validate values and describe constraints in tool schemas."
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

An email-shaped string with a name, an @ sign, and a dotted domain.

```ts
/** An email-shaped string with a name, an @ sign, and a dotted domain. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L154))

### URLString

A string with an http:// or https:// prefix and no whitespace.

```ts
/** A string with an http:// or https:// prefix and no whitespace. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L160))

### UUIDString

A UUID in 8-4-4-4-12 hexadecimal form.

```ts
/** A UUID in 8-4-4-4-12 hexadecimal form. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L165))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L172))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L177))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L182))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L186))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L213))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L218))

## Constants

### emailFormat

JSON Schema email format annotation for a string.

```ts
/** JSON Schema email format annotation for a string. */
export static const emailFormat = {
  format: "email"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L131))

### urlFormat

`{ format: "uri" }` — RFC 3986 URI.

```ts
/** `{ format: "uri" }` — RFC 3986 URI. */
export static const urlFormat = {
  format: "uri"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L134))

### uuidFormat

`{ format: "uuid" }` — canonical 8-4-4-4-12 UUID.

```ts
/** `{ format: "uuid" }` — canonical 8-4-4-4-12 UUID. */
export static const uuidFormat = {
  format: "uuid"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L137))

### dateTimeFormat

`{ format: "date-time" }` — ISO 8601 date-time.

```ts
/** `{ format: "date-time" }` — ISO 8601 date-time. */
export static const dateTimeFormat = {
  format: "date-time"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L140))

### dateFormat

`{ format: "date" }` — ISO 8601 date (no time).

```ts
/** `{ format: "date" }` — ISO 8601 date (no time). */
export static const dateFormat = {
  format: "date"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L143))

### ipv4Format

`{ format: "ipv4" }` — dotted-quad IPv4 address.

```ts
/** `{ format: "ipv4" }` — dotted-quad IPv4 address. */
export static const ipv4Format = {
  format: "ipv4"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L146))

### ipv6Format

`{ format: "ipv6" }` — IPv6 address.

```ts
/** `{ format: "ipv6" }` — IPv6 address. */
export static const ipv6Format = {
  format: "ipv6"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L149))

## Functions

### isEmail

```ts
isEmail(value: string): Result
```

Check for an email-shaped string with a name, an @ sign, and a dotted domain.

Use for a basic input check. This does not verify that the mailbox exists or
implement every email-address syntax rule.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L33))

### isUrl

```ts
isUrl(value: string): Result
```

Check for an http:// or https:// prefix followed by non-whitespace text.

Use for a basic URL check. This does not validate the hostname or fetch the URL.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L43))

### isUuid

```ts
isUuid(value: string): Result
```

Returns success if value is a canonical UUID string
  (8-4-4-4-12 hex), failure otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `string` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L50))

### isInt

```ts
isInt(value: number): Result
```

Returns success if value is an integer (no fractional component),
  failure otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L58))

### isPositive

```ts
isPositive(value: number): Result
```

Returns success if value > 0, failure otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L66))

### isNegative

```ts
isNegative(value: number): Result
```

Returns success if value < 0, failure otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `number` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L73))

### min

```ts
min(n: number, value: number): Result
```

Returns success if `value >= n`, failure otherwise.

Bind `n` with partial application before use in `@validate(...)`, e.g. `@validate(min.partial(n: 0))`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| n | `number` |  | The inclusive minimum allowed value. |
| value | `number` |  |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L81))

### max

```ts
max(n: number, value: number): Result
```

Returns success if `value <= n`, failure otherwise.

Bind `n` with partial application before use in `@validate(...)`, e.g. `@validate(max.partial(n: 150))`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| n | `number` |  | The inclusive maximum allowed value. |
| value | `number` |  |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L91))

### minLength

```ts
minLength(n: number, value: string): Result
```

Returns success if `value.length >= n`, failure otherwise.

Bind `n` with partial application before use in `@validate(...)`, e.g. `@validate(minLength.partial(n: 3))`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| n | `number` |  | The inclusive minimum allowed length. |
| value | `string` |  |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L101))

### maxLength

```ts
maxLength(n: number, value: string): Result
```

Returns success if `value.length <= n`, failure otherwise.

Bind `n` with partial application before use in `@validate(...)`, e.g. `@validate(maxLength.partial(n: 80))`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| n | `number` |  | The inclusive maximum allowed length. |
| value | `string` |  |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L111))

### matches

```ts
matches(pattern: string, value: string): Result
```

Returns success if `value` matches the regular expression `pattern`, failure otherwise.

Bind `pattern` with partial application before use in `@validate(...)`, e.g. `@validate(matches.partial(pattern: "^[A-Z]"))`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| pattern | `string` |  | The regular expression source to match against. |
| value | `string` |  |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L121))

### isJsonValue

```ts
isJsonValue(value: any): Result
```

Returns success if value is a plain JSON tree that round-trips through
  JSON serialization unchanged, failure (naming the offending path)
  otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L188))

### isJsonObject

```ts
isJsonObject(value: any): Result
```

Returns success if value is a plain JSON-serializable object (non-null,
  non-array), failure otherwise.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/validation.agency#L197))
