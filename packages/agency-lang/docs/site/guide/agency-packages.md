---
name: Agency packages
description: Describes how to create and publish Agency packages, which are npm packages containing `.agency` source files alongside compiled `.js` output.
---

# Agency packages

You can also create Agency packages and import from them! An Agency package is simply an npm package with some .agency files in it. This allows Agency to leverage the entire npm package ecosystem. You can publish Agency packages on npm, and install them from npm using `npm install`. Let's look at an example Agency package – how it's created and how it's used.

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

Let's look at a pretend `animals` package that users can install and use.

```
// uses the specified entrypoint file
import { animalFacts } from "pkg::animals"

// imports from a subpath
// possibly mammals.agency in the root dir of the distribution
import { animalFacts } from "pkg::animals/mammals"
```

Note that to import any functions, you need to export them using the `export` keyword. All nodes are automatically exported.