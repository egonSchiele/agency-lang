# Design: error on plain imports that don't resolve to a real export

**Date:** 2026-07-12

**Related:** follow-up to #438 / PR #525 (directory typecheck). That PR made `agency tc <dir>` seed the `SymbolTable` from every file, so a directory check now loads every file. This design builds on that completeness.

**Revised** after review (`2026-07-12-strict-imports-check-review.md`). The review found that `export { } from` and `pkg::` imports already error today, so this design narrows to the genuinely-silent cases.

## Problem

Agency is not TypeScript. In TypeScript an import can name a declaration the checker hasn't seen. In Agency, an import should name something that actually exists. For **plain imports** (`import { ... }` and `import node { ... }`), it doesn't have to.

Two plain-import mistakes are silent today:

1. **Missing name.** A file imports a name from a target Agency file that exists and is loaded, but that file doesn't define the name.
2. **Missing module.** A file imports from a relative or `std::` path that resolves to no file on disk.

Example of the missing-name case:

```
// lib.agency  — note: no `missingFn` here
export def realFn(): string { return "x" }
```

```
// use.agency
import { missingFn } from "./lib.agency"

node u(): string {
  return missingFn()
}
```

Running `agency tc` on both files reports `No type errors found.`

### Why it is silent today

Scope building declares every imported name unconditionally. For each import statement, `lib/typeChecker/scopes.ts:403` calls `scope.declare(name, "any")` for each imported name, whether or not the target file defines it. So `missingFn` becomes a known binding of type `any`. The later call to `missingFn()` resolves to that binding, so it does not trip the undefined-function check (`AG4004`), and because its type is `any`, its arguments aren't checked either. Nothing verifies that `lib.agency` really exports `missingFn`.

Cross-file resolution lives in `SymbolTable.resolveImport` (`lib/symbolTable.ts:281`). It looks up `this.files[targetPath]?.[name]` and simply skips (`symbolTable.ts:289`) when the entry is absent. It never distinguishes "the target was loaded and lacks the name" from "the target was never loaded", so it can't raise an error on its own.

For contrast, a bare call to a name that exists nowhere already warns (`bad.agency:2:10 - warning AG4004: Function 'totallyUndefinedFn' is not defined.`). So the gap is specific to plain imports.

### What is already handled (and out of scope here)

The review confirmed two neighboring cases are **not** silent — they already throw inside `SymbolTable.build`, before any typechecker pass runs:

- **`export { name } from "./mod"`** — `mergeExportsFrom` (`symbolTable.ts:461`) throws when the name is missing (`symbolTable.ts:490`) or not exported (`symbolTable.ts:494`).
- **`pkg::` imports that don't resolve** — `resolvePkgAgencyPath` (`importPaths.ts:448`) throws when the package or its `agency` entry is missing, and `resolveAgencyImportPath` propagates it.

These already fail, but as ugly uncaught throws rather than clean diagnostics. Converting them into registry diagnostics is worthwhile but is a **separate follow-up**: it would change `SymbolTable.build`'s contract from "throw" to "collect and report", which many callers depend on. This PR leaves them as-is.

## Key insight

The symbol table records which files it loaded. `SymbolTable.getFile(absPath)` returns that file's symbols, or `undefined` when the file was never loaded. Combined with a filesystem existence check, that separates a real mistake from an incomplete view:

- Module path does not exist on disk → **missing module**. Error.
- Module exists on disk but `getFile` returns `undefined` (loaded nothing — e.g. a parse failure in the target, or an editor checking one file without its dependency) → **silent**. The checker's view is incomplete, and the target's own error is the real diagnostic.
- Module loaded, and the name is absent → **missing name**. Error.

A normal `agency tc` run loads every imported file, because `SymbolTable.build` crawls imports transitively. So the silent branch is rare in practice, and real mistakes are caught. Module resolution reuses `resolveAgencyImportPath` (`lib/importPaths.ts`), the same function the compiler uses.

## Design

### A new typechecker pass

Add `checkMissingImports`, a pass mirroring `checkUndefinedFunctions` (`lib/typeChecker/undefinedFunctionDiagnostic.ts`). It walks the plain import statements in the file being checked and validates each imported Agency name against the symbol table. It runs only when the checker has both `ctx.symbolTable` and `ctx.currentFile`; without them it does nothing.

### What it checks, per imported name

For each **Agency** plain import (`import { x }`, `import { x as y }`, `import node { x }`):

1. Resolve the module path. Wrap `resolveAgencyImportPath(modulePath, currentFile)` in a `try/catch`; a throw (e.g. an unresolvable path) becomes an `importModuleNotFound` error rather than a crash. In practice `build` resolves these first, but the guard keeps the pass robust if the two ever diverge.
2. If the resolved path does not exist on disk → **`importModuleNotFound`** error at the import statement.
3. Else look up `symbolTable.getFile(resolvedPath)`:
   - `undefined` (exists but not loaded) → silent.
   - defined, name present → OK.
   - defined, name absent → **`importNameNotFound`** error at the import statement.

Aliased imports (`x as y`) check the **original** name `x`, since that is what the target must define. `import node { x }` checks node symbols the same way; they live in the same `FileSymbols` map (`kind: "node"`).

Presence uses "the name appears in the file's symbols", ignoring the `exported` flag (see the export-visibility note below).

### What it skips

- **`export { } from`** — already validated (throws in `build`). Not handled here.
- **`pkg::` that fails to resolve** — already throws in `build` before this pass runs. A `pkg::` import that *does* resolve is checked normally, so a missing name in a resolved package file is caught.
- **JavaScript imports** (`import { x } from "./helpers.js"`) — the checker can't read a `.js` file's exports. `isAgencyImport(modulePath)` distinguishes these; the pass ignores non-Agency imports.

### Severity: always error, no config knob

Both new diagnostics are always errors:

- `importNameNotFound` — "'<name>' is not defined in '<module>'."
- `importModuleNotFound` — "Cannot find module '<module>'."

There is no config knob, and this does not reuse `undefinedFunctions`. The asymmetry with `undefinedFunctions` (a call to an unknown name is a silenceable *warning*) is deliberate and reflects **confidence**. A plain Agency import names one specific Agency file, so "the name isn't there" is certain. A bare call like `foo()` might be an uncatalogued JavaScript global (`parseInt`, `atob`, …), which Agency permits without an import, so the checker can't be certain and only warns.

Flipping undefined **calls** to errors is a possible fast follow-up, once the sweep confirms the JS-globals registry is complete enough. It is not part of this PR.

## Edge cases

- **`std::` imports.** Map to bundled stdlib files that exist and get loaded. They resolve cleanly. A typo'd `std::` path resolves to a non-existent file → `importModuleNotFound`, which is desirable.
- **Target file fails to parse.** `build` skips it, so `getFile` returns `undefined` → silent. The target's parse error surfaces on its own. No double-reporting.
- **Auto-injected `std::index` prelude.** Resolves to a real, loaded stdlib file; passes cleanly.

## Export-visibility asymmetry (named, not fixed)

The existing `export { } from` path enforces `export` visibility: it throws on a defined-but-not-`export`ed name (`symbolTable.ts:494`). This pass does **not** enforce that for plain imports. Net user-visible result:

- `import { x }` of a defined-but-not-exported `x` → **silent** (the name is present in the file's symbols, so the pass treats it as defined).
- `export { x } from` of the same `x` → **errors** (existing build behavior).

This inconsistency is defensible for now. Plain-import visibility enforcement would require consulting the `exported` flag in both `resolveImport` and this pass, and would widen the rollout sweep. It is called out here as a known asymmetry and a candidate follow-up, not a goal of this PR.

## Testing

Execution and unit coverage, no LLM calls:

- Missing name: a directory where `use.agency` imports a name `lib.agency` doesn't define → `importNameNotFound`, exit 1.
- Aliased missing name: `import { missingFn as m }` → error names `missingFn`.
- `import node { }` missing name → error.
- Missing relative module: `import { x } from "./nope.agency"` (no such file) → `importModuleNotFound`, exit 1.
- Missing `std::` module: `import { x } from "std::nosuchmodule"` → `importModuleNotFound`.
- Resolvable `pkg::` with a missing name (package installed, file lacks the name) → `importNameNotFound`. An *unresolvable* `pkg::` is out of scope — it throws in `build`.
- Silent when not loaded: check a single file whose imported target has a parse error → the target's parse error only, no `importNameNotFound` piled on.
- Valid imports (a real cross-file import and a real `std::` import) → no new errors.
- Unit tests for the symbol-table classification helper: resolved / module-missing / exists-but-not-loaded / loaded-but-name-absent.

## Rollout sweep

As a hard error with no opt-out, this can surface pre-existing bad imports. Before shipping:

1. Run `agency tc` across `stdlib/` and the test fixtures under `tests/`.
2. Fix genuine bad imports.
3. Diagnose any false positive and adjust the pass.

The plan lists this sweep as an explicit task with its findings recorded, so nothing is silently suppressed.

## Non-goals

- Converting the existing `export { } from` and `pkg::` build-time throws into clean diagnostics (separate follow-up).
- Flipping undefined function **calls** from warning to error (possible fast follow-up).
- Enforcing `export` visibility on plain imports (named asymmetry above).
- Checking `.js` import existence or exports.
