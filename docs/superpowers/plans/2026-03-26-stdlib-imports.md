# Standard Library Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Agency programs to import from a standard library shipped with the agency-lang npm package using the `std::` prefix (e.g., `import {foo} from "std::math"`).

**Architecture:** A new utility function `resolveAgencyImportPath` centralizes all import path resolution (relative and `std::` paths). Every place that resolves an import path — symbol table, import resolver, compile command, and builder — calls this one function. The stdlib `.agency` files ship as source in a `stdlib/` directory at the package root, included via the npm `files` field. The package root is found by walking up from the resolver's `__dirname` until `package.json` is found.

**Tech Stack:** Node.js `path`/`fs`, existing Agency parser and compilation pipeline, vitest for unit tests, Agency execution tests for integration.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/importPaths.ts` | Create | Central import path resolution: `resolveAgencyImportPath()` and `findPackageRoot()` |
| `lib/importPaths.test.ts` | Create | Unit tests for path resolution |
| `lib/symbolTable.ts` | Modify (lines 74-85) | Use `resolveAgencyImportPath` for path resolution |
| `lib/preprocessors/importResolver.ts` | Modify (line 35) | Use `resolveAgencyImportPath` for path resolution |
| `lib/cli/commands.ts` | Modify (lines 183-197) | Use `resolveAgencyImportPath` for recursive compilation + allow stdlib paths through `restrictImports` |
| `lib/backends/typescriptBuilder.ts` | Modify (lines 841-884) | Rewrite `std::` paths to absolute `.js` paths in generated imports |
| `package.json` | Modify (lines 36-38) | Add `"./stdlib"` to `files` array |
| `stdlib/` | Create (directory) | Standard library `.agency` files |
| `stdlib/math.agency` | Create | First stdlib module (a simple one to prove the pipeline works) |
| `tests/typescriptGenerator/stdlib-import.agency` | Create | Generator fixture for stdlib imports |
| `tests/typescriptGenerator/stdlib-import.mjs` | Create | Expected output fixture (generated via `make fixtures`) |
| `tests/agency/stdlib-import/main.agency` | Create | Execution test for stdlib import |
| `tests/agency/stdlib-import/main.test.json` | Create | Test cases for execution test |

---

### Task 1: Create the central path resolution utility

**Files:**
- Create: `lib/importPaths.ts`
- Create: `lib/importPaths.test.ts`

This is the core of the feature. One function that every part of the pipeline calls to resolve import paths.

- [ ] **Step 1: Write the failing test for `findPackageRoot`**

Create `lib/importPaths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findPackageRoot } from "./importPaths.js";
import * as path from "path";

describe("findPackageRoot", () => {
  it("should find the package root from a nested directory", () => {
    // __dirname is inside lib/, package root is one level up
    const root = findPackageRoot(__dirname);
    expect(root).toBe(path.resolve(__dirname, ".."));
    // Verify package.json exists there
    expect(
      require("fs").existsSync(path.join(root, "package.json")),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: FAIL — module `./importPaths.js` does not exist

- [ ] **Step 3: Write the failing test for `resolveAgencyImportPath`**

Add to `lib/importPaths.test.ts`:

```typescript
import { resolveAgencyImportPath } from "./importPaths.js";

describe("resolveAgencyImportPath", () => {
  it("should resolve relative imports against the importing file's directory", () => {
    const result = resolveAgencyImportPath(
      "./utils.agency",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.agency");
  });

  it("should resolve std:: imports to the stdlib directory", () => {
    const result = resolveAgencyImportPath(
      "std::math",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(path.join(root, "stdlib", "math.agency"));
  });

  it("should resolve std:: imports with subdirectories", () => {
    const result = resolveAgencyImportPath(
      "std::collections/queue",
      "/project/src/main.agency",
    );
    const root = findPackageRoot(__dirname);
    expect(result).toBe(
      path.join(root, "stdlib", "collections", "queue.agency"),
    );
  });

  it("should leave non-agency, non-std imports unchanged", () => {
    const result = resolveAgencyImportPath(
      "./utils.js",
      "/project/src/main.agency",
    );
    expect(result).toBe("/project/src/utils.js");
  });
});
```

- [ ] **Step 4: Implement `findPackageRoot` and `resolveAgencyImportPath`**

Create `lib/importPaths.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Walk up from startDir until we find a directory containing package.json.
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (!fs.existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not find package root (no package.json found)");
    }
    dir = parent;
  }
  return dir;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const STDLIB_DIR = path.join(PACKAGE_ROOT, "stdlib");

/**
 * Returns the absolute path to the stdlib directory.
 */
export function getStdlibDir(): string {
  return STDLIB_DIR;
}

/**
 * Returns true if the import path is a standard library import (starts with "std::").
 */
export function isStdlibImport(importPath: string): boolean {
  return importPath.startsWith("std::");
}

/**
 * Resolve an Agency import path to an absolute filesystem path.
 *
 * - "std::foo"       → <package-root>/stdlib/foo.agency
 * - "std::foo/bar"   → <package-root>/stdlib/foo/bar.agency
 * - "./foo.agency"   → resolved relative to the importing file
 * - "./foo.js"       → resolved relative to the importing file (non-agency, kept as-is)
 */
export function resolveAgencyImportPath(
  importPath: string,
  fromFile: string,
): string {
  if (isStdlibImport(importPath)) {
    const stdlibPath = importPath.slice(5); // strip "std::"
    return path.join(STDLIB_DIR, stdlibPath + ".agency");
  }
  // Relative or other imports: resolve against the importing file's directory
  return path.resolve(path.dirname(fromFile), importPath);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/importPaths.ts lib/importPaths.test.ts
git commit -m "feat: add central import path resolution with std:: support"
```

---

### Task 2: Create the stdlib directory and a starter module

**Files:**
- Create: `stdlib/math.agency`

A simple module to prove the pipeline works end-to-end. No LLM calls — pure logic only.

- [ ] **Step 1: Create `stdlib/math.agency`**

```agency
def add(a: number, b: number): number {
  return a + b
}

def subtract(a: number, b: number): number {
  return a - b
}

def multiply(a: number, b: number): number {
  return a * b
}
```

- [ ] **Step 2: Verify it parses**

Run: `pnpm run ast stdlib/math.agency`
Expected: JSON AST output with three `function` nodes

- [ ] **Step 3: Commit**

```bash
git add stdlib/math.agency
git commit -m "feat: add stdlib/math.agency as first standard library module"
```

---

### Task 3: Wire `resolveAgencyImportPath` into the symbol table

**Files:**
- Modify: `lib/symbolTable.ts:74-85`

The symbol table follows imports recursively. Currently it resolves paths with `path.resolve(dir, ...)`. We need it to also handle `std::` paths.

- [ ] **Step 1: Write a failing test**

Create a temporary test `.agency` file and a unit test that builds a symbol table from it, expecting stdlib symbols to be found. Add to `lib/importPaths.test.ts`:

```typescript
import { buildSymbolTable } from "./symbolTable.js";
import * as fs from "fs";
import * as os from "os";

describe("buildSymbolTable with std:: imports", () => {
  it("should resolve std:: imports and include their symbols", () => {
    // Create a temp file that imports from std::math
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-test-"));
    const tmpFile = path.join(tmpDir, "test.agency");
    fs.writeFileSync(
      tmpFile,
      'import { add } from "std::math"\nnode main() {\n  return add(1, 2)\n}\n',
    );

    const table = buildSymbolTable(tmpFile);
    const stdlibMathPath = path.join(getStdlibDir(), "math.agency");

    // The symbol table should contain entries for the stdlib file
    expect(table[stdlibMathPath]).toBeDefined();
    expect(table[stdlibMathPath]["add"]).toEqual({
      kind: "function",
      name: "add",
    });

    // Clean up
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: FAIL — `table[stdlibMathPath]` is undefined because `buildSymbolTable` doesn't know how to resolve `std::` paths

- [ ] **Step 3: Update `symbolTable.ts` to use `resolveAgencyImportPath`**

In `lib/symbolTable.ts`, add the import and modify the `visit` function's import-following logic:

```typescript
// Add at the top of the file:
import { resolveAgencyImportPath, isStdlibImport } from "./importPaths.js";
```

Replace lines 73-86 (the import-following section inside `visit`):

```typescript
    // Follow imports to other .agency files
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "importNodeStatement") {
        visit(resolveAgencyImportPath(node.agencyFile, absPath));
      } else if (node.type === "importToolStatement") {
        visit(resolveAgencyImportPath(node.agencyFile, absPath));
      } else if (
        node.type === "importStatement" &&
        (node.modulePath.endsWith(".agency") || isStdlibImport(node.modulePath))
      ) {
        visit(resolveAgencyImportPath(node.modulePath, absPath));
      }
    }
```

Note: the `isStdlibImport` check is needed because `std::math` doesn't end with `.agency`, but the resolved path does.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tests to check for regressions**

Run: `pnpm test:run`
Expected: All existing tests pass (relative imports still work the same)

- [ ] **Step 6: Commit**

```bash
git add lib/symbolTable.ts lib/importPaths.test.ts
git commit -m "feat: wire std:: path resolution into symbol table"
```

---

### Task 4: Wire `resolveAgencyImportPath` into the import resolver

**Files:**
- Modify: `lib/preprocessors/importResolver.ts:23,29,35`

The import resolver resolves `ImportStatement` nodes for `.agency` files into specialized `ImportNodeStatement`/`ImportToolStatement` nodes. It needs to handle `std::` paths.

- [ ] **Step 1: Update `resolveImports` to use `resolveAgencyImportPath`**

In `lib/preprocessors/importResolver.ts`:

```typescript
// Add at top:
import { resolveAgencyImportPath, isStdlibImport } from "../importPaths.js";
```

Change the filter condition on line 29 from:

```typescript
      !node.modulePath.endsWith(".agency")
```

to:

```typescript
      !node.modulePath.endsWith(".agency") && !isStdlibImport(node.modulePath)
```

Change line 35 from:

```typescript
    const importedFilePath = path.resolve(currentDir, node.modulePath);
```

to:

```typescript
    const importedFilePath = resolveAgencyImportPath(node.modulePath, currentFile);
```

- [ ] **Step 2: Run existing tests to check for regressions**

Run: `pnpm test:run`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add lib/preprocessors/importResolver.ts
git commit -m "feat: wire std:: path resolution into import resolver"
```

---

### Task 5: Wire `resolveAgencyImportPath` into the compile command

**Files:**
- Modify: `lib/cli/commands.ts:181-198`
- Modify: `lib/cli/util.ts:285-329`

The compile command extracts import paths and recursively compiles them. It also enforces `restrictImports`. We need to:
1. Resolve `std::` paths before compiling them.
2. Allow stdlib paths through the `restrictImports` check (they're outside the project dir but trusted).
3. Make sure `getImports` returns `std::` paths for stdlib imports.
4. Update `getImportsRecursively` to resolve `std::` paths (it currently uses `path.resolve(path.dirname(filename), imp)` which would produce incorrect paths like `/some/dir/std::math`).

- [ ] **Step 1: Update `getImports` in `lib/cli/util.ts`**

In `lib/cli/util.ts`, update the `getImports` function. The current filter on line 322-325 only includes `importStatement` nodes ending with `.agency`. We need to also include `std::` paths:

```typescript
// Add at top of file:
import { isStdlibImport, resolveAgencyImportPath } from "../importPaths.js";
```

Change lines 321-326 from:

```typescript
  const importStatements = program.nodes
    .filter(
      (node) =>
        node.type === "importStatement" && node.modulePath.endsWith(".agency"),
    )
    .map((node) => (node as ImportStatement).modulePath.trim());
```

to:

```typescript
  const importStatements = program.nodes
    .filter(
      (node) =>
        node.type === "importStatement" &&
        (node.modulePath.endsWith(".agency") || isStdlibImport(node.modulePath)),
    )
    .map((node) => (node as ImportStatement).modulePath.trim());
```

- [ ] **Step 2: Update `getImportsRecursively` in `lib/cli/util.ts`**

In `lib/cli/util.ts`, `getImportsRecursively` (lines 285-310) resolves import paths with `path.resolve(path.dirname(filename), imp)` on line 302. This produces broken paths for `std::` imports (e.g., `/some/dir/std::math`). Update it:

```typescript
// Import is already added at top in Step 1
import { resolveAgencyImportPath } from "../importPaths.js";
```

Change line 302 from:

```typescript
    const importedFile = path.resolve(path.dirname(filename), imp);
```

to:

```typescript
    const importedFile = resolveAgencyImportPath(imp, filename);
```

- [ ] **Step 3: Update the compile function in `lib/cli/commands.ts`**

In `lib/cli/commands.ts`, update the import resolution and compilation loop:

```typescript
// Add at top:
import { resolveAgencyImportPath, isStdlibImport } from "../importPaths.js";
```

Change lines 183-198 from:

```typescript
  const inputDir = path.dirname(absoluteInputFile);
  for (const importPath of imports) {
    const absPath = path.resolve(inputDir, importPath);
    if (config.restrictImports) {
      const projectRoot = process.cwd();
      if (
        !absPath.startsWith(projectRoot + path.sep) &&
        absPath !== projectRoot
      ) {
        throw new Error(
          `Import path '${importPath}' resolves to '${absPath}' which is outside the project directory '${projectRoot}'.`,
        );
      }
    }
    compile(config, absPath, undefined, { ...options, symbolTable });
  }
```

to:

```typescript
  for (const importPath of imports) {
    const absPath = resolveAgencyImportPath(importPath, absoluteInputFile);
    if (config.restrictImports && !isStdlibImport(importPath)) {
      const projectRoot = process.cwd();
      if (
        !absPath.startsWith(projectRoot + path.sep) &&
        absPath !== projectRoot
      ) {
        throw new Error(
          `Import path '${importPath}' resolves to '${absPath}' which is outside the project directory '${projectRoot}'.`,
        );
      }
    }
    compile(config, absPath, undefined, { ...options, symbolTable });
  }
```

Key changes:
- Use `resolveAgencyImportPath` instead of `path.resolve(inputDir, importPath)`.
- Skip `restrictImports` check for stdlib imports (they're trusted and always outside the project dir).

- [ ] **Step 4: Run existing tests to check for regressions**

Run: `pnpm test:run`
Expected: All existing tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/cli/commands.ts lib/cli/util.ts
git commit -m "feat: wire std:: path resolution into compile command"
```

---

### Task 6: Handle `std::` paths in the TypeScript builder's import codegen

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:841-884`

When the builder emits TypeScript `import` statements, it rewrites `.agency` → `.js`. For `std::` paths, we need to emit an absolute path to the compiled `.js` file in the stdlib directory, because a relative path from the user's project to the stdlib inside `node_modules` would be fragile and wrong.

- [ ] **Step 1: Add a helper to convert `std::` import paths to the compiled `.js` path**

In `lib/importPaths.ts`, add:

```typescript
/**
 * Convert an Agency import path to the path that should appear in generated
 * TypeScript import statements.
 *
 * - "std::foo"      → absolute path to <stdlib-dir>/foo.js
 * - "./foo.agency"  → "./foo.js" (relative, just extension swap)
 */
export function toCompiledImportPath(importPath: string): string {
  if (isStdlibImport(importPath)) {
    const stdlibPath = importPath.slice(5); // strip "std::"
    return path.join(STDLIB_DIR, stdlibPath + ".js");
  }
  return importPath.replace(/\.agency$/, ".js");
}
```

- [ ] **Step 2: Add a test for `toCompiledImportPath`**

In `lib/importPaths.test.ts`:

```typescript
import { toCompiledImportPath } from "./importPaths.js";

describe("toCompiledImportPath", () => {
  it("should convert std:: paths to absolute .js paths in stdlib dir", () => {
    const result = toCompiledImportPath("std::math");
    expect(result).toBe(path.join(getStdlibDir(), "math.js"));
  });

  it("should convert relative .agency paths to .js", () => {
    const result = toCompiledImportPath("./utils.agency");
    expect(result).toBe("./utils.js");
  });

  it("should handle std:: paths with subdirectories", () => {
    const result = toCompiledImportPath("std::collections/queue");
    expect(result).toBe(path.join(getStdlibDir(), "collections", "queue.js"));
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: PASS

- [ ] **Step 4: Update `processImportStatement` in the builder**

In `lib/backends/typescriptBuilder.ts`:

```typescript
// Add at top:
import { toCompiledImportPath } from "../importPaths.js";
```

Change line 842 from:

```typescript
    const from = node.modulePath.replace(/\.agency$/, ".js");
```

to:

```typescript
    const from = toCompiledImportPath(node.modulePath);
```

- [ ] **Step 5: Update `processImportToolStatement` in the builder**

Change line 883 from:

```typescript
      from: node.agencyFile.replace(/\.agency$/, ".js"),
```

to:

```typescript
      from: toCompiledImportPath(node.agencyFile),
```

- [ ] **Step 6: Update the `.agency` → `.js` rewriting in `commands.ts`**

In `lib/cli/commands.ts`, lines 200-205 rewrite `.agency` to `.js`/`.ts` in the AST before codegen. This also needs to handle `std::` paths. Change:

```typescript
  resolvedProgram.nodes.forEach((node) => {
    if (node.type === "importStatement") {
      node.modulePath = node.modulePath.replace(".agency", ext);
    }
  });
```

to:

```typescript
  resolvedProgram.nodes.forEach((node) => {
    if (node.type === "importStatement" && !isStdlibImport(node.modulePath)) {
      node.modulePath = node.modulePath.replace(".agency", ext);
    }
  });
```

The `std::` paths are handled by `toCompiledImportPath` in the builder, so we skip them here.

- [ ] **Step 7: Run existing tests to check for regressions**

Run: `pnpm test:run`
Expected: All existing tests pass

- [ ] **Step 8: Commit**

```bash
git add lib/importPaths.ts lib/importPaths.test.ts lib/backends/typescriptBuilder.ts lib/cli/commands.ts
git commit -m "feat: emit correct import paths for std:: modules in generated TypeScript"
```

---

### Task 7: Update `package.json` to ship the stdlib

**Files:**
- Modify: `package.json:36-38`

- [ ] **Step 1: Add `"./stdlib"` to the `files` array**

Change:

```json
  "files": [
    "./dist",
    "./scripts/hooks/postinstall.js"
  ],
```

to:

```json
  "files": [
    "./dist",
    "./stdlib",
    "./scripts/hooks/postinstall.js"
  ],
```

- [ ] **Step 2: Verify it would be included in the package**

Run: `npm pack --dry-run 2>&1 | grep stdlib`
Expected: Should list `stdlib/math.agency` in the output

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: include stdlib directory in npm package"
```

---

### Task 8: Add a unit test for `std::` import code generation

**Files:**
- Modify: `lib/importPaths.test.ts`

The generator integration fixtures (`tests/typescriptGenerator/`) compare generated TypeScript output as exact strings. Since `std::` imports produce absolute filesystem paths (e.g., `/Users/alice/node_modules/agency-lang/stdlib/math.js`), a fixture `.mjs` file would be machine-dependent and break on CI or other machines. Instead, we test the code generation behavior through unit tests on `toCompiledImportPath` (already done in Task 6) and verify the full pipeline via the execution test in Task 9.

- [ ] **Step 1: Add a unit test confirming the generated import path structure**

In `lib/importPaths.test.ts`, add:

```typescript
describe("std:: import code generation", () => {
  it("generated import path should point to a .js file inside the stdlib dir", () => {
    const result = toCompiledImportPath("std::math");
    // Must be an absolute path ending with stdlib/math.js
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toMatch(/stdlib[/\\]math\.js$/);
    // The stdlib dir should exist
    expect(fs.existsSync(path.dirname(result))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test:run -- lib/importPaths.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add lib/importPaths.test.ts
git commit -m "test: add unit test for std:: import code generation"
```

---

### Task 9: Add an Agency execution test for `std::` imports

**Files:**
- Create: `tests/agency/stdlib-import/main.agency`
- Create: `tests/agency/stdlib-import/main.test.json`

This is an end-to-end test: parse → compile → execute. It uses `std::math` without any LLM calls.

- [ ] **Step 1: Create `tests/agency/stdlib-import/main.agency`**

```agency
import { add, multiply } from "std::math"

node testStdlibAdd() {
  return add(3, 4)
}

node testStdlibMultiply() {
  return multiply(5, 6)
}
```

- [ ] **Step 2: Create `tests/agency/stdlib-import/main.test.json`**

```json
{
  "sourceFile": "main.agency",
  "tests": [
    {
      "nodeName": "testStdlibAdd",
      "input": "",
      "expectedOutput": "7",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Should add 3 + 4 using std::math"
    },
    {
      "nodeName": "testStdlibMultiply",
      "input": "",
      "expectedOutput": "30",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "Should multiply 5 * 6 using std::math"
    }
  ]
}
```

- [ ] **Step 3: Build**

Run: `make all`
Expected: Builds successfully

- [ ] **Step 4: Run the execution test**

Run: `pnpm run agency test tests/agency/stdlib-import`
Expected: Both tests pass with exact match

- [ ] **Step 5: Commit**

```bash
git add tests/agency/stdlib-import/
git commit -m "test: add end-to-end execution test for std:: imports"
```
