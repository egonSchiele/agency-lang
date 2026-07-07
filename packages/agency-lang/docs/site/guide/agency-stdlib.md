---
name: Agency's Standard Library
description: Overview of Agency's standard library — how to import from it with the `std::` prefix and a list of the language-level builtins like `interrupt`, `schema`, `llm`, and `checkpoint`.
---

# Agency's Standard Library

Agency has a large standard library. Check it out [here](/stdlib/index). To import from the library, use the `std::` prefix:

```ts
import { search } from "std::wikipedia"
```

All the functions inside `std::index` ([link](/stdlib/index)) are always pre-imported for you in every file.
