# Review: strict-imports-check implementation plan

**Reviews:** `docs/superpowers/plans/2026-07-12-strict-imports-check.md`

**Date:** 2026-07-12

**Verdict:** Strong, plan-ready with one fix. It cleanly incorporated the spec review (scope narrowed to plain imports; `export from` and unresolvable `pkg::` excluded because they already throw in `build`; the `pkg::` throw folded into a `try/catch`; the hard-error decision now carries a rationale). Every load-bearing code claim was verified against the source. One medium finding on sweep scope, two low findings on test coverage/cosmetics; otherwise correct.

## Verification (all confirmed against code)

- `TypeCheckerContext` has `programNodes` (`types.ts:89`), `errors` (98), `symbolTable?` (125), `currentFile?` (130). The pass uses exactly these.
- `diagnostic(name, params, loc, overrides?)` (`diagnostics.ts:563`) returns `TypeCheckError` with `.name` set to the registry key — so the tests' `err.name === "importNameNotFound"` works. `renderMessage` interpolates `{name}`-style placeholders (`diagnostics.ts:543`); the plan's `{name}`/`{module}` params match.
- Wiring point: `checkUndefinedFunctions(scopes, ctx)` at `index.ts:337`; `ctx.programNodes = this.program.nodes` (127), `ctx.currentFile = resolved.fromFile` (107). Inserting the call after 337 is correct.
- AST: `importStatement.isAgencyImport`/`importedNames` (`importStatement.ts:5,7`); `namedImport.importedNames` holds the **original** names, aliases kept separately in `.aliases` (18, 24) — so pushing `...nameType.importedNames` checks the original name, matching the spec and the alias test. `importNodeStatement.agencyFile`/`importedNodes` (55–56).
- Node symbols are stored in `FileSymbols` keyed by node name (`classifySymbols`, `symbolTable.ts:361`), so the `import node` presence check via `hasOwnProperty` is sound.
- Re-exports are merged into the re-exporter's `FileSymbols` during `build` (`mergeExportsFrom`), so `import { x }` where the target re-exports `x` won't false-positive.
- `AG4008`/`AG4009` are unused; the classifier's `try/catch` correctly maps a `resolvePkgAgencyPath` throw to `missing`.

## Findings

### 1. [Medium] The rollout sweep is scoped too narrowly — it skips the highest-risk path

Task 3 sweeps only `stdlib`, `tests/agency`, and `tests/typescriptGenerator`. It omits `tests/pkg-imports` — and `pkg::` resolution is the exact path the spec calls out as highest-risk (it can throw, which the classifier turns into `importModuleNotFound`). It also omits `tests/agency-js`, `tests/typescriptPreprocessor`, and any other `.agency` under `tests/`. Consequences:

- A false-positive class in `pkg::` handling (e.g. a package that resolves in CI's context but is classified `missing` during the sweep, or vice versa) would go undiscovered by the very sweep the spec designed to catch it.
- Any now-erroring import in an un-swept fixture surfaces only in CI (the full suite can't be run locally per the repo rules), not during the sweep.

This feature builds directly on #525's directory typecheck, so the sweep can simply be `pnpm run agency tc tests` (whole tree) plus `pnpm run agency tc stdlib`, instead of two hand-picked subdirs. At minimum add `tests/pkg-imports`. Note that a whole-tree sweep will hit intentionally-broken fixtures — but those parse-fail to `notLoaded` (silent) or already assert errors, and the plan's per-finding decision rule already handles the noise. Recommend broadening Step 2–3 and recording the wider sweep's findings.

### 2. [Low] No positive test for a valid `import node { }` or a valid re-exported import

The `import node` test only asserts the negative (`ghostNode` absent → error). Correctness for a *valid* node import depends on the non-obvious fact that nodes live in `FileSymbols` keyed by name — verified here, but unguarded by a test. Likewise there's no test that `import { x }` of a name the target **re-exports** stays clean (also verified, also unguarded). Add one positive `import node { realNode }` case and one re-exported-name case so a future refactor of symbol storage or the merge path can't silently regress into false positives.

### 3. [Low/cosmetic] Integration-test case number collides with existing `29-bundle`

Task 3 Step 5 labels the new case `29-tc-missing-import`, but `29-bundle` already exists in `test.mjs` (and #525 added `28a`–`28d`). Labels are distinct strings so nothing breaks, but the numbering is misleading. Use the next genuinely free number and keep it in the `// tc` section.

## Anti-pattern check (`docs/dev/anti-patterns.md`)

Overall the plan's architecture already does the declarative-encapsulation the catalog asks for: `resolveImportModule` hides all the "how" (path resolution, the `fs` check, the `pkg::` throw) behind the flat tagged union `ImportModuleResolution`, and `reportModule` consumes it declaratively by dispatching on `.kind`. That is the good pattern. Three localized lapses:

### 4. [Low-Medium — "Imperative code everywhere"] the name-collection loop

Task 2, Step 4 uses a mutable accumulator + for-loop + `push`, which is almost line-for-line the catalog's *Bad* example:

```ts
const names: string[] = [];
for (const nameType of node.importedNames) {
  if (nameType.type !== "namedImport") continue;
  names.push(...nameType.importedNames);
}
```

Declarative equivalent — says *what* ("the original names of the named imports"):

```ts
const names = node.importedNames
  .filter((nameType) => nameType.type === "namedImport")
  .flatMap((nameType) => nameType.importedNames);
```

### 5. [Low — encapsulate the imperative extraction] duplicated AST-shape knowledge across the two `reportModule` call sites

`checkMissingImports` pulls `(modulePath, names, loc)` out of `importStatement` and `importNodeStatement` in two separate branches. Splitting the *what* (which imports to check) from the *how* (per-node-kind field access) via a small normalizer removes the duplication and folds in finding 4:

```ts
type ImportSpec = { modulePath: string; names: readonly string[]; loc: SourceLocation | null };

function toImportSpec(node: AgencyNode): ImportSpec | null {
  if (node.type === "importStatement" && node.isAgencyImport) {
    const names = node.importedNames
      .filter((n) => n.type === "namedImport")
      .flatMap((n) => n.importedNames);
    return { modulePath: node.modulePath, names, loc: node.loc ?? null };
  }
  if (node.type === "importNodeStatement") {
    return { modulePath: node.agencyFile, names: node.importedNodes, loc: node.loc ?? null };
  }
  return null;
}

// checkMissingImports body:
for (const node of ctx.programNodes) {
  const spec = toImportSpec(node);
  if (spec) reportModule(ctx, spec, currentFile);
}
```

Optional — two branches isn't egregious and YAGNI applies — but it's the one spot where the pass *doesn't yet* encapsulate the imperative bit behind a declarative interface, and it easily could.

### 6. [Medium — "try-catch without logging anything in the catch block"] the empty catch in `resolveImportModule`

Task 1, Step 3:

```ts
try {
  resolved = path.resolve(resolveAgencyImportPath(modulePath, fromFile));
} catch {
  return { kind: "missing" };
}
```

No binding, no log. Beyond tripping the listed anti-pattern, it collapses *every* throw to `"missing"`, so an **unexpected** resolution error (a malformed path, an internal `resolveAgencyImportPath` bug) is silently reported to the user as "Cannot find module" instead of its real cause.

The fix is not a blind `console.error` — an unresolvable `pkg::` throwing is the *expected* path, and logging every such case would be noise. Gate it under verbose, matching how `SymbolTable.build` already logs:

```ts
} catch (e) {
  if (config?.verbose) console.error(`[resolveImportModule] ${modulePath} failed to resolve:`, e);
  return { kind: "missing" };
}
```

This means threading `config` into the method (or capturing it on the `SymbolTable` instance) — worth a line in the plan either way.

### Rest of the catalog: clean

No duplicated code (it reuses `resolveAgencyImportPath`/`getFile`), no order-dependent mutable state, no leaky nested-object types (the tagged union is exemplary), no useless special cases, no nested ternaries, no magic numbers, no dynamic requires. The `ctx.errors.push(...)` mutation and the guard-clause one-liners (`if (!x) return;`) technically brush the "one-line if" entry, but they match the prevailing style in `checkUndefinedFunctions` and the symbol table — matching them beats the catalog's generic example, since "Inconsistent patterns" is itself an anti-pattern.

## Test review — do the tests fail when the code breaks?

Mostly yes, but two tests are weaker than they look and one behavior is unguarded. (Diagnostic-name assertions like `err.name === "importNameNotFound"` are valid — `diagnostic()` sets `.name` to the registry key.)

**Genuinely guard their target:** Task 1 Tests 1–3 (each asserts a distinct `.kind`); Task 1 Test 4 (`pkg::`) — **verified** that `findPkgDir` re-throws `MODULE_NOT_FOUND` for `@no/such-package` (`importPaths.ts:408`), so deleting the `catch` makes `resolveImportModule` throw and the test fails; Task 2 Tests 1/2/4/6 (assert specific diagnostic name + message; Test 2 specifically guards "check the *original* name, not the alias"); Task 3 integration (`expectFail` + `AG4008` + `missingFn`).

**Weaker than they look:**

7. **[Medium] Task 2 Test 3 (missing node import) is green even if node handling is entirely broken.** It only asserts that an *absent* node name errors. If the pass looked nodes up in the wrong place and never matched any node, this test still passes — while every *valid* `import node { realNode }` would false-positive. It can't distinguish "correctly rejects a missing node" from "rejects all nodes." Needs the positive counterpart (missing test #2 below).

8. **[Low] Task 2 Test 5 (silent on parse failure) is coupled to the parser.** It relies on `"def def def not valid agency"` failing to parse so `broken.agency` stays unloaded. The failure mode is *safe* (a lenient parse turns it red, not falsely green), but it's brittle — add a comment noting the dependency, or use a more obviously-unparseable body.

## Missing test cases

Ranked by regression risk:

1. **[High] JS import is skipped.** The `if (!node.isAgencyImport) continue` guard is load-bearing — remove it and every `.js` import gets flagged. Nothing tests it:
   ```ts
   it("ignores JavaScript imports", () => {
     const errors = check(
       { "use.agency": 'import { anything } from "./helper.js"\n\nnode u(): string {\n  return "y"\n}\n' },
       "use.agency",
     );
     expect(errors.find((e) => e.name === "importNameNotFound")).toBeUndefined();
     expect(errors.find((e) => e.name === "importModuleNotFound")).toBeUndefined();
   });
   ```

2. **[High] A *valid* node import passes cleanly** — the positive case Test 3 lacks. Only this catches a broken node-symbol lookup:
   ```ts
   it("accepts a valid node import", () => {
     const errors = check(
       {
         "lib.agency": "export node helperNode(): string {\n  return \"n\"\n}\n",
         "use.agency": 'import node { helperNode } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
       },
       "use.agency",
     );
     expect(errors.find((e) => e.name === "importNameNotFound")).toBeUndefined();
   });
   ```
   (Confirm the `export node` syntax against a fixture; adjust if nodes aren't `export`-marked that way.)

3. **[Medium] Mixed valid + invalid names in one statement.** `import { realFn, missingFn }` → exactly one `importNameNotFound` naming `missingFn`, with `realFn` untouched. Guards per-name reporting and no collateral flagging.

4. **[Medium] A multi-name missing *module* yields exactly one error.** The plan explicitly claims "one module error per statement, not per name," but no test asserts the count. `import { a, b } from "./ghost.agency"` → assert exactly one `importModuleNotFound`.

5. **[Medium] A valid re-exported import passes.** The pass relies on re-exports being merged into the target's `FileSymbols`. `import { x }` from a file that does `export { x } from "./real.agency"` should be clean; a regression in the merge would false-positive, and nothing guards it.

6. **[Low-Med] A valid `std::` import passes.** `std::` resolves through a different branch; one positive case guards it beyond the rollout sweep.

**Coverage-boundary note:** every Task 2 test routes through `check()`, whose fidelity depends on `SymbolTable.build(entryPath)` crawling the entry's imports so the target ends up `loaded`. These are therefore integration tests of build+typeCheck, not unit tests of the pass in isolation — a `notLoaded` false-positive from the pass could only be caught by Test 5's specific parse-failure setup. Acceptable given the codebase style; just know the boundary.

## Minor notes (no action required)

- The pass no-ops when `ctx.currentFile` is absent, so `agency tc -` (stdin, no path anchor) skips import checking. That's an acceptable limitation and matches the spec, but worth a one-line mention in the docs or a code comment.
- `reportModule` re-reads `ctx.symbolTable!` with a non-null assertion; safe because `checkMissingImports` guards it, and the plan says so. Fine as-is.

## Bottom line

Fix finding 1 (broaden the sweep — it's the difference between the rollout catching a `pkg::` false-positive class and shipping one) and finding 6 (the empty catch masks unexpected errors). Findings 2–3 are cheap test/cosmetic adds; 4–5 are declarative-style cleanups the catalog calls for (4 is a near-exact match of its *Bad* example). Findings 7–8 flag two weak existing tests, and the six missing test cases above should be added before implementation is called done — especially the two [High] ones (JS-import-skipped and a valid node import), which guard load-bearing behavior nothing currently covers. No correctness defects found in the pass, diagnostics, or wiring.
