# Package Imports (`pkg::`)

Agency supports importing Agency code from npm packages using the `pkg::` prefix. This allows third-party Agency packages to be published on npm and consumed like any other dependency.

## Syntax

```
import { double } from "pkg::my-agency-tools"
import { capitalize } from "pkg::my-agency-tools/strings"
import { foo } from "pkg::@myorg/agency-utils"
import { bar } from "pkg::@myorg/agency-utils/helpers"
```

The `pkg::` prefix tells the Agency compiler that this import refers to an npm package containing Agency code, as opposed to a plain JS/TS package (like `zod`) which passes through untouched.

## Import tiers

Agency has three categories of imports:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `std::` | Standard library (ships with agency-lang) | `import { add } from "std::math"` |
| `pkg::` | Agency npm package (installed in node_modules) | `import { foo } from "pkg::toolbox"` |
| `./` or `../` | Relative file import | `import { bar } from "./utils.agency"` |
| bare (no prefix) | JS/TS package passthrough | `import { z } from "zod"` |

## How it works

### At compile time

When the compiler encounters a `pkg::` import:

1. **Parse the specifier.** `pkg::toolbox/strings` is split into package name (`toolbox`) and subpath (`strings`). Scoped packages like `pkg::@org/name` are handled correctly.

2. **Find the package.** `resolvePkgAgencyPath()` uses Node's `createRequire`, rooted at the importing file's directory. Node then does the hard work of finding `node_modules` and handling scoped packages and workspaces. If the package's `exports` map hides `./package.json`, resolution falls back to resolving the package entry and walking up to the package root.

3. **Locate the `.agency` file.**
   - **With a subpath** (`pkg::toolbox/strings`): resolves to `<package-dir>/strings.agency`.
   - **Without a subpath** (`pkg::toolbox`): reads the package's `package.json` and looks for the `"agency"` field, which should point to the main `.agency` entry file. The field must end in `.agency` and must resolve inside the package directory.

4. **Build the symbol table.** The compiler parses the resolved `.agency` file to classify its exports (functions, nodes, types). This is what allows `import { foo } from "pkg::toolbox"` to automatically become an `import tool` if `foo` is a function, or an `import node` if `foo` is a graph node.

5. **Emit a bare specifier.** The compiler does not compile the package's `.agency` files. A package ships its own compiled `.js`, and the generated import points at that. `pkg::` edges are invisible to the compile closure and to the dependency fingerprint, so a module whose subtree touches `pkg::` is never skipped by an incremental build. See `lib/compiler/buildManifest.ts` and `docs/dev/compiler/incremental-builds.md`.

### At runtime

The generated JavaScript emits bare npm specifiers:

```javascript
// Agency source
import { foo } from "pkg::toolbox"
import { bar } from "pkg::toolbox/strings"

// Generated JS
import { foo, __fooTool, __fooToolParams } from "toolbox"
import { bar, __barTool, __barToolParams } from "toolbox/strings.js"
```

Node.js resolves these from `node_modules` at runtime using its standard module resolution. No special runtime support is needed.

## Publishing an Agency package

An Agency package is a normal npm package that includes `.agency` source files alongside compiled `.js` output.

### package.json

```json
{
  "name": "my-agency-tools",
  "version": "1.0.0",
  "type": "module",
  "agency": "./index.agency",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./strings": "./strings.js",
    "./package.json": "./package.json"
  },
  "files": ["*.agency", "*.js"]
}
```

Key fields:
- **`"agency"`**: Points to the main `.agency` entry file. Required if users will import the package without a subpath (`pkg::my-agency-tools`). Not needed if users always use subpath imports.
- **`"exports"`**: Standard npm field for Node's module resolution at runtime. Include `"./package.json": "./package.json"` so the Agency compiler can read it during resolution.
- **`"files"`**: Include both `.agency` sources and compiled `.js` output.

### Publish workflow

```bash
# Compile all .agency files to .js
agency compile .

# Publish to npm (both .agency and .js files are included)
npm publish
```

### User workflow

```bash
# Install the package
npm install my-agency-tools

# Use it in Agency code
# import { someFunction } from "pkg::my-agency-tools"
```

## Implementation

The implementation touches these files:

- **`lib/importPaths.ts`** — Core resolution logic. `isPkgImport()`, `parsePkgImport()`, `resolvePkgAgencyPath()`. Also `isAgencyImport()` which is a unified check for all Agency import types (`.agency`, `std::`, `pkg::`).
- **`lib/symbolTable.ts`** — Follows `pkg::` imports when building the symbol table.
- **`lib/preprocessors/importResolver.ts`** — Resolves `pkg::` imports into specialized AST nodes (import tool, import node, etc.) based on symbol kind.
- **`lib/analysis/imports.ts`** — `getImports()` includes `pkg::` imports in the dependency list. `lib/cli/util.ts` builds on it with `getImportsRecursively()`.
- **`lib/compiler/compileClosure.ts`** — `agencyImportTargets()` skips `pkg::` edges, and `programHasPkgImport()` reports whether a program has one.
- **`lib/compiler/buildSession.ts`** — `subtreeHasPkgImport()` keeps any module whose subtree touches `pkg::` out of the incremental-build skip.

### Validation

`parsePkgImport()` validates the import specifier:
- Rejects empty specifiers (`pkg::`)
- Rejects incomplete scoped packages (`pkg::@scope`)
- Rejects path traversal (`pkg::toolbox/../etc`)
- Rejects backslashes and empty segments
- Strips `.agency` extension from subpaths to avoid double extensions

`resolvePkgAgencyPath()` additionally verifies the resolved path stays within the package directory.

### Where `pkg::` is not allowed

- `import test { ... } from "pkg::..."` is rejected. The `import test` keyword is only for first-party `std::` and local modules. See `assertTestOnlyImportable()` in `lib/preprocessors/importResolver.ts`.
- Sandboxed code rejects `pkg::` imports. See `lib/compiler/closureValidator.ts`.
- A compile-time splice generator cannot import `pkg::`, because that leaves Agency. See `docs/dev/language/splices.md`.

## Tests

Unit and integration tests are in `lib/importPaths.test.ts`. The integration tests use fixture packages at `tests/pkg-imports/`:

- `tests/pkg-imports/node_modules/test-agency-pkg/` — package with an `"agency"` field
- `tests/pkg-imports/node_modules/test-agency-pkg2/` — package without an `"agency"` field, imported by subpath
- `tests/pkg-imports/main.agency` — test file that imports from both packages
