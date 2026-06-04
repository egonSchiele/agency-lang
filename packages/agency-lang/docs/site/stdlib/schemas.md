---
name: "schemas"
---

# schemas

Pre-baked `@jsonSchema(...)` fragments for common formats. Spread them
  into your own `@jsonSchema(...)` annotations to attach the matching
  JSON Schema `format` field:

  ```ts
  import { emailFormat } from "std::schemas"

  @jsonSchema({ ...emailFormat, description: "primary contact" })
  type Email = string
  ```

  These are plain object constants — nothing magic. They exist to spare
  callers from typing `{ format: "..." }` every time and to keep format
  names consistent across a codebase.

## Constants

### emailFormat

```ts
export static const emailFormat = {
  format: "email"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L19))

### urlFormat

```ts
export static const urlFormat = {
  format: "uri"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L22))

### uuidFormat

```ts
export static const uuidFormat = {
  format: "uuid"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L25))

### dateTimeFormat

```ts
export static const dateTimeFormat = {
  format: "date-time"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L28))

### dateFormat

```ts
export static const dateFormat = {
  format: "date"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L31))

### ipv4Format

```ts
export static const ipv4Format = {
  format: "ipv4"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L34))

### ipv6Format

```ts
export static const ipv6Format = {
  format: "ipv6"
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/schemas.agency#L37))
