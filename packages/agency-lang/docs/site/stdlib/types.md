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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L25))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L31))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L37))
