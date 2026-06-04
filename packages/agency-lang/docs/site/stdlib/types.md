---
name: "types"
---

# types

Pre-baked type aliases that combine `@validate(...)` and `@jsonSchema(...)`
  for the most common string-shaped opaque types. Use them in place of plain
  `string` whenever the value must conform to one of these formats:

  ```ts
  import { Email } from "std::types"

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L25))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L31))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L37))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L44))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L49))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L54))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/types.agency#L58))
