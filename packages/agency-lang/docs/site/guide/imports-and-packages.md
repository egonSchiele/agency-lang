---
name: Imports and packages
description: Describes how Agency's JavaScript-style import syntax works for relative paths, npm packages, the `std::` standard library, and the `pkg::` prefix for npm-distributed Agency packages.
---

# Imports and packages

## Agency imports

Agency imports work just like JavaScript imports.

```ts
// default import
import foo from "./foo.agency"

// named import
import { foo } from "./foo.agency"

// alias import
import { foo as bar } from "./foo.agency"

// namespace import
import * as foo from "./foo.agency"

// mixed
import foo, { bar } from "./foo.agency"
import foo, * as bar from "./foo.agency"

```

## TypeScript imports

You can import TypeScript and JavaScript code the same way. 

```ts
import foo from "./foo.js"
import { foo } from "./foo.js"
import { foo as bar } from "./foo.js"
import * as foo from "./foo.js"
```

Always use the `.js` extension, even if you are importing TypeScript code.

## Standard library imports

Agency also has a standard library. You can import from the standard library using the `std::` prefix.

```ts
import { bash } from "std::shell"
```

See the [standard library reference](/stdlib).

## TypeScript Packages

You can import from packages just like you usually do:

```ts
import { nanoid } from "nanoid"

node main() {
  print(nanoid())
}
```

See the [interoperability chapter](./ts-interop) for more details on what works and what doesn't when importing from TypeScript.

## What you can export

- Nodes
- Functions
- Types
- `static const` constants

You cannot export global variables unless they are marked `static`. [Global and static variables](/guide/global-vs-static) will be covered in a later section.

## Re-exporting from another module

Use `export ... from` to re-export symbols defined in another Agency module:

```ts
// Re-export by name
export { search } from "std::wikipedia"

// Re-export with a different name
export { search as wikipediaSearch } from "std::wikipedia"

// Re-export multiple names
export { search, fetch } from "std::wikipedia"

// Re-export everything that the source module exports
export * from "std::wikipedia"

// Mark a re-exported function as `safe` (per-name)
export { safe search } from "std::wikipedia"

// search is marked safe but fetch isn't
export { safe search, fetch } from "std::wikipedia"
```

