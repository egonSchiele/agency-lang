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
export type Email = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L25))

### URL

An http:// or https:// URL.

```ts
/** An http:// or https:// URL. */
export type URL = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L30))

### UUID

A canonical 8-4-4-4-12 hex UUID.

```ts
/** A canonical 8-4-4-4-12 hex UUID. */
export type UUID = string
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/types.agency#L35))
