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