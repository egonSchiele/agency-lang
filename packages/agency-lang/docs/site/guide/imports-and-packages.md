---
name: Imports and packages
description: Describes how Agency's JavaScript-style import syntax works for relative paths, npm packages, the `std::` standard library, and the `pkg::` prefix for npm-distributed Agency packages.
---

# Imports and packages

Agency imports work just like JavaScript imports. You can import from a relative path, or from `node_modules` if it's a package.

These are all valid imports in Agency:

```ts
// default import
// even if its a TypeScript file, use .js in the import path
import foo from "./foo.js"

// named import
import { foo } from "./foo.js"

// alias import
import { foo as bar } from "./foo.js"

// namespace import
import * as foo from "./foo.js"

// mixed
import foo, { bar } from "./foo.js"
import foo, * as bar from "./foo.js"

// same imports work for agency files
// inside other agency files, use .agency
// but if you're importing an agency file into a TypeScript file, use .js.
import foo from "./foo.agency"
import { foo } from "./foo.agency"
import node { foo } from "./foo.agency"
import tool { foo } from "./foo.agency"
```

## stdlib

Agency also has a standard library. You can import from the standard library using the `std::` prefix.

```ts
import { bash } from "std::shell"
```

## TypeScript Packages

You can import TypeScript from packages just like you usually do:

```ts
import { nanoid } from "nanoid"

node main() {
  print(nanoid())
}
```

See the [interoperability chapter](./ts-interop) for more details on what works and what doesn't when importing from TypeScript.

## Agency Packages

You can also create Agency packages and import from them! An Agency package is simply an npm package with some .agency files in it. This allows Agency to leverage the entire npm package ecosystem. You can publish Agency packages on npm, and install them from npm using `npm install`. Let's look at an example Agency package – how it's created and how it's used.

### Publishing an Agency package

An Agency package is a normal npm package that includes `.agency` source files alongside compiled `.js` output.

### package.json

```
  // include any agency files you want
  "files": ["*.agency", "*.js"]

  // optional entrypoint file.
  "agency": "./index.agency",
  "main": "./index.js",
  "exports": {
    // include package.json in exports
    "./package.json": "./package.json"
  },

```

Let's look at a pretend `animals` package that users can install and use.

```
// uses the specified entrypoint file
import { animalFacts } from "pkg::animals"

// imports from a subpath
// possibly mammals.agency in the root dir of the distribution
import { animalFacts } from "pkg::animals/mammals"
```

Note that to import any functions, you need to export them using the `export` keyword. All nodes are automatically exported.

## Re-exporting from another module

Use `export ... from` to re-export symbols defined in another Agency module. This is the idiomatic way to expose stdlib tools (or symbols from any other Agency package) as your own module's tools — for example, when serving a curated set of tools through `agency serve mcp`.

```
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
export { safe search, fetch } from "std::wikipedia"
```

Re-exports work for functions, nodes, types, and `static const` constants. Classes cannot be re-exported.

When two re-exports would produce the same local name (for example, two `export *` statements that both export `foo`, or a `*` and a named export of the same symbol), you must disambiguate explicitly with `as` — there is no implicit precedence.

## Initializer dependencies through function calls

When you write a top-level `static const` or `const`/`let` whose initializer references another top-level value from a different module, the compiler builds a dependency graph and arranges for the imported module's initialization to complete before yours runs. For direct references this is obvious:

```
// bar.agency
export static const barStatic = "hello"

// foo.agency
import { barStatic } from "./bar.agency"
static const fooStatic = barStatic + "!"  // bar's init runs first
```

The compiler also looks **one function deep** when discovering these dependencies. If your initializer calls a single function, the compiler walks that function's body once and treats any top-level value it reads as a dependency of your initializer:

```
// bar.agency
export static const barStatic = "hello"
export def getBar(): string { return barStatic }

// foo.agency
import { getBar } from "./bar.agency"
static const fooStatic = getBar() + "!"  // bar.barStatic counts as a dep
```

This catches the common case where you have a small wrapper function reading a value. The boundary stops at exactly one function-body hop. The following are **not** detected by static analysis:

- **Depth-2+ chains.** `getBar` calls `_helper` which reads `barStatic` — the compiler sees `getBar`'s body but does not follow `_helper`.
- **Function values stored in variables.** `const f = pickHelper(); const foo = f()` — the compiler cannot tell which function `f` ends up pointing at.
- **Method calls on user objects.** `obj.method()` — the compiler does not introspect class methods.
- **Built-in / stdlib functions.** Their bodies aren't Agency code, so the compiler treats them as opaque. Assume they don't read your top-level state.

Conditional reads inside a called function are treated as always-reads. That's a safe over-approximation: in the worst case you get a small amount of extra `await` work during initialization that doesn't affect correctness.

If your code goes past these limits, the runtime **read-before-init trap** is the safety net. It fires with a clear error message naming the top-level value that was read too early and the module it came from. The recommended fix is to restructure so the read happens inside a `node` or `def` that runs after initialization, not at the top level of another initializer.

For background on how static and global init are scheduled, see [Agency's execution model](/guide/execution-model).