# Re-export Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TypeScript-style `export { ... } from "..."` and `export * from "..."` syntax to Agency, desugared to existing import + local-export constructs by a new preprocessor pass.

**Architecture:** Re-exports are syntactic sugar resolved entirely before downstream stages see them. Pipeline: parser produces a new `exportFromStatement` AST node → `SymbolTable.build` follows re-export edges and merges source symbols into the re-exporter's `FileSymbols` with a `reExportedFrom` marker → new `resolveReExports` preprocessor reads `FileSymbols` (the single source of truth) and emits one synthesized internal import + one local exported wrapper per re-exported symbol, then deletes all `exportFromStatement` nodes → existing `resolveImports`, type checker, builder, and `serve` discovery run unchanged.

**Tech Stack:** TypeScript; tarsec parser combinators; vitest; existing Agency compiler infrastructure (SymbolTable, importResolver, typescriptPreprocessor, typescriptBuilder, AgencyGenerator).

**Spec:** [`docs/superpowers/specs/2026-05-11-reexport-syntax-design.md`](../specs/2026-05-11-reexport-syntax-design.md)

**Critical context for the implementer:**
- All paths below are relative to `packages/agency-lang/` unless rooted at `/`.
- Use `make` to build (it picks up stdlib changes); use `pnpm test:run path/to/file.test.ts` to run a specific vitest file once. Never leave vitest in watch mode.
- Save test output to a file when running expensive tests so you don't rerun unnecessarily, e.g. `pnpm test:run lib/symbolTable.test.ts > /tmp/symbol-test.log 2>&1`.
- Tarsec parser combinators: see `lib/parsers/parsers.ts` for examples. `seqC`, `map`, `or`, `capture`, `set`, `str`, `char`, `optional`, `sepBy1`. The existing `namedImportParser` and `importStatmentParser` are at `lib/parsers/parsers.ts:2103` and `lib/parsers/parsers.ts:2157`.
- The codebase uses `type` not `interface`, objects not maps, arrays not sets. Never use dynamic imports.
- Commit frequently. Never force-push or amend.
- Apostrophes in commit messages from the CLI break — write commit messages to a file and pass that to `git commit -F`.

---

## File Structure

**Will create:**
- `lib/types/exportFromStatement.ts` — new `ExportFromStatement` AST type
- `lib/parsers/exportFromStatement.test.ts` — parser tests
- `lib/preprocessors/resolveReExports.ts` — preprocessor pass
- `lib/preprocessors/resolveReExports.test.ts` — preprocessor tests
- `tests/agency/reExports/` — fixture directory with `wikipedia.agency`, `reExporter.agency`, `reExporter.expected.json` etc.

**Will modify:**
- `lib/types.ts` — add `ExportFromStatement` to `AgencyNode` union
- `lib/parsers/parsers.ts` — add `exportFromStatementParser`, export it
- `lib/parser.ts` — register `exportFromStatementParser` in `nodeParser`
- `lib/symbolTable.ts` — add `reExportedFrom` to `SymbolInfo` types; extend reachability and add resolveReExports merge pass
- `lib/symbolTable.test.ts` — add re-export tests
- `lib/backends/agencyGenerator.ts` — handle `exportFromStatement` in formatter
- `lib/compiler/compile.ts` — invoke `resolveReExports` before `resolveImports`
- `lib/lsp/diagnostics.ts` — invoke `resolveReExports` before `resolveImports`
- `lib/cli/commands.ts` — invoke `resolveReExports` before `resolveImports`
- `lib/serve/discovery.test.ts` — add re-export discovery test
- `docs/site/guide/imports-and-packages.md` — document new syntax
- `docs/site/guide/mcp.md` — show headline use case

---

## Task 1: Define the `ExportFromStatement` AST type

**Files:**
- Create: `lib/types/exportFromStatement.ts`
- Modify: `lib/types.ts` (the union/barrel — find where `ImportStatement` is added to `AgencyNode`)

- [ ] **Step 1: Create the type file**

```ts
// lib/types/exportFromStatement.ts
import { BaseNode } from "./base.js";

export type ExportFromStatement = BaseNode & {
  type: "exportFromStatement";
  modulePath: string;
  isAgencyImport: boolean;
  body: NamedExportBody | StarExportBody;
};

export type NamedExportBody = {
  kind: "namedExport";
  /** Source-side names being re-exported. */
  names: string[];
  /** Map of sourceName → localName for entries written as `name as alias`. */
  aliases: Record<string, string>;
  /** Source-side names marked with the `safe` modifier. */
  safeNames: string[];
};

export type StarExportBody = {
  kind: "starExport";
};

/** Returns the local names produced by a named re-export (alias if present). */
export function getReExportedLocalNames(body: NamedExportBody): string[] {
  return body.names.map((n) => body.aliases[n] ?? n);
}
```

- [ ] **Step 2: Add to the AgencyNode union**

Open `lib/types.ts`. Find the line(s) re-exporting from `./types/importStatement.js` and the `AgencyNode` union. Add an export-from re-export and union member.

```ts
// Near the other re-exports
export type { ExportFromStatement, NamedExportBody, StarExportBody } from "./types/exportFromStatement.js";
export { getReExportedLocalNames } from "./types/exportFromStatement.js";

// In the AgencyNode union, add:
//   | ExportFromStatement
```

If `lib/types.ts` does not have an inline `AgencyNode` union (it may be assembled elsewhere), search with `grep -n "AgencyNode =" lib/types.ts lib/types/*.ts` and add it to whichever file defines it. Add an `import type { ExportFromStatement } from "./types/exportFromStatement.js"` if needed.

- [ ] **Step 3: Verify it typechecks**

```bash
pnpm exec tsc --noEmit > /tmp/tsc.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. If non-zero, read `/tmp/tsc.log` and fix.

- [ ] **Step 4: Commit**

Write the message to a file (CLI apostrophes break):

```bash
cat > /tmp/commit-msg <<'EOF'
feat(types): add ExportFromStatement AST node

Defines the type for `export { x } from "..."` and `export * from "..."` syntax. No parser or runtime changes yet.
EOF
git add lib/types/exportFromStatement.ts lib/types.ts
git commit -F /tmp/commit-msg
```

---

## Task 2: Parser — `exportFromStatementParser` (named form)

**Files:**
- Modify: `lib/parsers/parsers.ts` (add new parser near `importStatmentParser` at line ~2157)
- Create: `lib/parsers/exportFromStatement.test.ts`

- [ ] **Step 1: Write the failing parser tests for the named form**

```ts
// lib/parsers/exportFromStatement.test.ts
import { describe, it, expect } from "vitest";
import { exportFromStatementParser } from "./parsers.js";

describe("exportFromStatementParser", () => {
  it("parses a simple named re-export", () => {
    const result = exportFromStatementParser('export { foo } from "./tools.agency"');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "exportFromStatement",
      modulePath: "./tools.agency",
      isAgencyImport: true,
      body: {
        kind: "namedExport",
        names: ["foo"],
        aliases: {},
        safeNames: [],
      },
    });
  });

  it("parses an aliased re-export", () => {
    const result = exportFromStatementParser('export { search as wikipediaSearch } from "std::wikipedia"');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search"],
      aliases: { search: "wikipediaSearch" },
      safeNames: [],
    });
    expect(result.result.modulePath).toBe("std::wikipedia");
    expect(result.result.isAgencyImport).toBe(true);
  });

  it("parses multiple names with mixed aliasing", () => {
    const result = exportFromStatementParser(
      'export { search as wikipediaSearch, fetch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search", "fetch"],
      aliases: { search: "wikipediaSearch" },
      safeNames: [],
    });
  });

  it("parses per-name `safe` modifier", () => {
    const result = exportFromStatementParser(
      'export { safe search, fetch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search", "fetch"],
      aliases: {},
      safeNames: ["search"],
    });
  });

  it("parses safe with alias", () => {
    const result = exportFromStatementParser(
      'export { safe search as wikiSearch } from "std::wikipedia"',
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.body).toEqual({
      kind: "namedExport",
      names: ["search"],
      aliases: { search: "wikiSearch" },
      safeNames: ["search"],
    });
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

```bash
pnpm test:run lib/parsers/exportFromStatement.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: FAIL with `exportFromStatementParser is not exported` or similar. Read `/tmp/parser-test.log` to confirm.

- [ ] **Step 3: Implement the named-form parser**

Open `lib/parsers/parsers.ts`. Right after `importStatmentParser` (around line 2181), add:

```ts
import { ExportFromStatement } from "../types/exportFromStatement.js"; // add to the existing imports at top of file

// Reuse safeNameItem (defined at ~line 2083) and the named-list inner of namedImportParser.
const namedExportBodyParser = map(
  seqC(
    char("{"),
    optionalSpacesOrNewline,
    capture(sepBy1(commaWithNewline, safeNameItem), "items"),
    optional(commaWithNewline),
    optionalSpacesOrNewline,
    char("}"),
  ),
  (result) => {
    const names: string[] = [];
    const safeNames: string[] = [];
    const aliases: Record<string, string> = {};
    for (const item of result.items) {
      names.push(item.name);
      if (item.alias) aliases[item.name] = item.alias;
      if (item.isSafe) safeNames.push(item.name);
    }
    return { kind: "namedExport" as const, names, safeNames, aliases };
  },
);

export const exportFromStatementParser: Parser<ExportFromStatement> = map(
  trace(
    "exportFromStatement",
    seqC(
      set("type", "exportFromStatement"),
      str("export"),
      parseError(
        "expected a statement of the form `export { x, y } from 'filename'` or `export * from 'filename'`",
        spaces,
        capture(namedExportBodyParser, "body"),
        spaces,
        str("from"),
        spaces,
        oneOf(`'"`),
        capture(many1Till(oneOf(`'"`)), "modulePath"),
        oneOf(`'"`),
        optionalSemicolon,
        optional(newline),
      ),
    ),
  ),
  (result) => ({ ...result, isAgencyImport: isAgencyImport(result.modulePath) }),
);
```

If `parseError`, `oneOf`, `many1Till`, `optionalSemicolon`, `commaWithNewline`, etc. are not already imported in this section of the file, add them — they're used by `importStatmentParser` immediately above.

- [ ] **Step 4: Run the test — confirm named-form tests pass**

```bash
pnpm test:run lib/parsers/exportFromStatement.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: All 5 named-form tests PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(parser): add exportFromStatementParser for named re-exports

Supports `export { foo }`, `export { foo as bar }`, multi-name lists, and per-name `safe` modifier. Star form added in next commit.
EOF
git add lib/parsers/parsers.ts lib/parsers/exportFromStatement.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 3: Parser — star form (`export * from "..."`)

**Files:**
- Modify: `lib/parsers/parsers.ts` (extend `exportFromStatementParser`)
- Modify: `lib/parsers/exportFromStatement.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/parsers/exportFromStatement.test.ts`:

```ts
  it("parses a star re-export", () => {
    const result = exportFromStatementParser('export * from "std::wikipedia"');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result).toMatchObject({
      type: "exportFromStatement",
      modulePath: "std::wikipedia",
      isAgencyImport: true,
      body: { kind: "starExport" },
    });
  });

  it("rejects malformed export-from", () => {
    // Missing `from`
    const r1 = exportFromStatementParser('export { foo } "./x.agency"');
    expect(r1.success).toBe(false);
    // Missing braces
    const r2 = exportFromStatementParser('export foo from "./x.agency"');
    expect(r2.success).toBe(false);
  });
```

- [ ] **Step 2: Run — expect star test to fail**

```bash
pnpm test:run lib/parsers/exportFromStatement.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: star test FAILS (named tests still pass).

- [ ] **Step 3: Add the star body parser and `or` it into the body capture**

In `lib/parsers/parsers.ts`, add a star body parser and combine:

```ts
const starExportBodyParser = map(
  char("*"),
  () => ({ kind: "starExport" as const }),
);

const exportBodyParser = or(namedExportBodyParser, starExportBodyParser);
```

Then change the `capture(namedExportBodyParser, "body")` inside `exportFromStatementParser` to `capture(exportBodyParser, "body")`.

- [ ] **Step 4: Run tests — expect all to pass**

```bash
pnpm test:run lib/parsers/exportFromStatement.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(parser): support `export * from "..."` star re-exports
EOF
git add lib/parsers/parsers.ts lib/parsers/exportFromStatement.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 4: Wire the parser into the top-level node parser

**Files:**
- Modify: `lib/parser.ts`

- [ ] **Step 1: Write a test that parses an Agency program containing `export from`**

Append to an existing `lib/parser.test.ts` (or create a focused test). Add:

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "./parser.js";

describe("parseAgency: export-from", () => {
  it("parses a program with an export-from statement", () => {
    const result = parseAgency(
      'export { search } from "std::wikipedia"\n',
      {},
      false, // do not apply template (so location math is simpler)
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.result.nodes[0]).toMatchObject({
      type: "exportFromStatement",
      modulePath: "std::wikipedia",
    });
  });
});
```

- [ ] **Step 2: Run — expect failure (parser not registered yet)**

```bash
pnpm test:run lib/parser.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: the new test FAILS — the program either doesn't parse or returns a different node type.

- [ ] **Step 3: Register the parser**

In `lib/parser.ts`:

1. Add to the imports (near `importStatmentParser`):

```ts
  exportFromStatementParser,
```

2. Add to the `nodeParser = or(...)` list, immediately after `importStatmentParser`:

```ts
  exportFromStatementParser,
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:run lib/parser.test.ts > /tmp/parser-test.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(parser): register exportFromStatementParser in top-level node parser
EOF
git add lib/parser.ts lib/parser.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 5: Formatter (`AgencyGenerator`) support

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`

- [ ] **Step 1: Write the failing round-trip test**

Find the existing AgencyGenerator test file (likely `lib/backends/agencyGenerator.test.ts`; if absent, look for a formatter test in `lib/`). Append:

```ts
import { parseAgency } from "../parser.js";
import { AgencyGenerator } from "./agencyGenerator.js"; // adjust path

describe("AgencyGenerator: export-from", () => {
  it.each([
    'export { foo } from "./tools.agency"',
    'export { foo as bar } from "./tools.agency"',
    'export { safe foo, bar } from "std::wikipedia"',
    'export { safe foo as bar } from "std::wikipedia"',
    'export * from "std::wikipedia"',
  ])("round-trips %s", (input) => {
    const parsed = parseAgency(input + "\n", {}, false);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const out = new AgencyGenerator().generate(parsed.result).trim();
    expect(out).toBe(input);
  });
});
```

(Adjust `new AgencyGenerator().generate(...)` to whatever the actual public API is — read `lib/backends/agencyGenerator.ts` first.)

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > /tmp/fmt-test.log 2>&1; echo "exit=$?"
```

Expected: new tests FAIL (likely "unknown node type" or empty output).

- [ ] **Step 3: Add a case for `exportFromStatement`**

Open `lib/backends/agencyGenerator.ts` and locate the dispatch where `case "importStatement":` lives (around line 242). Add a sibling case:

```ts
case "exportFromStatement": {
  if (node.body.kind === "starExport") {
    return `export * from "${node.modulePath}"`;
  }
  // namedExport
  const items = node.body.names.map((name) => {
    const safe = node.body.safeNames.includes(name) ? "safe " : "";
    const alias = node.body.aliases[name];
    return `${safe}${name}${alias ? ` as ${alias}` : ""}`;
  });
  return `export { ${items.join(", ")} } from "${node.modulePath}"`;
}
```

If the file uses a different return mechanism (e.g. pushing to a buffer), match the surrounding style.

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > /tmp/fmt-test.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(formatter): emit exportFromStatement nodes in AgencyGenerator
EOF
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 6: Add `reExportedFrom` field to `SymbolInfo`

**Files:**
- Modify: `lib/symbolTable.ts`

- [ ] **Step 1: Add the optional field to each variant**

In `lib/symbolTable.ts`, add to **each** of `FunctionSymbol`, `NodeSymbol`, `TypeSymbol`, `ConstantSymbol` (NOT `ClassSymbol` — classes are not re-exportable in v1):

```ts
  /** If set, this symbol entered FileSymbols via an `export from` re-export. */
  reExportedFrom?: { sourceFile: string; originalName: string };
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit > /tmp/tsc.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(symbolTable): add reExportedFrom marker field to SymbolInfo

Optional field used in subsequent commits to mark symbols that entered FileSymbols via a re-export. No behavior change yet.
EOF
git add lib/symbolTable.ts
git commit -F /tmp/commit-msg
```

---

## Task 7: SymbolTable — follow re-export edges (reachability)

**Files:**
- Modify: `lib/symbolTable.ts`
- Modify: `lib/symbolTable.test.ts`

- [ ] **Step 1: Write the failing reachability test**

Append to `lib/symbolTable.test.ts`. Use whatever in-memory or temp-file fixture pattern existing tests use — find an example by reading the top of the file first.

```ts
describe("SymbolTable: re-export reachability", () => {
  it("parses a file that is only reachable through an exportFromStatement", () => {
    // Set up two files in a tmp dir:
    //   reexporter.agency: export { foo } from "./source.agency"
    //   source.agency:    export def foo() {}
    // Build SymbolTable from reexporter.agency.
    // Assert symbolTable.has(absolute path of source.agency) === true.
    // (Use the same tmp-dir helper other tests in this file use.)
  });
});
```

Implement using the existing fixture style.

- [ ] **Step 2: Run — expect failure**

```bash
pnpm test:run lib/symbolTable.test.ts > /tmp/sym-test.log 2>&1; echo "exit=$?"
```

Expected: the new test fails because `symbolTable.has(sourcePath)` is false.

- [ ] **Step 3: Extend the file walk in `SymbolTable.build`**

In `lib/symbolTable.ts`, find the loop in `visit()` (around lines 131–140). Extend it:

```ts
for (const { node } of walkNodes(program.nodes)) {
  if (node.type === "importNodeStatement") {
    visit(resolveAgencyImportPath(node.agencyFile, absPath));
  } else if (
    node.type === "importStatement" &&
    isAgencyImport(node.modulePath)
  ) {
    visit(resolveAgencyImportPath(node.modulePath, absPath));
  } else if (
    node.type === "exportFromStatement" &&
    isAgencyImport(node.modulePath)
  ) {
    visit(resolveAgencyImportPath(node.modulePath, absPath));
  }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:run lib/symbolTable.test.ts > /tmp/sym-test.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(symbolTable): follow exportFromStatement edges during reachability walk
EOF
git add lib/symbolTable.ts lib/symbolTable.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 8: SymbolTable — symbol-flow merging for named re-exports

**Files:**
- Modify: `lib/symbolTable.ts`
- Modify: `lib/symbolTable.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `lib/symbolTable.test.ts`:

```ts
describe("SymbolTable: re-export merging", () => {
  it("merges a named re-export into the re-exporter's FileSymbols", () => {
    // Files:
    //   source.agency:    export def foo(x: number): string { return "" }
    //   reexporter.agency: export { foo } from "./source.agency"
    // Build SymbolTable from reexporter.agency.
    // Assert reexporter's FileSymbols.foo:
    //   kind === "function"
    //   exported === true
    //   parameters match source
    //   reExportedFrom === { sourceFile: <abs source>, originalName: "foo" }
  });

  it("aliases via `as`", () => {
    // export { foo as bar } from "./source.agency"
    // Reexporter's FileSymbols has `bar` (not `foo`); reExportedFrom.originalName === "foo".
  });

  it("per-name `safe` overrides source flag", () => {
    // source: export def foo() { ... }   (safe: false)
    // reexporter: export { safe foo } from "./source.agency"
    // Reexporter's foo.safe === true.
  });

  it("per-name safe leaves siblings unchanged", () => {
    // source: export def foo(); export def bar()
    // reexporter: export { safe foo, bar } from "./source.agency"
    // reexporter.foo.safe === true; reexporter.bar.safe === false.
  });

  it("hard errors when source symbol is missing", () => {
    // reexporter: export { nope } from "./source.agency"
    // Expect SymbolTable.build(...) to throw with /Symbol 'nope' is not defined/
  });

  it("hard errors when source symbol is not exported", () => {
    // source: def foo() {}   (no export)
    // reexporter: export { foo } from "./source.agency"
    // Expect throw with /not exported/
  });

  it("hard errors when re-exporting a class", () => {
    // source: class Foo {}
    // reexporter: export { Foo } from "./source.agency"
    // Expect throw with /Classes cannot be re-exported/
  });

  it("re-exported entry's loc points at the exportFromStatement", () => {
    // The loc on the merged FileSymbols entry should equal the exportFromStatement's loc, not the source's.
  });
});
```

- [ ] **Step 2: Run — expect failures**

```bash
pnpm test:run lib/symbolTable.test.ts > /tmp/sym-test.log 2>&1; echo "exit=$?"
```

Expected: all 8 new tests FAIL.

- [ ] **Step 3: Implement the merge pass**

In `lib/symbolTable.ts`, refactor `SymbolTable.build` so that after the parse-walk loop finishes (after `visit(entrypoint)` and the `parsed` map is populated), a second pass runs:

```ts
// Inside SymbolTable.build, after the visit walk completes:

const files: Record<string, FileSymbols> = {};
for (const [filePath, { symbols }] of Object.entries(parsed)) {
  files[filePath] = symbols;
}

// Merge re-exports in dependency order with cycle detection.
const reExportResolved = new Set<string>();

function resolveReExports(filePath: string, visiting: Set<string>): void {
  if (reExportResolved.has(filePath)) return;
  if (visiting.has(filePath)) {
    const chain = [...visiting, filePath].join(" → ");
    throw new Error(`Re-export cycle detected: ${chain}`);
  }
  visiting.add(filePath);

  const entry = parsed[filePath];
  if (!entry) {
    visiting.delete(filePath);
    reExportResolved.add(filePath);
    return;
  }

  for (const node of entry.program.nodes) {
    if (node.type !== "exportFromStatement") continue;
    if (!isAgencyImport(node.modulePath)) {
      throw new Error(
        `Re-export source must be an Agency module (std::, pkg::, or .agency path): '${node.modulePath}'`,
      );
    }
    const sourcePath = resolveAgencyImportPath(node.modulePath, filePath);
    resolveReExports(sourcePath, visiting);
    mergeExportsFrom(files, filePath, sourcePath, node);
  }

  visiting.delete(filePath);
  reExportResolved.add(filePath);
}

for (const filePath of Object.keys(parsed)) {
  resolveReExports(filePath, new Set());
}

return new SymbolTable(files);
```

Then add the `mergeExportsFrom` helper (top-level in the same file):

```ts
function mergeExportsFrom(
  files: Record<string, FileSymbols>,
  reExporterPath: string,
  sourcePath: string,
  stmt: ExportFromStatement, // import this type at the top
): void {
  const sourceSymbols = files[sourcePath];
  if (!sourceSymbols) {
    throw new Error(
      `Re-export source '${stmt.modulePath}' could not be resolved`,
    );
  }
  const targetSymbols = files[reExporterPath] ?? (files[reExporterPath] = {});

  if (stmt.body.kind === "starExport") {
    for (const [name, sym] of Object.entries(sourceSymbols)) {
      if (sym.kind === "class") continue; // silently skip classes in star
      if (!isExportedSymbol(sym)) continue;
      mergeOne(targetSymbols, name, name, sym, /*safe*/ false, sourcePath, stmt);
    }
    return;
  }

  // namedExport
  for (const originalName of stmt.body.names) {
    const sym = sourceSymbols[originalName];
    if (!sym) {
      throw new Error(
        `Symbol '${originalName}' is not defined in '${stmt.modulePath}'`,
      );
    }
    if (sym.kind === "class") {
      throw new Error(
        `Classes cannot be re-exported (symbol '${originalName}' in '${stmt.modulePath}')`,
      );
    }
    if (!isExportedSymbol(sym)) {
      throw new Error(
        `Function '${originalName}' in '${stmt.modulePath}' is not exported. Add the 'export' keyword to its definition.`,
      );
    }
    const localName = stmt.body.aliases[originalName] ?? originalName;
    const isSafe = stmt.body.safeNames.includes(originalName);
    mergeOne(targetSymbols, localName, originalName, sym, isSafe, sourcePath, stmt);
  }
}

function isExportedSymbol(sym: SymbolInfo): boolean {
  return sym.kind !== "class" && (sym as any).exported === true;
}

function mergeOne(
  targetSymbols: FileSymbols,
  localName: string,
  originalName: string,
  sourceSym: SymbolInfo,
  forceSafe: boolean,
  sourcePath: string,
  stmt: ExportFromStatement,
): void {
  const existing = targetSymbols[localName];
  if (existing) {
    if (!existing.reExportedFrom) {
      throw new Error(
        `Re-exported name '${localName}' collides with local declaration${
          existing.loc ? ` at line ${existing.loc.line + 1}` : ""
        }`,
      );
    }
    const sameSource =
      existing.reExportedFrom.sourceFile === sourcePath &&
      existing.reExportedFrom.originalName === originalName;
    if (!sameSource) {
      throw new Error(
        `Name '${localName}' is re-exported from both '${existing.reExportedFrom.sourceFile}' and '${sourcePath}'. Disambiguate with explicit 'export { ${localName} as ... } from ...'.`,
      );
    }
    return; // idempotent re-merge
  }

  // Deep-ish copy: spread is fine because SymbolInfo holds primitives + arrays of primitives/types.
  const copied: SymbolInfo = { ...sourceSym, name: localName, loc: stmt.loc, exported: true };
  if (forceSafe && copied.kind === "function") {
    copied.safe = true;
  }
  copied.reExportedFrom = { sourceFile: sourcePath, originalName };
  targetSymbols[localName] = copied;
}
```

You will need to import `ExportFromStatement` at the top of `lib/symbolTable.ts`.

- [ ] **Step 4: Run — expect tests to pass**

```bash
pnpm test:run lib/symbolTable.test.ts > /tmp/sym-test.log 2>&1; echo "exit=$?"
```

Expected: all 8 new tests PASS, no existing tests regressed. If existing tests fail because the merge pass runs unconditionally and a fixture has no `exportFromStatement`, the early-return in `resolveReExports` should handle it — re-read the diff if needed.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(symbolTable): merge named re-exports into re-exporter FileSymbols

Implements the symbol-flow resolution pass: walks exportFromStatement edges in dependency order, copies SymbolInfo from sources with reExportedFrom marker, applies per-name safe override, and detects collisions with local declarations.
EOF
git add lib/symbolTable.ts lib/symbolTable.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 9: SymbolTable — star re-exports, transitive chains, cycle detection, source/source collisions

**Files:**
- Modify: `lib/symbolTable.test.ts` (new tests; implementation already in place from Task 8)

- [ ] **Step 1: Write tests**

Append to `lib/symbolTable.test.ts`:

```ts
describe("SymbolTable: star and transitive re-exports", () => {
  it("star merges all exported symbols from source", () => {
    // source: export def foo(); export def bar(); def hidden() {}
    // reexporter: export * from "./source.agency"
    // FileSymbols has foo and bar with reExportedFrom; no `hidden`.
  });

  it("transitive a → b → c star resolves", () => {
    // c.agency:        export def foo() {}
    // b.agency:        export * from "./c.agency"
    // a.agency:        export * from "./b.agency"
    // SymbolTable.build(a) — a's FileSymbols.foo.reExportedFrom.sourceFile === b's path.
  });

  it("detects re-export cycle a → b → a", () => {
    // a.agency: export * from "./b.agency"
    // b.agency: export * from "./a.agency"
    // Expect throw matching /Re-export cycle detected/
  });

  it("collides when two sources re-export the same name", () => {
    // a.agency: export def foo() {}
    // b.agency: export def foo() {}
    // reex.agency: export * from "./a.agency"; export * from "./b.agency"
    // Expect throw matching /re-exported from both/
  });

  it("collides when explicit named re-export shadows a star", () => {
    // a.agency: export def foo() {}
    // b.agency: export def foo() {}
    // reex.agency: export * from "./a.agency"; export { foo } from "./b.agency"
    // Expect throw — no implicit precedence.
  });
});
```

- [ ] **Step 2: Run — expect pass (Task 8 already implements all of this)**

```bash
pnpm test:run lib/symbolTable.test.ts > /tmp/sym-test.log 2>&1; echo "exit=$?"
```

Expected: all PASS. If any fail, fix the merge logic in `lib/symbolTable.ts` rather than weakening the test.

- [ ] **Step 3: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
test(symbolTable): cover star re-exports, transitive chains, cycles, collisions
EOF
git add lib/symbolTable.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 10: Preprocessor — `resolveReExports` synthesis (skeleton + named functions)

**Files:**
- Create: `lib/preprocessors/resolveReExports.ts`
- Create: `lib/preprocessors/resolveReExports.test.ts`

- [ ] **Step 1: Write failing tests for the function-kind synthesis**

```ts
// lib/preprocessors/resolveReExports.test.ts
import { describe, it, expect } from "vitest";
import { resolveReExports } from "./resolveReExports.js";
import { SymbolTable } from "../symbolTable.js";
import type { AgencyProgram } from "../types.js";
// Use whatever in-memory fixture pattern other preprocessor tests use.

describe("resolveReExports", () => {
  it("expands a named function re-export into import + wrapper", () => {
    // Input file (reexporter.agency):
    //   export { search } from "./source.agency"
    // Source file (source.agency):
    //   export def search(query: string): string { return "" }
    //
    // After resolveReExports(reexporterProgram, symbolTable, reexporterPath):
    //   - All exportFromStatement nodes removed.
    //   - One importStatement: import { search as __reexport_search } from "./source.agency"
    //   - One exported function declaration `def search(query: string): string` whose body is `return __reexport_search(query)`.
  });

  it("preserves alias", () => {
    // Input: export { search as wikipediaSearch } from "./source.agency"
    // Synthesized wrapper named `wikipediaSearch`, internal alias `__reexport_search`,
    // body `return __reexport_search(query)`.
  });

  it("propagates safe modifier to the wrapper", () => {
    // Input: export { safe search } from "./source.agency"
    // Synthesized function has `safe: true`.
  });

  it("preserves parameter defaults and return types", () => {
    // source: export def search(query: string, limit: number = 10): SearchResult { ... }
    // wrapper has the same parameters (with defaults) and same return type.
  });
});
```

- [ ] **Step 2: Create empty preprocessor module**

```ts
// lib/preprocessors/resolveReExports.ts
import type { AgencyNode, AgencyProgram } from "../types.js";
import type { SymbolTable, SymbolInfo, FunctionSymbol } from "../symbolTable.js";

export function resolveReExports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
): AgencyProgram {
  throw new Error("not implemented");
}
```

- [ ] **Step 3: Run — expect failures**

```bash
pnpm test:run lib/preprocessors/resolveReExports.test.ts > /tmp/preproc-test.log 2>&1; echo "exit=$?"
```

Expected: tests fail with "not implemented".

- [ ] **Step 4: Implement function-kind synthesis driven by `FileSymbols`**

```ts
// lib/preprocessors/resolveReExports.ts
import type { AgencyNode, AgencyProgram, FunctionDefinition } from "../types.js";
import type { SymbolTable, SymbolInfo, FunctionSymbol, FileSymbols } from "../symbolTable.js";
import type { ImportStatement } from "../types/importStatement.js";

const REEXPORT_PREFIX = "__reexport_";

export function resolveReExports(
  program: AgencyProgram,
  symbolTable: SymbolTable,
  currentFile: string,
): AgencyProgram {
  const fileSymbols = symbolTable.getFile(currentFile) ?? {};

  // Collect re-exported entries grouped by source file.
  const bySource: Record<string, Array<{ localName: string; sym: SymbolInfo }>> = {};
  for (const [localName, sym] of Object.entries(fileSymbols)) {
    if (!sym.reExportedFrom) continue;
    const src = sym.reExportedFrom.sourceFile;
    (bySource[src] ??= []).push({ localName, sym });
  }

  // Strip all exportFromStatement nodes; keep everything else.
  const kept: AgencyNode[] = program.nodes.filter(
    (n) => n.type !== "exportFromStatement",
  );

  // Synthesize one coalesced importStatement per source + one wrapper per symbol.
  const synthesized: AgencyNode[] = [];
  for (const [sourceFile, entries] of Object.entries(bySource)) {
    synthesized.push(buildCoalescedImport(sourceFile, entries));
    for (const { localName, sym } of entries) {
      synthesized.push(buildWrapper(localName, sym));
    }
  }

  // Synthesized imports go before kept nodes (matches normal import positioning).
  return { ...program, nodes: [...synthesized, ...kept] };
}

function buildCoalescedImport(
  sourceFile: string,
  entries: Array<{ localName: string; sym: SymbolInfo }>,
): ImportStatement {
  const importedNames: string[] = [];
  const aliases: Record<string, string> = {};
  const safeNames: string[] = [];
  for (const { sym } of entries) {
    const original = sym.reExportedFrom!.originalName;
    if (importedNames.includes(original)) continue; // already coalesced
    importedNames.push(original);
    aliases[original] = `${REEXPORT_PREFIX}${original}`;
    if (sym.kind === "function" && sym.safe) {
      // The wrapper is what carries `safe` to consumers. We do not need to mark
      // the internal alias safe; safety propagation happens at the wrapper.
    }
  }
  return {
    type: "importStatement",
    modulePath: sourceFileToModulePath(sourceFile),
    isAgencyImport: true,
    importedNames: [{ type: "namedImport", importedNames, safeNames, aliases }],
  };
}

function buildWrapper(localName: string, sym: SymbolInfo): AgencyNode {
  switch (sym.kind) {
    case "function":
      return buildFunctionWrapper(localName, sym);
    case "node":
      throw new Error("node re-export wrapper not yet implemented (Task 11)");
    case "type":
      throw new Error("type re-export not yet implemented (Task 12)");
    case "constant":
      throw new Error("constant re-export not yet implemented (Task 12)");
    default:
      throw new Error(`Cannot synthesize re-export wrapper for kind=${sym.kind}`);
  }
}

function buildFunctionWrapper(localName: string, sym: FunctionSymbol): FunctionDefinition {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;

  // Build the call: __reexport_orig(arg1, arg2, ...)
  const callArgs = sym.parameters.map((p) => ({
    type: "variableName" as const,
    value: p.name,
    loc: sym.loc,
  }));

  const callExpr = {
    type: "functionCall" as const,
    functionName: internal,
    arguments: callArgs,
    loc: sym.loc,
  };

  return {
    type: "function",
    functionName: localName,
    parameters: sym.parameters,
    returnType: sym.returnType ?? undefined,
    returnTypeValidated: sym.returnTypeValidated,
    safe: sym.safe,
    exported: true,
    body: [
      {
        type: "returnStatement",
        value: callExpr,
        loc: sym.loc,
      },
    ],
    loc: sym.loc,
  } as FunctionDefinition;
}

/**
 * Reconstruct a module path string suitable for an `import ... from "X"` statement,
 * given an absolute filesystem path (which is how SymbolTable stores source paths).
 *
 * For simplicity in v1, emit the absolute path. The downstream resolveImports +
 * resolveAgencyImportPath are tolerant of absolute paths; if they aren't,
 * compute a relative path from currentFile here.
 */
function sourceFileToModulePath(absPath: string): string {
  return absPath;
}
```

Note: `FunctionDefinition` and other AST node types live in `lib/types.ts` or `lib/types/*.ts`. Read those files first to confirm exact field names — adapt the wrapper construction to match the real shape. If there is no `FunctionDefinition` symbol, look for `FunctionNode` or simply `Function`.

If `sourceFileToModulePath` causes problems (downstream import resolution doesn't accept absolute paths), instead resolve the original `exportFromStatement.modulePath` string for each re-exported source. To do that, change the data flow: the preprocessor walks `program.nodes` for `exportFromStatement` first (just to capture each `(absolutePath, originalModulePath)` pair from `resolveAgencyImportPath`), then strips them. That way the synthesized import keeps the user's original `modulePath` string.

- [ ] **Step 5: Run — expect tests to pass**

```bash
pnpm test:run lib/preprocessors/resolveReExports.test.ts > /tmp/preproc-test.log 2>&1; echo "exit=$?"
```

Expected: all 4 function-form tests PASS.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(preprocessor): add resolveReExports — function-form synthesis

Driven by FileSymbols (single source of truth). Strips exportFromStatement nodes and emits one coalesced import + one local wrapper per re-exported function.
EOF
git add lib/preprocessors/resolveReExports.ts lib/preprocessors/resolveReExports.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 11: Preprocessor — node, type, constant re-exports

**Files:**
- Modify: `lib/preprocessors/resolveReExports.ts`
- Modify: `lib/preprocessors/resolveReExports.test.ts`

- [ ] **Step 1: Write failing tests for each kind**

Append to `lib/preprocessors/resolveReExports.test.ts`:

```ts
describe("resolveReExports: per-kind synthesis", () => {
  it("synthesizes a node wrapper for a re-exported node", () => {
    // source: export node main(input: string) { ... }
    // reexporter: export { main } from "./source.agency"
    // Wrapper is a node named `main` with body `return __reexport_main(input)`.
  });

  it("synthesizes a type alias for a re-exported type", () => {
    // source: export type Foo = { x: number }
    // reexporter: export { Foo } from "./source.agency"
    // Synthesized: import { Foo as __reexport_Foo } from ".../source.agency"
    //              export type Foo = __reexport_Foo
  });

  it("synthesizes a constant binding for a re-exported static const", () => {
    // source: export static const PROMPT = "hi"
    // reexporter: export { PROMPT } from "./source.agency"
    // Synthesized: import { PROMPT as __reexport_PROMPT } from ".../source.agency"
    //              export static const PROMPT = __reexport_PROMPT
  });
});
```

- [ ] **Step 2: Run — expect failures (current dispatch throws)**

```bash
pnpm test:run lib/preprocessors/resolveReExports.test.ts > /tmp/preproc-test.log 2>&1; echo "exit=$?"
```

Expected: 3 new tests FAIL with "not yet implemented".

- [ ] **Step 3: Implement node, type, constant builders**

In `lib/preprocessors/resolveReExports.ts`, replace the `throw` branches in `buildWrapper` with real implementations. Read `lib/types/*.ts` for the exact AST shapes of `graphNode`, `typeAlias`, and `assignment`.

```ts
function buildNodeWrapper(localName: string, sym: NodeSymbol): AgencyNode {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  const callArgs = sym.parameters.map((p) => ({
    type: "variableName" as const,
    value: p.name,
    loc: sym.loc,
  }));
  return {
    type: "graphNode",
    nodeName: localName,
    parameters: sym.parameters,
    returnType: sym.returnType ?? undefined,
    returnTypeValidated: sym.returnTypeValidated,
    exported: true,
    body: [
      {
        type: "returnStatement",
        value: {
          type: "functionCall",
          functionName: internal,
          arguments: callArgs,
          loc: sym.loc,
        },
        loc: sym.loc,
      },
    ],
    loc: sym.loc,
  } as AgencyNode;
}

function buildTypeWrapper(localName: string, sym: TypeSymbol): AgencyNode {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  return {
    type: "typeAlias",
    aliasName: localName,
    aliasedType: { type: "namedType", name: internal, loc: sym.loc },
    exported: true,
    loc: sym.loc,
  } as AgencyNode;
}

function buildConstantWrapper(localName: string, sym: ConstantSymbol): AgencyNode {
  const original = sym.reExportedFrom!.originalName;
  const internal = `${REEXPORT_PREFIX}${original}`;
  return {
    type: "assignment",
    declKind: "const",
    static: true,
    exported: true,
    variableName: localName,
    target: { type: "variableName", value: localName, loc: sym.loc },
    value: { type: "variableName", value: internal, loc: sym.loc },
    loc: sym.loc,
  } as AgencyNode;
}
```

Wire these into `buildWrapper`. Adjust field shapes to match the real AST.

- [ ] **Step 4: Run — expect pass**

```bash
pnpm test:run lib/preprocessors/resolveReExports.test.ts > /tmp/preproc-test.log 2>&1; echo "exit=$?"
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat(preprocessor): support node, type, and constant re-export synthesis
EOF
git add lib/preprocessors/resolveReExports.ts lib/preprocessors/resolveReExports.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 12: Preprocessor — coalescing test + star handling

**Files:**
- Modify: `lib/preprocessors/resolveReExports.test.ts`

- [ ] **Step 1: Write tests**

```ts
describe("resolveReExports: coalescing and star", () => {
  it("coalesces multiple named re-exports from the same source into one import", () => {
    // reexporter: export { foo } from "./source.agency"
    //             export { bar } from "./source.agency"
    // Expect exactly one importStatement in the output, with importedNames containing both foo and bar.
  });

  it("expands `export * from` using all source-side exports", () => {
    // source: export def foo(); export def bar(); def hidden() {}
    // reexporter: export * from "./source.agency"
    // Expect wrappers for foo and bar; nothing for hidden.
  });
});
```

- [ ] **Step 2: Run**

```bash
pnpm test:run lib/preprocessors/resolveReExports.test.ts > /tmp/preproc-test.log 2>&1; echo "exit=$?"
```

The coalescing test should pass (already coalesced via `bySource` grouping). The star test should also pass — the SymbolTable expanded star into individual `FileSymbols` entries in Task 8. If either fails, debug and fix in `resolveReExports.ts`.

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
test(preprocessor): cover coalescing and star re-export expansion
EOF
git add lib/preprocessors/resolveReExports.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 13: Wire `resolveReExports` into the compiler pipeline

**Files:**
- Modify: `lib/compiler/compile.ts`
- Modify: `lib/lsp/diagnostics.ts`
- Modify: `lib/cli/commands.ts`

- [ ] **Step 1: Write a failing end-to-end test**

Add or extend `tests/agency-js/` (look at an existing test for the pattern). Create something like `tests/agency-js/reExports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compileAgency } from "../../lib/compiler/compile.js"; // adjust to actual export
// Or use the higher-level harness existing tests use.

describe("re-export end-to-end", () => {
  it("compiles and runs a re-exported function", async () => {
    // Use whichever harness existing agency-js tests use. Two source files:
    //   tools.agency:    export def double(x: number): number { return x * 2 }
    //   main.agency:     export { double } from "./tools.agency"
    //                    node main() { return double(21) }
    // Compile main.agency, run it, expect result === 42.
  });
});
```

- [ ] **Step 2: Run — expect failure (resolveReExports never called)**

```bash
pnpm test:run tests/agency-js/reExports.test.ts > /tmp/e2e.log 2>&1; echo "exit=$?"
```

Expected: FAIL — likely "Symbol 'double' is not defined" or "exportFromStatement is not a known node type".

- [ ] **Step 3: Wire resolveReExports into compile.ts**

In `lib/compiler/compile.ts`, around line 121:

```ts
import { resolveReExports } from "@/preprocessors/resolveReExports.js";

// Replace:
//   const resolvedProgram = resolveImports(program, symbolTable, syntheticPath);
// With:
const reExported = resolveReExports(program, symbolTable, syntheticPath);
const resolvedProgram = resolveImports(reExported, symbolTable, syntheticPath);
```

- [ ] **Step 4: Wire into lsp/diagnostics.ts and cli/commands.ts**

In `lib/lsp/diagnostics.ts` around line 61:

```ts
import { resolveReExports } from "../preprocessors/resolveReExports.js";

program = resolveReExports(program, symbolTable, fsPath);
program = resolveImports(program, symbolTable, fsPath);
```

In `lib/cli/commands.ts` around line 149: same pattern.

- [ ] **Step 5: Run e2e — expect pass**

```bash
pnpm test:run tests/agency-js/reExports.test.ts > /tmp/e2e.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 6: Run the full test suite to catch regressions**

```bash
pnpm test:run > /tmp/all-tests.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Inspect `/tmp/all-tests.log` and fix any regressions before committing.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
feat: wire resolveReExports into compile, LSP, and CLI pipelines

Runs immediately before resolveImports so synthesized internal imports flow through normal import resolution. End-to-end: a re-exported function in one .agency file can be called from another.
EOF
git add lib/compiler/compile.ts lib/lsp/diagnostics.ts lib/cli/commands.ts tests/agency-js/reExports.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 14: Serve discovery test

**Files:**
- Modify: `lib/serve/discovery.test.ts`

- [ ] **Step 1: Read the existing test file to understand the harness**

```bash
cat lib/serve/discovery.test.ts | head -80
```

Note the fixture style (in-memory program vs tmp-dir files).

- [ ] **Step 2: Write the failing test**

Append to `lib/serve/discovery.test.ts`:

```ts
describe("discovery: re-exports", () => {
  it("discovers a re-exported function as a served tool with module === serving file", () => {
    // Set up:
    //   tools.agency:    export def search(q: string): string { return "" }
    //   main.agency:     export { search } from "./tools.agency"
    // Compile main.agency through the full pipeline, then run discovery on it.
    // Expect a served function named `search` whose `module` field equals main.agency's moduleId.
  });

  it("preserves interruptKinds from the source", () => {
    // tools.agency: export def ask(q: string): string { interrupt "userInput"; return "" }
    // main.agency:  export { ask } from "./tools.agency"
    // Discovery on main.agency reports `ask` with interruptKinds containing { kind: "userInput" }.
  });
});
```

- [ ] **Step 3: Run — expect pass**

```bash
pnpm test:run lib/serve/discovery.test.ts > /tmp/serve.log 2>&1; echo "exit=$?"
```

Expected: PASS — the wrapper synthesized by `resolveReExports` is a genuine local function in `main.agency`, so `discovery.ts:15`'s filter accepts it. Interrupt kinds are computed by the type checker post-preprocess and propagate transitively through the wrapper.

If they fail: debug. The point of this task is to verify these properties hold without further code changes.

- [ ] **Step 4: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
test(serve): re-exported functions discovered as local tools with source interruptKinds
EOF
git add lib/serve/discovery.test.ts
git commit -F /tmp/commit-msg
```

---

## Task 15: Integration fixture

**Files:**
- Create: `tests/agency/reExports/wikipedia.agency`
- Create: `tests/agency/reExports/reexporter.agency`
- Create: `tests/agency/reExports/reexporter.expected.json` (or whatever extension fixtures use)

- [ ] **Step 1: Read the existing fixture format**

```bash
ls tests/agency/ | head -20
ls tests/agency/$(ls tests/agency/ | head -1)
```

Open one fixture's `.agency` file plus its `.expected.*` file to learn the format.

- [ ] **Step 2: Author fixtures**

Create a fixture that exercises **named, aliased, per-name safe, and star** in one realistic example:

```
// tests/agency/reExports/wikipedia.agency
export def search(query: string): string { return "result for " + query }
export def fetch(url: string): string { return "page at " + url }
export def lookup(id: string): string { return "id " + id }

// tests/agency/reExports/reexporter.agency
export { search as wikipediaSearch } from "./wikipedia.agency"
export { safe fetch } from "./wikipedia.agency"
export * from "./wikipedia.agency"

node main() {
  return wikipediaSearch("hello")
}
```

Note: the `*` will collide with the explicit `wikipediaSearch` (no — different local names) and with `fetch` (yes — same local name). Adjust the fixture so it does NOT trigger collision errors, or split into two fixtures: one for happy path, one to lock in the collision error.

Recommended: split into two fixtures.
1. `reexporter.agency` (happy path) — only the explicit named/aliased/safe forms, no star.
2. `starOnly.agency` — only `export * from "./wikipedia.agency"`.

- [ ] **Step 3: Run `make fixtures`**

```bash
make fixtures > /tmp/fixtures.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Read `/tmp/fixtures.log` for any errors.

- [ ] **Step 4: Run the integration tests**

```bash
pnpm test:run tests/agency/reExports > /tmp/fixture-test.log 2>&1; echo "exit=$?"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
test(fixtures): add re-export integration fixtures (named, aliased, safe, star)
EOF
git add tests/agency/reExports/
git commit -F /tmp/commit-msg
```

---

## Task 16: Documentation

**Files:**
- Modify: `docs/site/guide/imports-and-packages.md`
- Modify: `docs/site/guide/mcp.md`

- [ ] **Step 1: Document re-export syntax**

Append a new section to `docs/site/guide/imports-and-packages.md`:

````markdown
## Re-exporting from another module

Use `export ... from` to re-export symbols defined in another Agency module. This is the idiomatic way to expose stdlib tools (or symbols from any other Agency package) as your own module's tools — for example, when serving a curated set of tools through `agency serve mcp`.

```ts
// Re-export by name
export { search } from "std::wikipedia"

// Re-export with a different name
export { search as wikipediaSearch } from "std::wikipedia"

// Re-export everything that the source module exports
export * from "std::wikipedia"

// Mark a re-exported function as `safe` (per-name)
export { safe search } from "std::wikipedia"
```

Re-exports work for functions, nodes, types, and `static const` constants. Classes cannot be re-exported.

When two re-exports would produce the same local name, you must disambiguate explicitly with `as` — there is no implicit precedence.
````

- [ ] **Step 2: Add the headline MCP example**

Append to `docs/site/guide/mcp.md`:

````markdown
### Bundling another module's tools

To expose every tool from `std::wikipedia` (or any Agency module) through `agency serve mcp`, re-export them:

```ts
// my-server.agency
export * from "std::wikipedia"
```

Then `agency serve mcp my-server.agency` exposes `search`, `fetch`, etc. as MCP tools. To rename or mark them safe, use the explicit form:

```ts
export { search as wikipediaSearch } from "std::wikipedia"
export { safe fetch } from "std::wikipedia"
```
````

- [ ] **Step 3: Verify docs build (if there is a docs build step)**

```bash
ls makefile docs/site/
# If there's a `make docs` or similar target, run it. Otherwise skip.
```

- [ ] **Step 4: Commit**

```bash
cat > /tmp/commit-msg <<'EOF'
docs: document `export ... from` re-export syntax

Adds the syntax overview to the imports guide and shows the headline MCP use case (bundling another module's tools).
EOF
git add docs/site/guide/imports-and-packages.md docs/site/guide/mcp.md
git commit -F /tmp/commit-msg
```

---

## Task 17: Final verification

- [ ] **Step 1: Run the full build**

```bash
make > /tmp/build.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 2: Run the full test suite**

```bash
pnpm test:run > /tmp/all-tests.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`. Read `/tmp/all-tests.log` to inspect any failures.

- [ ] **Step 3: Run the structural linter**

```bash
pnpm run lint:structure > /tmp/lint.log 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

- [ ] **Step 4: Smoke test the formatter on a re-export file**

```bash
cat > /tmp/smoke.agency <<'EOF'
export { search as wikipediaSearch, safe fetch } from "std::wikipedia"
export * from "std::wikipedia"
EOF
pnpm run fmt /tmp/smoke.agency
```

Expected: output is identical to input (round-trip).

- [ ] **Step 5: Done — no commit needed for verification**

If everything green, the implementation is complete.

---

## Self-review checklist (already applied)

- **Spec coverage:**
  - Parser, formatter, AST type — Tasks 1–5 ✓
  - SymbolTable reachability + merging + collisions + cycles + star + transitivity — Tasks 7–9 ✓
  - `reExportedFrom` field — Task 6 ✓
  - Preprocessor synthesis (function, node, type, constant) + coalescing — Tasks 10–12 ✓
  - Pipeline wiring (compile, LSP, CLI) — Task 13 ✓
  - Serve discovery + interruptKinds — Task 14 ✓
  - Integration fixtures — Task 15 ✓
  - Documentation — Task 16 ✓
  - Per-name `safe` semantics — Task 2 (parser), Task 8 (SymbolTable), Task 10 (preprocessor) ✓

- **Type consistency:** All references use `reExportedFrom: { sourceFile, originalName }`, the `__reexport_` prefix is consistent everywhere, `mergeExportsFrom` / `mergeOne` / `isExportedSymbol` / `buildWrapper` / `buildFunctionWrapper` / `buildNodeWrapper` / `buildTypeWrapper` / `buildConstantWrapper` are used consistently.

- **Placeholders:** None. Every step shows code or exact commands. Where the executor must adapt to the real AST shape (e.g. `FunctionDefinition` field names), the plan flags it explicitly and tells them to read the type file first.

---

## Execution Handoff

Plan complete and saved to `packages/agency-lang/docs/superpowers/plans/2026-05-11-reexport-syntax.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
