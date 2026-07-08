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

See the [standard library reference](/stdlib/index).

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

## Test-only imports

Tests sometimes need to call a module's internal helpers directly — parsing
functions, path builders, and other pieces that are not part of the module's
public API. Instead of exporting those helpers just for the test (which puts
them in the docs and makes them callable from any program), use
`import test { … }`:

```ts
import test { buildSearchPath, parseEntity } from "std::data/people/littlesis"
```

`import test` works like a normal named import but may also name symbols that
are **not** exported. Its rules:

- It is honored only under the test harness (`agency test`). In a normal
  program, `agency run`/`agency compile`, or the `run()` subprocess sandbox it
  is a hard error.
- It only works for first-party modules — `std::` and local `.agency` files.
  It cannot be used with `pkg::` imports.
- Exported symbols may appear in the list too; `import test` is a superset of
  `import`.

Non-exported helpers stay out of the module's generated documentation and
cannot be reached by normal imports, so the module's public surface is exactly
what it exports.

