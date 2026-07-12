# Strict Imports Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agency` error when a plain import names something that doesn't exist — a name a loaded Agency file doesn't define, or a module path that resolves to no file.

**Architecture:** Add a `resolveImportModule` helper to `SymbolTable` that classifies an import's target as missing / not-loaded / loaded. Add a new typechecker pass `checkMissingImports` that walks the file's `import { ... }` and `import node { ... }` statements, uses that helper plus a per-name presence check, and emits two new hard-error diagnostics. Wire the pass into the typechecker beside `checkUndefinedFunctions`.

**Tech Stack:** TypeScript, vitest (unit), the Node integration harness (`tests/integration/cli-main/test.mjs`).

## Global Constraints

- NEVER commit to `main`. All work happens on branch `worktree-strict-imports-check` in the worktree at `/Users/adityabhargava/agency-lang/.claude/worktrees/strict-imports-check`. Re-check `git branch --show-current` before every commit.
- NEVER use dynamic imports. Use types, not interfaces. Use arrays, not sets. Use objects, not maps.
- All non-absolute paths below are relative to `packages/agency-lang/`.
- **Scope:** plain imports only — `import { ... }` (with `isAgencyImport === true`) and `import node { ... }`. Skip JavaScript imports (`isAgencyImport === false`), `export { } from` (already throws in `SymbolTable.build`), and unresolvable `pkg::` (already throws in `build`). See the spec's "What is already handled" section.
- **Severity:** both new diagnostics are always errors. No config knob. Do not touch `undefinedFunctions`.
- **Safeguard:** never error when the target file exists on disk but was not loaded into the symbol table (`getFile` returns `undefined`). That is a partial-view case (a parse failure in the target, or a single-file editor check), and the target's own error is the real diagnostic.
- Reference: design spec at `docs/superpowers/specs/2026-07-12-strict-imports-check-design.md`.

---

### Task 1: `SymbolTable.resolveImportModule` classifier

Add a method that resolves an import's module path and reports whether it is missing, exists-but-not-loaded, or loaded (with its symbols). This is the single place that touches the filesystem and path resolution, so the pass in Task 2 stays pure logic.

**Files:**
- Modify: `lib/symbolTable.ts` (add a type + method near the existing `getFile`, around line 246)
- Test: `lib/symbolTable.importModule.test.ts` (create)

**Interfaces:**
- Produces:
  - `type ImportModuleResolution = { kind: "missing" } | { kind: "notLoaded" } | { kind: "loaded"; symbols: FileSymbols }`
  - `SymbolTable.resolveImportModule(modulePath: string, fromFile: string, config?: AgencyConfig): ImportModuleResolution`

- [ ] **Step 1: Write the failing unit test**

Create `lib/symbolTable.importModule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SymbolTable } from "./symbolTable.js";

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-immod-"));
  for (const [name, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  return dir;
}

describe("SymbolTable.resolveImportModule", () => {
  it("returns loaded with symbols for a crawled Agency file", () => {
    const dir = makeDir({
      "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
      "use.agency": 'import { realFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    const result = table.resolveImportModule("./lib.agency", usePath);
    expect(result.kind).toBe("loaded");
    if (result.kind === "loaded") {
      expect(Object.prototype.hasOwnProperty.call(result.symbols, "realFn")).toBe(true);
    }
  });

  it("returns missing for a module path that does not exist", () => {
    const dir = makeDir({
      "use.agency": 'import { x } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("./ghost.agency", usePath).kind).toBe("missing");
  });

  it("returns notLoaded for a file that exists on disk but was never crawled", () => {
    const dir = makeDir({
      "use.agency": 'node u(): string {\n  return "y"\n}\n',
      "other.agency": "export def helper(): string {\n  return \"h\"\n}\n",
    });
    const usePath = path.join(dir, "use.agency");
    // build seeded from use.agency, which imports nothing → other.agency is
    // never loaded, though it exists on disk.
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("./other.agency", usePath).kind).toBe("notLoaded");
  });

  it("returns missing when path resolution throws (unresolvable pkg::)", () => {
    const dir = makeDir({
      "use.agency": 'node u(): string {\n  return "y"\n}\n',
    });
    const usePath = path.join(dir, "use.agency");
    const table = SymbolTable.build(usePath);
    expect(table.resolveImportModule("pkg::@no/such-package", usePath).kind).toBe("missing");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/symbolTable.importModule.test.ts`
Expected: FAIL — `resolveImportModule` is not a function.

- [ ] **Step 3: Implement the classifier**

In `lib/symbolTable.ts`, immediately after the `getFile` method (ends at line 248), insert:

```ts
  /**
   * Classify an import's target module for the strict-imports check.
   * - `missing`   — the path resolves to nothing on disk, or resolution threw
   *                 (e.g. an unresolvable `pkg::`).
   * - `notLoaded` — the file exists on disk but was never crawled into this
   *                 table (a parse failure in it, or a partial single-file
   *                 check). The caller must stay silent: the view is incomplete.
   * - `loaded`    — the file was crawled; `symbols` is its FileSymbols.
   */
  resolveImportModule(
    modulePath: string,
    fromFile: string,
    config?: AgencyConfig,
  ): ImportModuleResolution {
    let resolved: string;
    try {
      resolved = path.resolve(resolveAgencyImportPath(modulePath, fromFile));
    } catch (e) {
      // An unresolvable `pkg::` throwing is the EXPECTED path here, so we
      // report it as `missing` rather than crashing. But don't swallow the
      // error entirely: an unexpected resolution bug (malformed path, internal
      // fault) would otherwise be silently mislabelled "Cannot find module".
      // Surface it under verbose, matching how `build` logs.
      if (config?.verbose) {
        console.error(`[resolveImportModule] '${modulePath}' failed to resolve:`, e);
      }
      return { kind: "missing" };
    }
    if (!fs.existsSync(resolved)) {
      return { kind: "missing" };
    }
    const symbols = this.getFile(resolved);
    if (symbols === undefined) {
      return { kind: "notLoaded" };
    }
    return { kind: "loaded", symbols };
  }
```

`AgencyConfig` is already imported at the top of `lib/symbolTable.ts` (line 4). Then add the result type. Place it next to the exported `FileSymbols` type near the top of the file (right after the `FileSymbols` definition at line 100):

```ts
export type ImportModuleResolution =
  | { kind: "missing" }
  | { kind: "notLoaded" }
  | { kind: "loaded"; symbols: FileSymbols };
```

`path`, `fs`, and `resolveAgencyImportPath` are already imported in this file (used by `build`). Do not add duplicate imports.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/symbolTable.importModule.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/symbolTable.ts lib/symbolTable.importModule.test.ts
git commit -m "Add SymbolTable.resolveImportModule classifier for strict imports"
```

---

### Task 2: `checkMissingImports` pass + diagnostics + wiring

Add the two error diagnostics, the pass that emits them, and register it in the typechecker. Test the behavior end-to-end through `typeCheck` on temp multi-file fixtures.

**Files:**
- Modify: `lib/typeChecker/diagnostics.ts` (add two registry entries near `undefinedFunction`, line 434)
- Create: `lib/typeChecker/missingImportDiagnostic.ts`
- Modify: `lib/typeChecker/index.ts` (import + call the pass near line 337)
- Test: `lib/typeChecker/missingImportDiagnostic.test.ts` (create)

**Interfaces:**
- Consumes: `SymbolTable.resolveImportModule` from Task 1; `diagnostic` from `./diagnostics.js`; `TypeCheckerContext` from `./types.js`; `SourceLocation` from `../types/base.js`. The pass reads the AST field `node.isAgencyImport` directly (no helper import needed).
- Produces: `checkMissingImports(ctx: TypeCheckerContext): void`.

- [ ] **Step 1: Write the failing test**

Create `lib/typeChecker/missingImportDiagnostic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(files: Record<string, string>, entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-miss-"));
  try {
    for (const [name, src] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), src);
    }
    const entryPath = path.join(dir, entry);
    const src = files[entry];
    const parsed = parseAgency(src);
    if (!parsed.success) {
      throw new Error(`parse failed: ${(parsed as { message?: string }).message}`);
    }
    const symbols = SymbolTable.build(entryPath);
    const info = buildCompilationUnit(parsed.result, symbols, entryPath, src);
    return typeCheck(parsed.result, {}, info).errors;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkMissingImports", () => {
  it("errors on a name the target file does not define", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { missingFn } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importNameNotFound");
    expect(e).toBeDefined();
    expect(e?.message).toContain("missingFn");
  });

  it("names the original name for an aliased import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { missingFn as m } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importNameNotFound");
    expect(e?.message).toContain("missingFn");
  });

  it("errors on a missing node import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import node { ghostNode } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeDefined();
  });

  it("errors on a module path that does not exist", () => {
    const errors = check(
      {
        "use.agency": 'import { x } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    const e = errors.find((err) => err.name === "importModuleNotFound");
    expect(e).toBeDefined();
    expect(e?.message).toContain("./ghost.agency");
  });

  it("stays silent when the target exists but failed to load (parse error)", () => {
    // This test depends on `broken.agency` failing to parse, so `build` skips
    // it and `getFile` returns undefined → `notLoaded` → silent. The dependency
    // is on the parser: if the parser ever accepts this body, the target would
    // load and the test would turn RED (name absent → error), not falsely green.
    // So the coupling is safe — it can only over-report, never miss a real bug.
    const errors = check(
      {
        "broken.agency": "def def def { { { <<< not valid agency\n",
        "use.agency": 'import { anything } from "./broken.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a real cross-file import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { realFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("ignores JavaScript imports", () => {
    // The `if (!node.isAgencyImport)` guard is load-bearing: the checker can't
    // read a .js file's exports. Remove the guard and this .js import gets flagged.
    const errors = check(
      {
        "use.agency": 'import { anything } from "./helper.js"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a valid node import", () => {
    // Positive counterpart to the missing-node test: guards that nodes are
    // looked up in the right place (FileSymbols keyed by node name).
    const errors = check(
      {
        "lib.agency": "export node helperNode(): string {\n  return \"n\"\n}\n",
        "use.agency": 'import node { helperNode } from "./lib.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("reports only the missing name in a mixed import", () => {
    const errors = check(
      {
        "lib.agency": "export def realFn(): string {\n  return \"x\"\n}\n",
        "use.agency": 'import { realFn, missingFn } from "./lib.agency"\n\nnode u(): string {\n  return realFn()\n}\n',
      },
      "use.agency",
    );
    const nameErrors = errors.filter((err) => err.name === "importNameNotFound");
    expect(nameErrors).toHaveLength(1);
    expect(nameErrors[0].message).toContain("missingFn");
    expect(nameErrors[0].message).not.toContain("realFn");
  });

  it("reports exactly one module error for a multi-name missing module", () => {
    const errors = check(
      {
        "use.agency": 'import { a, b } from "./ghost.agency"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.filter((err) => err.name === "importModuleNotFound")).toHaveLength(1);
  });

  it("accepts an import of a re-exported name", () => {
    // Relies on mergeExportsFrom merging `deep` into barrel.agency's FileSymbols
    // during build. A regression in the merge would false-positive here.
    const errors = check(
      {
        "real.agency": "export def deep(): string {\n  return \"d\"\n}\n",
        "barrel.agency": 'export { deep } from "./real.agency"\n',
        "use.agency": 'import { deep } from "./barrel.agency"\n\nnode u(): string {\n  return deep()\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });

  it("accepts a valid std:: import", () => {
    // std:: resolves through a different branch of resolveAgencyImportPath.
    // `bash` is a real export of std::shell (verified). We only assert the
    // absence of import diagnostics, so any unrelated marker warning is ignored.
    const errors = check(
      {
        "use.agency": 'import { bash } from "std::shell"\n\nnode u(): string {\n  return "y"\n}\n',
      },
      "use.agency",
    );
    expect(errors.find((err) => err.name === "importNameNotFound")).toBeUndefined();
    expect(errors.find((err) => err.name === "importModuleNotFound")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/typeChecker/missingImportDiagnostic.test.ts`
Expected: FAIL — no `importNameNotFound` / `importModuleNotFound` diagnostics exist yet.

- [ ] **Step 3: Add the two diagnostics**

In `lib/typeChecker/diagnostics.ts`, immediately after the `undefinedFunction` entry (ends at line 438), insert:

```ts
  importNameNotFound: {
    code: "AG4008",
    severity: "error",
    message: "'{name}' is not defined in '{module}'.",
  },
  importModuleNotFound: {
    code: "AG4009",
    severity: "error",
    message: "Cannot find module '{module}'.",
  },
```

`DiagnosticName` is `keyof typeof DIAGNOSTICS`, so these codes become usable by `diagnostic(...)` automatically. AG4008 and AG4009 are unused (the AG40xx range currently stops at AG4007).

- [ ] **Step 4: Write the pass**

Create `lib/typeChecker/missingImportDiagnostic.ts`:

```ts
import { diagnostic } from "./diagnostics.js";
import type { TypeCheckerContext } from "./types.js";
import type { SourceLocation } from "../types/base.js";
import type { AgencyNode } from "../types.js";

/** A plain Agency import, normalized so the checker doesn't care which node
 *  kind it came from. */
type ImportSpec = {
  modulePath: string;
  names: readonly string[];
  loc: SourceLocation | null;
};

/**
 * The "what": which plain Agency imports to check, and the names each brings in.
 * Returns null for anything out of scope (JS imports, non-import nodes). Keeps
 * the per-node-kind field access (the "how") in one place.
 */
function toImportSpec(node: AgencyNode): ImportSpec | null {
  if (node.type === "importStatement" && node.isAgencyImport) {
    const names = node.importedNames
      .filter((nameType) => nameType.type === "namedImport")
      .flatMap((nameType) => nameType.importedNames);
    return { modulePath: node.modulePath, names, loc: node.loc ?? null };
  }
  if (node.type === "importNodeStatement") {
    return { modulePath: node.agencyFile, names: node.importedNodes, loc: node.loc ?? null };
  }
  return null;
}

/**
 * Error on plain imports that don't resolve to a real export:
 *   - a name a loaded Agency file doesn't define  → importNameNotFound
 *   - a module path that resolves to no file       → importModuleNotFound
 *
 * Covers `import { ... }` (Agency only) and `import node { ... }`. Skips JS
 * imports, `export { } from`, and unresolvable `pkg::` (the latter two already
 * throw in SymbolTable.build). Stays silent when the target exists but wasn't
 * loaded — that is a partial view, and the target's own error is the real one.
 */
export function checkMissingImports(ctx: TypeCheckerContext): void {
  const { symbolTable, currentFile } = ctx;
  if (!symbolTable || !currentFile) return;

  for (const node of ctx.programNodes) {
    const spec = toImportSpec(node);
    if (!spec) continue;

    const resolution = symbolTable.resolveImportModule(
      spec.modulePath,
      currentFile,
      ctx.config,
    );
    if (resolution.kind === "missing") {
      // One module error per statement, not one per imported name.
      ctx.errors.push(diagnostic("importModuleNotFound", { module: spec.modulePath }, spec.loc));
      continue;
    }
    if (resolution.kind === "notLoaded") {
      continue;
    }
    for (const name of spec.names) {
      if (!Object.prototype.hasOwnProperty.call(resolution.symbols, name)) {
        ctx.errors.push(
          diagnostic("importNameNotFound", { name, module: spec.modulePath }, spec.loc),
        );
      }
    }
  }
}
```

`AgencyNode` is the top-level node union (`../types.js`). `ctx.config` is the `AgencyConfig` already carried by the checker context (used e.g. by `checkUndefinedFunctions`).

- [ ] **Step 5: Wire the pass into the typechecker**

In `lib/typeChecker/index.ts`, add the import next to the other pass imports (near line 51):

```ts
import { checkMissingImports } from "./missingImportDiagnostic.js";
```

Then, immediately after the `checkUndefinedFunctions(scopes, ctx);` call (line 337), add:

```ts
    // Error on plain imports that don't resolve to a real export.
    checkMissingImports(ctx);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/typeChecker/missingImportDiagnostic.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 7: Run the broader typechecker unit tests for regressions**

Run: `pnpm exec vitest run lib/typeChecker/`
Expected: PASS. If any existing typechecker test now fails because a fixture imports a name that a loaded file doesn't define, that is a real find — fix the fixture's import. If a failure is a false positive from the new pass, stop and diagnose before continuing (do not weaken the pass to make a test pass without understanding why).

- [ ] **Step 8: Commit**

```bash
git add lib/typeChecker/diagnostics.ts lib/typeChecker/missingImportDiagnostic.ts lib/typeChecker/index.ts lib/typeChecker/missingImportDiagnostic.test.ts
git commit -m "Add checkMissingImports pass: error on imports that don't resolve"
```

---

### Task 3: Rollout sweep + CLI integration test

Build the CLI, run the new check across the stdlib and the `.agency` fixtures to surface pre-existing bad imports, fix genuine violations, and add one end-to-end integration case proving `agency tc` exits non-zero.

**Files:**
- Modify: `tests/integration/cli-main/test.mjs` (add a case in the `// tc` section)
- Modify: any `stdlib/*.agency` or `tests/**/*.agency` files with genuinely bad imports found by the sweep (unknown in advance)

- [ ] **Step 1: Build the CLI**

```bash
make
```

Expected: exit 0. (`make` is required after changing any stdlib or lib file.)

- [ ] **Step 2: Sweep the stdlib and the whole test tree**

Because this builds on #525's directory typecheck, `agency tc` accepts a directory and checks every `.agency` under it. Sweep the stdlib and the *entire* `tests/` tree in one pass each — a whole-tree sweep is what exercises the highest-risk resolution paths (`pkg::` under `tests/pkg-imports`, plus `tests/agency`, `tests/agency-js`, `tests/typescriptGenerator`, `tests/typescriptPreprocessor`, and every other fixture):

```bash
pnpm run agency tc stdlib > /tmp/sweep-stdlib.log 2>&1; echo "stdlib exit: $?"
pnpm run agency tc tests   > /tmp/sweep-tests.log  2>&1; echo "tests exit: $?"
```

Read both logs. For each `AG4008` (name not defined) or `AG4009` (cannot find module):
- If it's a genuine bad import (a typo, a renamed export, a stale path) → fix the importing `.agency` file.
- If it's a false positive → STOP. Diagnose why `resolveImportModule` misclassified it (a resolution corner such as a re-export, a `std::`/`pkg::` path, or a load-order issue). Record the case and adjust `resolveImportModule` or the pass, then re-run. Do not suppress it blindly.
- Some fixtures import from non-existent modules on purpose (to exercise error paths) or fail to parse. A parse-failing target lands in `notLoaded` (silent), so it won't show up. A genuinely-bad-but-intentional import that IS flagged should be pointed at a real file, unless a test consciously asserts a different error on it — record that decision per file.

Record the findings (counts per log, files touched, any pass adjustment) in the commit message for this task. Note: the full `pnpm test:run` suite is not run locally (repo rule) — CI runs it — so the whole-tree sweep here is the local safety net for fixtures that would otherwise only surface in CI.

- [ ] **Step 3: Rebuild after any stdlib fix**

```bash
make
```

Expected: exit 0. (Skip only if Step 2 changed no stdlib file.)

- [ ] **Step 4: Write the failing integration test**

In `tests/integration/cli-main/test.mjs`, find the `// tc` section (the block that runs `tc` cases) and add, immediately after the last `tc` case in that section:

```ts
  // tc: a directory where a file imports a name its target does not define (#438 follow-up)
  const tcBadImportDir = join(dir, "tc-bad-import");
  mkdirSync(tcBadImportDir, { recursive: true });
  writeFileSync(
    join(tcBadImportDir, "lib.agency"),
    `export def realFn(): string {
  return "x"
}
`,
  );
  writeFileSync(
    join(tcBadImportDir, "use.agency"),
    `import { missingFn } from "./lib.agency"

node u(): string {
  return "y"
}
`,
  );
  const tcBadImportOut = stripAnsi(
    runAgency("28e-tc-missing-import", ["tc", "tc-bad-import"], { expectFail: true }),
  );
  assertIncludes(tcBadImportOut, "AG4008");
  assertIncludes(tcBadImportOut, "missingFn");
```

(The `28a`–`28d` cases from #525 sit just above in the `// tc` section, and `29-bundle` is already taken; `28e` keeps this in the `tc` series without colliding. `stripAnsi`, `assertIncludes`, `mkdirSync`, `writeFileSync`, `join`, and `runAgency` are already available in this harness.)

- [ ] **Step 5: Pack and run the integration harness**

```bash
npm pack && node tests/integration/cli-main/test.mjs ./agency-lang-*.tgz > /tmp/integration.log 2>&1; echo "exit: $?"
```

Expected: exit 0 (all cases pass, including the new `28e-tc-missing-import`). The `expectFail: true` case confirms `agency tc` exits non-zero on a bad import.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/cli-main/test.mjs stdlib tests
git commit -m "Sweep stdlib+fixtures for bad imports; add tc integration case (strict imports)"
```

(Only `git add` the stdlib/tests paths that the sweep actually changed. If the sweep changed nothing there, add just `tests/integration/cli-main/test.mjs`.)

---

### Task 4: Documentation

Document that Agency imports must resolve to a real export, and note the two new error codes.

**Files:**
- Modify: `docs/site/cli/typecheck.md`

- [ ] **Step 1: Add a note to the typecheck CLI page**

Open `docs/site/cli/typecheck.md`. After the existing options/description content, add a new section:

```markdown
## Imports must resolve

The type checker verifies that every Agency import names something real. Two mistakes are hard errors:

- `AG4008` — the target file exists but does not define the imported name (for example, `import { missingFn } from "./lib.agency"` when `lib.agency` has no `missingFn`).
- `AG4009` — the import path resolves to no file (for example, a typo in `import { x } from "./libb.agency"`).

Unlike a call to an undefined function (a warning that might be an uncatalogued JavaScript global), an unresolved Agency import is unambiguous, so it always errors.

Import checking needs a file path to resolve relative imports against, so it is skipped when input comes from stdin without a path (`agency tc -`). Pass files or a directory to have imports checked.
```

- [ ] **Step 2: Commit**

```bash
git add docs/site/cli/typecheck.md
git commit -m "docs: document strict-import errors AG4008/AG4009"
```

---

## Self-Review

**Spec coverage:**
- Missing name (loaded file lacks the name) → Task 2 (`importNameNotFound`), tests in Task 2 Step 1. ✓
- Missing module (relative/`std::` path resolves to no file) → Task 2 (`importModuleNotFound`); classifier in Task 1. ✓
- Aliased imports check the original name → Task 2 pass (uses `nameType.importedNames`, not aliases) + test. ✓
- `import node { }` covered → Task 2 pass + test. ✓
- Silent when not loaded (parse failure / partial view) → Task 1 (`notLoaded`) + Task 2 pass + "stays silent" test. ✓
- `try/catch` around resolution in the core flow → Task 1 `resolveImportModule` + `pkg::` unit test. ✓
- Always error, no config knob → Task 2 registry entries (severity `error`, no override). ✓
- Skips JS imports, `export from`, unresolvable `pkg::` → Task 2 `toImportSpec` (`isAgencyImport` guard; only `importStatement`/`importNodeStatement` normalized) + "ignores JavaScript imports" test + Global Constraints. ✓
- One module error per statement (not per name) → Task 2 pass structure + "exactly one module error for a multi-name missing module" test. ✓
- Positive cases guarded (valid cross-file, valid node import, re-exported name, `std::` import, mixed valid+invalid) → Task 2 tests. ✓
- Unexpected resolution throw not masked → Task 1 verbose-gated log in the catch (finding 6). ✓
- Rollout sweep over stdlib + the whole `tests/` tree (includes `tests/pkg-imports`, the highest-risk path) → Task 3 Step 2. ✓
- Export-visibility asymmetry (non-goal) → not implemented; presence check ignores the `exported` flag (Task 2 uses `hasOwnProperty` on symbols). ✓
- Docs → Task 4. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. The sweep (Task 3) is investigative by nature, but its steps give exact commands and an explicit decision rule for each finding. ✓

**Type consistency:** `ImportModuleResolution` (`missing` / `notLoaded` / `loaded` + `symbols`) is produced in Task 1 and consumed unchanged in Task 2's `checkMissingImports` loop. `resolveImportModule(modulePath, fromFile, config?)` and `checkMissingImports(ctx)` are named identically across tasks; the pass passes `ctx.config` as the third argument. The `toImportSpec` normalizer's `{ modulePath, names, loc }` shape is consumed only within the same function. Diagnostic names `importNameNotFound` / `importModuleNotFound` match between the registry (Task 2 Step 3), the pass (Task 2 Step 4), and the tests. ✓
