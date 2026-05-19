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
