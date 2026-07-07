---
name: Agency packages
description: Describes how to create and publish Agency packages, which are npm packages containing `.agency` source files alongside compiled `.js` output.
---

# Agency packages

An Agency package is simply an npm package with some .agency files in it. This allows Agency to leverage the entire npm package ecosystem. You can publish Agency packages on npm, and install them from npm using `npm install`. Let's look at an example Agency package.

## Publishing an Agency package

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

## Installing an Agency package

Install just like any other npm package:

```
npm install animals
```


## Using an Agency package

Import the Agency package using the `pkg::` prefix. Let's look at a pretend `animals` package that users can install and use.

```
// uses the specified entrypoint file
import { animalFacts } from "pkg::animals"

// imports from a subpath
// possibly mammals.agency in the root dir of the distribution
import { animalFacts } from "pkg::animals/mammals"
```

The `pkg::` prefix tells the compiler to look for `.agency` files in the package. If you don't use the `pkg::` prefix, the compiler will import TypeScript code instead.

Note that you need to export functions using the `export` keyword. All nodes are automatically exported.