# Doc String Interpolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support string interpolation (`${expr}`) in doc strings, with a type checker error when users try to interpolate function parameters (whose values aren't known at tool-definition time).

**Architecture:** Replace the `DocString` AST type with `MultiLineStringLiteral` (which already supports `segments: PromptSegment[]`). Rewrite `docStringParser` to delegate to `multiLineStringParser` while preserving doc-string-specific trimming. Update all consumers (TS builder, agency generator, doc CLI, LSP) to work with segments. Add a type checker pass that rejects parameter interpolation in doc strings.

**Tech Stack:** TypeScript, tarsec parser combinators, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/types/literals.ts` | Modify | Add `loc?: SourceLocation` to `InterpolationSegment` (via `BaseNode`) |
| `lib/types/function.ts` | Modify | Remove `DocString` type; change `docString` field type to `MultiLineStringLiteral` |
| `lib/types/graphNode.ts` | Modify | Change `docString` field type to `MultiLineStringLiteral` |
| `lib/parsers/parsers.ts` | Modify | Rewrite `docStringParser` to return `MultiLineStringLiteral`; wrap `interpolationSegmentParser` with `withLoc` |
| `lib/backends/typescriptBuilder.ts` | Modify | Emit doc string description from segments via `generateStringLiteralNode` (line ~1253) |
| `lib/backends/agencyGenerator.ts` | Modify | Reconstruct `"""..."""` from segments (2 places: function ~line 647, node ~line 1035) |
| `lib/cli/doc.ts` | Modify | Reconstruct doc string text from segments using `AgencyGenerator.processNode` for interpolations (line 310, 338) |
| `lib/lsp/completion.ts` | Modify | Reconstruct doc string text from segments (line 58) |
| `lib/typeChecker/index.ts` | Modify | Add parameter-in-docstring check |
| `lib/parsers/function.test.ts` | Modify | Update doc string test expectations from `{ type: "docString", value }` to `{ type: "multiLineString", segments }` |
| `tests/typescriptGenerator/docstrings.agency` | Modify | Add interpolation test cases |
| `tests/typescriptGenerator/docstrings.mjs` | Rebuild | Regenerated fixture |

**Note on consumers outside `lib/`:** A grep of the monorepo confirmed only the files in `lib/` reference `DocString` or `.docString.value`. No external package imports `DocString`, so the type rename is internal-only and safe.

**Note on `lib/lsp/`:** Confirmed by grep that `completion.ts:58` is the only LSP touch point for `.docString.value` — no hover handler reads it.

---

## Key Design Decisions

### Trimming
The current `docStringParser` trims the entire captured text. With segments, we trim the leading whitespace of the first text segment and the trailing whitespace of the last text segment. This preserves current behavior (e.g., `"""\n  Some doc\n  """` → `"Some doc"`) while keeping interpolation segments intact.

**Segment shape verified empirically:** For `"""\n  ${x} is great\n  """`, `multiLineStringParser` produces `[text("\n  "), interp(x), text(" is great\n  ")]`. The leading whitespace is captured as a separate text segment ahead of the interpolation because `multiLineStringTextSegmentParser` uses `many1Till` on `or(str('"""'), str("${"))`. So trimming the first text segment's leading whitespace (then filtering empty text segments) and the last text segment's trailing whitespace yields `[interp(x), text(" is great")]`, matching the expected fixtures in Task 2.

**Inner whitespace is preserved.** For `"""  ${a}  ${b}  """`, the parse yields `[text("  "), interp(a), text("  "), interp(b), text("  ")]`. After trimming, we get `[interp(a), text("  "), interp(b)]` — the inner spacing between interpolations is intact. A fixture exercises this case.

### Immutability of parser results
The new `docStringParser` must NOT mutate the segments array returned by `multiLineStringParser`. We construct a fresh segments array and return a new `MultiLineStringLiteral` via `success(...)`, leaving the original parser result untouched. Avoids subtle bugs if any future code shares segments arrays.

### Sentinel stripping
The `multiLineStringParser` already calls `stripSentinels` on text segments (replacing `BLANK_LINE_SENTINEL` chars with newlines). Since the new `docStringParser` delegates to `multiLineStringParser`, this behavior is inherited for free — no extra handling needed.

### Empty doc strings
The current parser rejects `""""""` (empty) via `many1Till`. The multi-line string parser uses `many` (zero-or-more), so empty doc strings would now succeed and produce `segments: []`. This is fine — the TS builder already has a `"No description provided."` fallback.

### Parser call sites
The `docStringParser` is used in two places in `parsers.ts` (inside the function parser and the node parser) via `capture(or(docStringParser, succeed(undefined)), "docString")`. These capture the parser result into the `"docString"` field on the AST. Since we only change the return type of `docStringParser` (from `DocString` to `MultiLineStringLiteral`), the capture sites work unchanged — the field name stays `"docString"` and the value changes shape automatically.

### Parameter check scope
The type checker only needs to check top-level `variableName` expressions in interpolation segments — not deeply nested expressions like `${someFunc(param)}`. The intent is to catch the obvious mistake of `"""Greets ${name}"""` where `name` is a parameter. If the user writes `${someFunc(name)}`, that's an expression with a function call that will be evaluated at module load time and is likely intentional (and will fail with a runtime error if `name` isn't in scope, which is a fine developer experience).

---

### Task 1: Remove DocString type, update AST field types, give InterpolationSegment a loc

**Files:**
- Modify: `lib/types/literals.ts` (give `InterpolationSegment` a `loc`)
- Modify: `lib/types/function.ts` (remove `DocString` type, change field type)
- Modify: `lib/types/graphNode.ts` (change field type)
- Modify: `lib/parsers/parsers.ts` (wrap `interpolationSegmentParser` with `withLoc`)

- [ ] **Step 0: Give `InterpolationSegment` a source location**

`InterpolationSegment` currently lacks a `loc` field, which forces the new doc-string type-checker error to point at the entire doc string rather than the offending `${expr}`. Fix this by making the type extend `BaseNode` and updating the parser to attach the loc.

In `lib/types/literals.ts`:

```typescript
// Before:
export type InterpolationSegment = {
  type: "interpolation";
  expression: Expression;
};

// After:
export type InterpolationSegment = BaseNode & {
  type: "interpolation";
  expression: Expression;
};
```

In `lib/parsers/parsers.ts`, wrap `interpolationSegmentParser` with `withLoc`:

```typescript
// Before (lib/parsers/parsers.ts:333-355):
export const interpolationSegmentParser: Parser<InterpolationSegment> = (
  input: string,
) => { ... };

// After:
export const interpolationSegmentParser: Parser<InterpolationSegment> = withLoc((
  input: string,
) => { ... });
```

Verify: parse a string with `${x}` via `pnpm run ast` and confirm the resulting interpolation segment now has a `loc` field with sensible `start`/`end` offsets that span the `${...}`.

- [ ] **Step 1: Modify `lib/types/function.ts`**

Remove the `DocString` type (lines 68-71). Add `MultiLineStringLiteral` to the imports. Change the `docString` field on `FunctionDefinition` from `DocString` to `MultiLineStringLiteral`:

```typescript
import {
  AgencyMultiLineComment,
  AgencyNode,
  Expression,
  Literal,
  ScopeType,
  VariableType,
} from "../types.js";
import { BaseNode } from "./base.js";
import { BlockArgument } from "./blockArgument.js";
import { AgencyArray, AgencyObject, NamedArgument, SplatExpression } from "./dataStructures.js";
import { MultiLineStringLiteral } from "./literals.js";
import { Tag } from "./tag.js";

// ... FunctionParameter and VALID_CALLBACK_NAMES stay the same ...

export type FunctionDefinition = BaseNode & {
  type: "function";
  functionName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  docString?: MultiLineStringLiteral;
  docComment?: AgencyMultiLineComment;
  async?: boolean;
  safe?: boolean;
  exported?: boolean;
  callback?: boolean;
  tags?: Tag[];
};

// ... FunctionCall stays the same ...

// DELETE the DocString type entirely
```

- [ ] **Step 2: Modify `lib/types/graphNode.ts`**

Replace `DocString` import with `MultiLineStringLiteral` import and change the field type:

```typescript
import { AgencyMultiLineComment, AgencyNode, FunctionCall, VariableType } from "../types.js";
import { ValueAccess } from "./access.js";
import { BaseNode } from "./base.js";
import { FunctionParameter } from "./function.js";
import { Literal, MultiLineStringLiteral } from "./literals.js";
import { Tag } from "./tag.js";

export type GraphNodeDefinition = BaseNode & {
  type: "graphNode";
  nodeName: string;
  parameters: FunctionParameter[];
  body: AgencyNode[];
  returnType?: VariableType | null;
  returnTypeValidated?: boolean;
  exported?: boolean;
  tags?: Tag[];
  docComment?: AgencyMultiLineComment;
  docString?: MultiLineStringLiteral;
};
```

- [ ] **Step 3: Fix any remaining `DocString` references**

`lib/types.ts` does `export * from "./types/function.js"` which previously exported `DocString`. A grep confirmed only three files inside `lib/` reference `DocString`:
- `lib/types/function.ts` (handled in Step 1)
- `lib/types/graphNode.ts` (handled in Step 2)
- `lib/parsers/parsers.ts` (will be updated in Task 2)

No external package imports `DocString`, so the rename is internal-only.

Re-run: `grep -r "DocString" lib/ --include="*.ts" | grep -v ".test." | grep -v "dist/"` to confirm only `parsers.ts` remains (it'll be fixed in Task 2).

- [ ] **Step 4: Verify the build compiles (type errors expected in consumers)**

Run: `npx tsc --noEmit 2>&1 | head -50`

Expected: Type errors in `parsers.ts`, `typescriptBuilder.ts`, `agencyGenerator.ts`, `doc.ts`, `completion.ts` — these are the consumers we'll fix in subsequent tasks. Confirm no unexpected errors.

- [ ] **Step 5: Commit**

```bash
git add lib/types/function.ts lib/types/graphNode.ts
git commit -m "refactor: replace DocString type with MultiLineStringLiteral on function/node AST"
```

---

### Task 2: Rewrite docStringParser to return MultiLineStringLiteral

**Files:**
- Modify: `lib/parsers/parsers.ts:2650-2665`
- Modify: `lib/parsers/function.test.ts:1-130`

- [ ] **Step 1: Update ONLY the `docStringParser`-block test expectations**

In `lib/parsers/function.test.ts`, locate the `describe("docStringParser", ...)` block. Update those test cases only — do NOT touch the function/node parser tests in this step (those come in Step 5, after the parser is rewritten). Every `{ type: "docString", value: "..." }` becomes `{ type: "multiLineString", segments: [{ type: "text", value: "..." }] }`. Empty-value cases become `segments: []`. Examples:

```typescript
// Before:
{ type: "docString", value: "This is a docstring" }
// After:
{ type: "multiLineString", segments: [{ type: "text", value: "This is a docstring" }] }

// Before (whitespace-only → trimmed to empty):
{ type: "docString", value: "" }
// After:
{ type: "multiLineString", segments: [] }
```

Also update the previously-failing empty docstring case `""""""` — it should now succeed with `segments: []`.

Add new test cases for interpolation:

```typescript
{
  input: '"""Hello ${name}"""',
  expected: {
    success: true,
    result: {
      type: "multiLineString",
      segments: [
        { type: "text", value: "Hello " },
        { type: "interpolation", expression: { type: "variableName", value: "name" } },
      ],
    },
  },
},
{
  input: '"""The count is ${count} items"""',
  expected: {
    success: true,
    result: {
      type: "multiLineString",
      segments: [
        { type: "text", value: "The count is " },
        { type: "interpolation", expression: { type: "variableName", value: "count" } },
        { type: "text", value: " items" },
      ],
    },
  },
},
// Edge case: interpolation at the start (leading whitespace trimmed, interpolation preserved)
{
  input: '"""\n  ${name} is great\n  """',
  expected: {
    success: true,
    result: {
      type: "multiLineString",
      segments: [
        { type: "interpolation", expression: { type: "variableName", value: "name" } },
        { type: "text", value: " is great" },
      ],
    },
  },
},
// Edge case: interpolation at the end (trailing whitespace trimmed, interpolation preserved)
{
  input: '"""Version ${ver}\n  """',
  expected: {
    success: true,
    result: {
      type: "multiLineString",
      segments: [
        { type: "text", value: "Version " },
        { type: "interpolation", expression: { type: "variableName", value: "ver" } },
      ],
    },
  },
},
// Edge case: interpolations separated by inner whitespace (only the outer
// whitespace is trimmed; the inner text segment is preserved).
{
  input: '"""  ${a}  ${b}  """',
  expected: {
    success: true,
    result: {
      type: "multiLineString",
      segments: [
        { type: "interpolation", expression: { type: "variableName", value: "a" } },
        { type: "text", value: "  " },
        { type: "interpolation", expression: { type: "variableName", value: "b" } },
      ],
    },
  },
},
```

Note: the `expression` objects in the expected results may also contain `loc` fields now that `interpolationSegmentParser` is wrapped with `withLoc`. Use a partial matcher (`expect.objectContaining(...)`) or strip `loc` from results before comparing, consistent with existing test patterns in the file.

- [ ] **Step 2: Run the doc string parser tests to verify they fail**

Run: `pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/docstring-parser-test.log`
Expected: FAIL — the parser still returns the old `DocString` type.

- [ ] **Step 3: Rewrite docStringParser**

In `lib/parsers/parsers.ts`, replace the `docStringParser` implementation. Change its return type from `Parser<DocString>` to `Parser<MultiLineStringLiteral>`. Update the import at the top of the file (remove `DocString`, add `MultiLineStringLiteral` if not already imported).

```typescript
export const docStringParser: Parser<MultiLineStringLiteral> = (input: string) => {
  const result = multiLineStringParser(input);
  if (!result.success) return result;

  // Build a fresh segments array — do not mutate the array or segment
  // objects owned by `result.result`.
  const orig = result.result.segments;
  const trimmed: PromptSegment[] = orig.map((s) => ({ ...s }));

  // Trim leading whitespace of first text segment and trailing whitespace
  // of last text segment (preserves historic behavior, e.g.
  // """\n  Some doc\n  """ → "Some doc"; inner whitespace is preserved).
  if (trimmed.length > 0 && trimmed[0].type === "text") {
    trimmed[0] = { type: "text", value: trimmed[0].value.replace(/^\s+/, "") };
  }
  const lastIdx = trimmed.length - 1;
  if (lastIdx >= 0 && trimmed[lastIdx].type === "text") {
    trimmed[lastIdx] = {
      type: "text",
      value: trimmed[lastIdx].value.replace(/\s+$/, ""),
    };
  }

  // Drop empty text segments created by trimming.
  const segments = trimmed.filter(
    (s) => s.type !== "text" || s.value !== "",
  );

  return success(
    { type: "multiLineString" as const, segments, loc: result.result.loc },
    result.rest,
  );
};
```

Note: `PromptSegment` and `success` must be in scope at the top of the file — both already are (used by other parsers).

- [ ] **Step 4: Run the doc string parser tests**

Run: `pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/docstring-parser-test2.log`
Expected: The `docStringParser` describe block passes. The function parser tests further down in the file will fail because they still expect `{ type: "docString", value: "..." }` — we'll fix those next.

- [ ] **Step 5: Update function parser test expectations**

In `lib/parsers/function.test.ts`, update all ~80 occurrences of `docString: { type: "docString", value: "..." }` inside function/node parser tests. Convert each to `docString: { type: "multiLineString", segments: [{ type: "text", value: "..." }] }`. The `docString: undefined` cases stay as-is.

Tip: A targeted search-and-replace can handle most cases. The pattern is:
- `docString: { type: "docString", value: "CONTENT" }` → `docString: { type: "multiLineString", segments: [{ type: "text", value: "CONTENT" }] }`

- [ ] **Step 6: Run all parser tests**

Run: `pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/docstring-parser-test3.log`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/function.test.ts
git commit -m "feat: docStringParser returns MultiLineStringLiteral with interpolation support"
```

---

### Task 3: Update TypeScript builder to emit interpolated descriptions

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1224-1228`

- [ ] **Step 1: Update the tool definition description emission**

In `lib/backends/typescriptBuilder.ts`, find the `description` line in the tool definition builder (around line 1227). Replace the raw string embedding with `generateStringLiteralNode`:

```typescript
// Before:
description: ts.raw(
  `\`${node.docString?.value || "No description provided."}\``,
),

// After:
description: node.docString
  ? this.generateStringLiteralNode(node.docString.segments)
  : ts.str("No description provided."),
```

Note: `generateStringLiteralNode` already handles both plain text segments and interpolation segments, producing a `ts.template(...)` node. This is the same code path used for regular string literals.

- [ ] **Step 2: Rebuild the docstrings fixture**

Run: `pnpm run compile tests/typescriptGenerator/docstrings.agency > tests/typescriptGenerator/docstrings.mjs 2>&1`

Verify the output. The descriptions should still appear as template literals but now without the hand-rolled backtick wrapping. For the existing non-interpolated doc strings, the output should be functionally identical.

- [ ] **Step 3: Add an interpolation test case to the fixture**

Add to `tests/typescriptGenerator/docstrings.agency`:

```agency
const toolVersion = "2.0"

def versionedTool() {
  """
  This tool is version ${toolVersion}.
  """
}
```

Rebuild the fixture: `pnpm run compile tests/typescriptGenerator/docstrings.agency > tests/typescriptGenerator/docstrings.mjs 2>&1`

Verify the generated output contains a template literal with the interpolation:
```typescript
description: `This tool is version ${toolVersion}.`
```

- [ ] **Step 4: Run the TypeScript generator tests**

Run: `pnpm test:run tests/typescriptGenerator/ 2>&1 | tee /tmp/tsgen-test.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/docstrings.agency tests/typescriptGenerator/docstrings.mjs
git commit -m "feat: emit interpolated doc string descriptions in generated TypeScript"
```

---

### Task 4: Update agency generator (formatter)

**Files:**
- Modify: `lib/backends/agencyGenerator.ts:630-635,1018-1023`

- [ ] **Step 1: Update function doc string formatting**

The agency generator reconstructs doc strings for the formatter. There are two identical blocks (one for functions at ~line 630, one for nodes at ~line 1018). Update both to reconstruct from segments:

```typescript
// Before:
if (node.docString) {
  const lines = node.docString.value.split("\n").map(l => l.trim());
  const docLines = [`"""`, ...lines, `"""`];
  const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
  result += `${docStr}\n`;
}

// After:
if (node.docString) {
  let content = "";
  for (const seg of node.docString.segments) {
    if (seg.type === "text") {
      content += seg.value;
    } else {
      content += `\${${this.processNode(seg.expression).trim()}}`;
    }
  }
  const lines = content.split("\n").map(l => l.trim());
  const docLines = [`"""`, ...lines, `"""`];
  const docStr = docLines.map((line) => this.indentStr(line)).join("\n");
  result += `${docStr}\n`;
}
```

- [ ] **Step 2: Run the agency generator tests**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/agency-gen-test.log`
Expected: All pass.

- [ ] **Step 3: Add a formatter roundtrip test with interpolation**

Add a test case to `tests/formatter/roundtrip.agency` (or the appropriate formatter test file) that includes a doc string with interpolation:

```agency
const ver = "1.0"

def versioned() {
  """
  Tool version ${ver}.
  """
}
```

This verifies the agency generator correctly round-trips `${expr}` inside doc strings.

- [ ] **Step 4: Run the formatter roundtrip tests**

Run: `pnpm test:run tests/formatter/ 2>&1 | tee /tmp/formatter-test.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts tests/formatter/
git commit -m "fix: agency generator reconstructs doc strings from segments"
```

---

### Task 5: Update doc CLI and LSP completion

**Files:**
- Modify: `lib/cli/doc.ts:310,338`
- Modify: `lib/lsp/completion.ts:58`

- [ ] **Step 1: Create a shared helper that reconstructs doc string text**

Rather than rendering interpolations as opaque `${...}` placeholders, reconstruct the source-form `${expr}` so the rendered doc / hover shows the developer which expression is interpolated. Use the existing `AgencyGenerator.processNode` printer.

Add the helper to `lib/utils/` (a new file `lib/utils/docStringText.ts`), so both `lib/cli/doc.ts` and `lib/lsp/completion.ts` can import it:

```typescript
// lib/utils/docStringText.ts
import { AgencyGenerator } from "@/backends/agencyGenerator.js";
import { MultiLineStringLiteral } from "@/types/literals.js";

export function docStringText(docString: MultiLineStringLiteral): string {
  const gen = new AgencyGenerator();
  return docString.segments
    .map((s) =>
      s.type === "text"
        ? s.value
        : `\${${gen.processNode(s.expression).trim()}}`,
    )
    .join("");
}
```

Verify `AgencyGenerator` has a zero-arg constructor (or pass whatever args the existing call sites use). If construction is expensive or requires config, accept an optional generator parameter:

```typescript
export function docStringText(
  docString: MultiLineStringLiteral,
  gen: AgencyGenerator = new AgencyGenerator(),
): string { ... }
```

- [ ] **Step 2: Update the two doc.ts call sites**

```typescript
// Before (line 310):
fn.docString ? fn.docString.value : null,
// After:
fn.docString ? docStringText(fn.docString) : null,

// Before (line 338):
node.docString ? node.docString.value : null,
// After:
node.docString ? docStringText(node.docString) : null,
```

Add the import: `import { docStringText } from "@/utils/docStringText.js";`.

- [ ] **Step 3: Update LSP completion.ts**

In `lib/lsp/completion.ts:58`:

```typescript
// Before:
const doc = def.docString?.value;
// After:
const doc = def.docString ? docStringText(def.docString) : undefined;
```

Add the import: `import { docStringText } from "../utils/docStringText.js";`.

- [ ] **Step 4: Run the doc CLI tests**

Run: `pnpm test:run lib/cli/doc.test.ts 2>&1 | tee /tmp/doc-test.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/cli/doc.ts lib/lsp/completion.ts
git commit -m "fix: doc CLI and LSP extract text from segment-based doc strings"
```

---

### Task 6: Add type checker error for parameter interpolation in doc strings

**Files:**
- Modify: `lib/typeChecker/index.ts`
- Create: `lib/typeChecker/docstringParamInterpolation.test.ts`

- [ ] **Step 1: Write the type checker test**

Create `lib/typeChecker/docstringParamInterpolation.test.ts`. Follow the same pattern used by `lib/typeChecker/reservedNameDeclaration.test.ts`: use `parseAgency` + `SymbolTable.build` + `buildCompilationUnit` + `typeCheck`. Write a temp file so `SymbolTable.build` can resolve it.

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-docstring-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source);
    if (!parseResult.success) throw new Error("Parse failed");
    const program = parseResult.result;
    const info = buildCompilationUnit(program, symbolTable, absPath, source);
    return typeCheck(program, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

describe("doc string parameter interpolation", () => {
  it("errors when interpolating a function parameter in a doc string", () => {
    const errors = errorsFrom(`
def greet(name: string) {
  """Greets the person \${name}."""
}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0].message).toContain("'name'");
  });

  it("errors when interpolating a node parameter in a doc string", () => {
    const errors = errorsFrom(`
node main(user: string) {
  """Processes \${user}."""
}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(1);
    expect(relevant[0].message).toContain("'user'");
  });

  it("allows interpolating a global variable in a doc string", () => {
    const errors = errorsFrom(`
const version = "1.0"
def info() {
  """Version \${version}."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(0);
  });

  it("allows doc strings with no interpolation", () => {
    const errors = errorsFrom(`
def add(a: number, b: number) {
  """Adds two numbers."""
}
node main() {}
`);
    const relevant = errors.filter((e) =>
      e.message.includes("Cannot interpolate parameter"),
    );
    expect(relevant).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/typeChecker/docstringParamInterpolation.test.ts 2>&1 | tee /tmp/tc-docstring-test.log`
Expected: FAIL — the check doesn't exist yet. The "errors when interpolating" tests will fail because `result.errors` is empty.

- [ ] **Step 3: Implement the check**

In `lib/typeChecker/index.ts`, add a new check in the `check()` method. Place it after the existing `checkValidatedParamReturn` loop (around line 242), before step 2 (infer return types):

```typescript
// 1e. Doc strings must not interpolate function/node parameters.
// Parameter values are unknown at tool-definition time (the description
// is sent to the LLM *before* the function is called).
const checkDocStringParams = (
  name: string,
  def: FunctionDefinition | GraphNodeDefinition,
) => {
  if (!def.docString) return;
  const paramNames = def.parameters.map((p) => p.name);
  for (const seg of def.docString.segments) {
    if (
      seg.type === "interpolation" &&
      seg.expression.type === "variableName" &&
      paramNames.includes(seg.expression.value)
    ) {
      this.errors.push({
        message: `Cannot interpolate parameter '${seg.expression.value}' in doc string — parameter values are not known when the tool description is sent to the LLM. Use a global variable instead.`,
        // `InterpolationSegment` now has a loc (added in Task 1 Step 0).
        // Fall back to the doc-string loc if for some reason it's missing.
        loc: seg.loc ?? def.docString.loc,
      });
    }
  }
};
for (const [name, def] of Object.entries(this.functionDefs)) {
  checkDocStringParams(name, def);
}
for (const [name, def] of Object.entries(this.nodeDefs)) {
  checkDocStringParams(name, def);
}
```

- [ ] **Step 4: Run the type checker test**

Run: `pnpm test:run lib/typeChecker/docstringParamInterpolation.test.ts 2>&1 | tee /tmp/tc-docstring-test2.log`
Expected: All pass.

- [ ] **Step 5: Run the full type checker test suite**

Run: `pnpm test:run lib/typeChecker/ 2>&1 | tee /tmp/tc-full-test.log`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/index.ts lib/typeChecker/docstringParamInterpolation.test.ts
git commit -m "feat: type checker rejects parameter interpolation in doc strings"
```

---

### Task 7: Add an agency execution test for doc string interpolation at runtime

**Files:**
- Create: `tests/agency/docstring-interpolation.agency`
- Create: `tests/agency/docstring-interpolation.test.ts`

- [ ] **Step 1: Write the Agency test file**

Create `tests/agency/docstring-interpolation.agency`:

```agency
const toolVersion = "2.0"

def versionedGreet(name: string): string {
  """
  Greets someone. Tool version: ${toolVersion}.
  """
}

node main() {
  let result = versionedGreet("Alice")
  return result
}
```

- [ ] **Step 2: Write the test**

Create `tests/agency/docstring-interpolation.test.ts`. The simplest and most reliable verification is at the generated-TypeScript level — does the emitted module contain a template literal that references the global? Two complementary checks:

1. **Compile-output check (cheap, deterministic):** Use the same path the existing `tests/typescriptGenerator/` fixtures use — compile the .agency file and assert the generated TS contains the template literal `` `Greets someone. Tool version: ${toolVersion}.` `` (or whatever shape `generateStringLiteralNode` produces — verify by running `pnpm run compile tests/agency/docstring-interpolation.agency` and reading the output before writing the assertion).

2. **Runtime check (verifies end-to-end):** Import the compiled module and read the `description` field from the tool object the generated TypeScript builds (whatever local variable or registry the typescriptBuilder emits at line ~1253). Assert the description string contains `"Tool version: 2.0."`. To find the exact registry shape, run `pnpm run compile tests/agency/docstring-interpolation.agency` once and inspect the output — copy whichever access path (e.g., `mod.__tools.versionedGreet.description` or similar) the generator produces. Look at any existing `tests/agency/*.test.ts` that imports the compiled module to match the import/exec pattern.

If introspecting the tool registry turns out to be awkward, the compile-output check alone is sufficient — it's what the typescriptGenerator fixture suite already does and it catches all the meaningful failure modes.

- [ ] **Step 3: Run the test**

Run: `pnpm run agency test tests/agency/docstring-interpolation.agency 2>&1 | tee /tmp/agency-docstring-test.log`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/docstring-interpolation.agency tests/agency/docstring-interpolation.test.ts
git commit -m "test: agency execution test for doc string interpolation"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/full-test.log`
Expected: All tests pass.

- [ ] **Step 2: Verify the original motivating example**

Run: `pnpm run compile foo.agency` and verify that `${name}` in the doc string now triggers a type checker error (since `name` is a parameter). Then update `foo.agency` to use a global variable and verify it compiles with interpolation.

- [ ] **Step 3: Clean up foo.agency**

Revert `foo.agency` to a clean state or delete it if it was just for this investigation.

- [ ] **Step 4: Rebuild all fixtures**

Run: `make fixtures`
Expected: Only the docstrings fixture changes (already handled in Task 3).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: rebuild fixtures after doc string interpolation support"
```
