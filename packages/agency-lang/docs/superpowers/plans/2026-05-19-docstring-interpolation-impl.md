# Doc String Interpolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Reference spec: `docs/superpowers/plans/2026-05-19-docstring-interpolation.md`.

**Goal:** Support `${expr}` interpolation in `"""..."""` doc strings, with a type checker error when a function/node parameter is interpolated.

**Strategy:** Collapse the `DocString` AST type into the existing `MultiLineStringLiteral`, give `InterpolationSegment` a `loc`, then sweep the seven consumers (parser, TS builder, agency generator, doc CLI, LSP completion, type checker, tests). Each task is independently committable.

---

## Pre-flight

- [ ] **Sanity check the current tree is green**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/preflight-test.log
  ```

  If any failures exist that are unrelated to this work, surface them before continuing.

- [ ] **Confirm working baseline file (foo.agency)**

  Note the current contents of `foo.agency` — Task 8 Step 3 may need to revert it. If you don't intend to touch `foo.agency`, skip that step.

---

## Task 1 — Type updates + `InterpolationSegment` loc

**Goal:** Land the type-level changes (no behavior change yet). Many consumers will start failing typecheck — that's expected.

- [ ] **Step 1: Give `InterpolationSegment` a loc**

  `lib/types/literals.ts`:

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

- [ ] **Step 2: Wrap `interpolationSegmentParser` with `withLoc`**

  `lib/parsers/parsers.ts:333-355`:

  ```typescript
  export const interpolationSegmentParser: Parser<InterpolationSegment> = withLoc((
    input: string,
  ) => { ... existing body ... });
  ```

  `withLoc` is already imported in this file (used many other places).

- [ ] **Step 3: Verify loc is attached**

  ```bash
  cat > /tmp/test-loc.agency << 'EOF'
  const x = "world"
  const s = """${x}"""
  node main() {}
  EOF
  pnpm run ast /tmp/test-loc.agency 2>&1 | grep -A 8 "interpolation"
  ```

  Confirm the interpolation segment now has a `loc` block with `start`/`end` spanning `${...}`.

- [ ] **Step 4: Remove `DocString` type from `lib/types/function.ts`**

  - Remove the `DocString` type definition (currently lines 68-71).
  - Replace the `DocString` import in this file (if any) with `MultiLineStringLiteral` from `./literals.js`.
  - Change `docString?: DocString;` on `FunctionDefinition` → `docString?: MultiLineStringLiteral;`.

- [ ] **Step 5: Update `lib/types/graphNode.ts`**

  - Remove the `DocString` import.
  - Add `MultiLineStringLiteral` to the import from `./literals.js`.
  - Change `docString?: DocString;` → `docString?: MultiLineStringLiteral;`.

- [ ] **Step 6: Verify only `parsers.ts` still references `DocString`**

  ```bash
  grep -rn "DocString" lib/ --include="*.ts" | grep -v ".test." | grep -v "dist/"
  ```

  Expected output: only `lib/parsers/parsers.ts` lines. Anything else is a missed reference — fix it before moving on.

- [ ] **Step 7: Confirm typecheck failures match expectations**

  ```bash
  npx tsc --noEmit 2>&1 | tee /tmp/task1-tsc.log | head -60
  ```

  Expected errors in: `parsers.ts` (parser return type), `typescriptBuilder.ts` (uses `.value`), `agencyGenerator.ts` (uses `.value`), `cli/doc.ts` (uses `.value`), `lsp/completion.ts` (uses `.value`). No other errors. These will be fixed in subsequent tasks.

- [ ] **Step 8: Commit**

  ```bash
  git add lib/types/literals.ts lib/types/function.ts lib/types/graphNode.ts lib/parsers/parsers.ts
  git commit -m "refactor: replace DocString with MultiLineStringLiteral; add loc to InterpolationSegment"
  ```

  (`parsers.ts` only gets the `withLoc` wrap here — the larger rewrite is in Task 2.)

---

## Task 2 — Rewrite `docStringParser`

**Goal:** `docStringParser` now returns `MultiLineStringLiteral` with proper segment handling and trimming.

- [ ] **Step 1: Update ONLY the `docStringParser`-block tests in `function.test.ts`**

  Locate `describe("docStringParser", ...)`. Do NOT touch the function/node parser tests further down. Replace every `{ type: "docString", value: "X" }` with `{ type: "multiLineString", segments: [{ type: "text", value: "X" }] }`. Whitespace-only / empty cases become `segments: []`. The previously-rejected `""""""` case should now succeed with `segments: []`.

  Add new fixtures for interpolation (see spec for exact shape):
  - `"""Hello ${name}"""` → `[text("Hello "), interp(name)]`
  - `"""The count is ${count} items"""` → `[text("The count is "), interp(count), text(" items")]`
  - `"""\n  ${name} is great\n  """` → `[interp(name), text(" is great")]` (leading whitespace trimmed off the empty text segment ahead of the interpolation)
  - `"""Version ${ver}\n  """` → `[text("Version "), interp(ver)]`
  - `"""  ${a}  ${b}  """` → `[interp(a), text("  "), interp(b)]` (inner whitespace preserved)

  Use `expect.objectContaining(...)` or strip `loc` fields before comparison — interpolation segments and inner expressions now carry `loc`.

- [ ] **Step 2: Verify the tests fail**

  ```bash
  pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/task2-step2.log
  ```

  Expected: the `docStringParser`-block tests fail (parser still returns `DocString`).

- [ ] **Step 3: Rewrite `docStringParser` to return a fresh `MultiLineStringLiteral`**

  In `lib/parsers/parsers.ts`, replace the existing parser. Remove the `DocString` import. Make sure `PromptSegment`, `MultiLineStringLiteral`, and `success` are imported (they should already be).

  ```typescript
  export const docStringParser: Parser<MultiLineStringLiteral> = (input: string) => {
    const result = multiLineStringParser(input);
    if (!result.success) return result;

    // Build a fresh segments array — do not mutate the array or segment
    // objects owned by `result.result`.
    const orig = result.result.segments;
    const trimmed: PromptSegment[] = orig.map((s) => ({ ...s }));

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

    const segments = trimmed.filter(
      (s) => s.type !== "text" || s.value !== "",
    );

    return success(
      { type: "multiLineString" as const, segments, loc: result.result.loc },
      result.rest,
    );
  };
  ```

- [ ] **Step 4: Verify the `docStringParser`-block tests pass**

  ```bash
  pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/task2-step4.log
  ```

  Expected: the doc-string-parser describe block passes; the function/node parser tests further down still fail (they expect the old shape). That's Step 5.

- [ ] **Step 5: Sweep the function/node parser test expectations**

  In `lib/parsers/function.test.ts`, find every occurrence of `docString: { type: "docString", value: "X" }` and rewrite it to `docString: { type: "multiLineString", segments: [{ type: "text", value: "X" }] }`. `docString: undefined` stays as-is.

  A targeted search/replace is fine; verify the diff before saving.

- [ ] **Step 6: Run all parser tests**

  ```bash
  pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/task2-step6.log
  ```

  Expected: all pass.

- [ ] **Step 7: Commit**

  ```bash
  git add lib/parsers/parsers.ts lib/parsers/function.test.ts
  git commit -m "feat: docStringParser returns MultiLineStringLiteral with interpolation support"
  ```

---

## Task 3 — TypeScript builder emits interpolated descriptions

**Goal:** Generated TS tool registrations contain template literals when doc strings have `${...}`.

- [ ] **Step 1: Update the description emission**

  `lib/backends/typescriptBuilder.ts` around line 1253:

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

  `generateStringLiteralNode` already produces a `ts.template(...)` and handles text + interpolation segments.

- [ ] **Step 2: Add an interpolation test case to the fixture**

  Append to `tests/typescriptGenerator/docstrings.agency`:

  ```agency
  const toolVersion = "2.0"

  def versionedTool() {
    """
    This tool is version ${toolVersion}.
    """
  }
  ```

- [ ] **Step 3: Rebuild the fixture**

  ```bash
  pnpm run compile tests/typescriptGenerator/docstrings.agency > tests/typescriptGenerator/docstrings.mjs 2>&1
  ```

  Read the diff. For existing (non-interpolated) doc strings, the output should be functionally equivalent (a template literal with no `${}` expressions, or possibly a plain string). For the new `versionedTool`, the description line must include `${toolVersion}` inside a template literal.

- [ ] **Step 4: Run the TS generator tests**

  ```bash
  pnpm test:run tests/typescriptGenerator/ 2>&1 | tee /tmp/task3-tsgen.log
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/docstrings.agency tests/typescriptGenerator/docstrings.mjs
  git commit -m "feat: emit interpolated doc string descriptions in generated TypeScript"
  ```

---

## Task 4 — Agency generator (formatter) round-trips segments

**Goal:** `pnpm run fmt` round-trips a doc string containing `${...}` without losing the interpolation.

- [ ] **Step 1: Update both doc-string emission blocks**

  `lib/backends/agencyGenerator.ts`, the function block (~line 647) and the node block (~line 1035). Both currently do:

  ```typescript
  const lines = node.docString.value.split("\n").map(l => l.trim());
  ```

  Replace each with:

  ```typescript
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

- [ ] **Step 2: Run agency generator tests**

  ```bash
  pnpm test:run lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/task4-gen.log
  ```

  Expected: all pass.

- [ ] **Step 3: Add a formatter round-trip case with interpolation**

  Locate the existing formatter roundtrip fixture (likely `tests/formatter/roundtrip.agency` or similar). Add:

  ```agency
  const ver = "1.0"

  def versioned() {
    """
    Tool version ${ver}.
    """
  }
  ```

  If the formatter tests work by snapshot or by re-parsing, make sure the new content survives one full round-trip.

- [ ] **Step 4: Run formatter tests**

  ```bash
  pnpm test:run tests/formatter/ 2>&1 | tee /tmp/task4-fmt.log
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/backends/agencyGenerator.ts tests/formatter/
  git commit -m "fix: agency generator reconstructs doc strings from segments"
  ```

---

## Task 5 — Doc CLI + LSP completion use a shared text helper

**Goal:** `doc` and LSP hover render interpolated expressions in source form (`${expr}`), not opaque `${...}` placeholders.

- [ ] **Step 1: Create the shared helper**

  Create `lib/utils/docStringText.ts`:

  ```typescript
  import { AgencyGenerator } from "@/backends/agencyGenerator.js";
  import { MultiLineStringLiteral } from "@/types/literals.js";

  export function docStringText(
    docString: MultiLineStringLiteral,
    gen: AgencyGenerator = new AgencyGenerator(),
  ): string {
    return docString.segments
      .map((s) =>
        s.type === "text"
          ? s.value
          : `\${${gen.processNode(s.expression).trim()}}`,
      )
      .join("");
  }
  ```

  Sanity-check: does `AgencyGenerator` have a zero-arg constructor? Read `lib/backends/agencyGenerator.ts` around `class AgencyGenerator` and either confirm it does or pass the required arguments. Adjust the helper if needed.

- [ ] **Step 2: Update `lib/cli/doc.ts` call sites (lines 310 and 338)**

  ```typescript
  // Before:
  fn.docString ? fn.docString.value : null,
  // After:
  fn.docString ? docStringText(fn.docString) : null,
  ```

  ```typescript
  // Before:
  node.docString ? node.docString.value : null,
  // After:
  node.docString ? docStringText(node.docString) : null,
  ```

  Add: `import { docStringText } from "@/utils/docStringText.js";`.

- [ ] **Step 3: Update `lib/lsp/completion.ts` line 58**

  ```typescript
  // Before:
  const doc = def.docString?.value;
  // After:
  const doc = def.docString ? docStringText(def.docString) : undefined;
  ```

  Add: `import { docStringText } from "../utils/docStringText.js";`.

- [ ] **Step 4: Run doc CLI and LSP tests**

  ```bash
  pnpm test:run lib/cli/doc.test.ts 2>&1 | tee /tmp/task5-doc.log
  pnpm test:run lib/lsp/ 2>&1 | tee /tmp/task5-lsp.log
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add lib/utils/docStringText.ts lib/cli/doc.ts lib/lsp/completion.ts
  git commit -m "fix: doc CLI and LSP render doc string interpolations as ${expr}"
  ```

---

## Task 6 — Type checker rejects parameter interpolation

**Goal:** Compile-time error when a doc string contains `${param}` where `param` is a function/node parameter.

- [ ] **Step 1: Write the type checker test**

  Create `lib/typeChecker/docstringParamInterpolation.test.ts` (full source in the spec). It should cover four cases:
  1. function with `${name}` where `name` is a parameter → error
  2. node with `${user}` where `user` is a parameter → error
  3. function with `${version}` where `version` is a `const` global → no error
  4. function with no interpolation → no error

  Pattern matches `lib/typeChecker/reservedNameDeclaration.test.ts`: writes a temp `.agency` file, runs `parseAgency` + `SymbolTable.build` + `buildCompilationUnit` + `typeCheck`, filters errors by message substring.

- [ ] **Step 2: Verify tests fail (check not yet implemented)**

  ```bash
  pnpm test:run lib/typeChecker/docstringParamInterpolation.test.ts 2>&1 | tee /tmp/task6-step2.log
  ```

  Expected: the two "errors when interpolating" cases fail (no error is produced); the two "allows" cases pass.

- [ ] **Step 3: Implement the check**

  In `lib/typeChecker/index.ts`, after the `checkValidatedParamReturn` loop (~line 242), add:

  ```typescript
  // Doc strings must not interpolate function/node parameters — parameter
  // values are not bound when the tool description is built at module load.
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

  Make sure `FunctionDefinition` and `GraphNodeDefinition` are imported at the top of the file (they almost certainly already are).

- [ ] **Step 4: Verify the new tests pass**

  ```bash
  pnpm test:run lib/typeChecker/docstringParamInterpolation.test.ts 2>&1 | tee /tmp/task6-step4.log
  ```

  Expected: all four pass.

- [ ] **Step 5: Run the full type checker suite**

  ```bash
  pnpm test:run lib/typeChecker/ 2>&1 | tee /tmp/task6-step5.log
  ```

  Expected: all pass.

- [ ] **Step 6: Commit**

  ```bash
  git add lib/typeChecker/index.ts lib/typeChecker/docstringParamInterpolation.test.ts
  git commit -m "feat: type checker rejects parameter interpolation in doc strings"
  ```

---

## Task 7 — Agency execution test

**Goal:** Sanity-check that interpolation actually works end-to-end at runtime.

- [ ] **Step 1: Write `tests/agency/docstring-interpolation.agency`**

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

- [ ] **Step 2: Inspect the compile output to nail down the assertion**

  ```bash
  pnpm run compile tests/agency/docstring-interpolation.agency 2>&1 | tee /tmp/task7-compiled.mjs
  ```

  Find the line that emits the `versionedGreet` tool description and copy the exact registry access path (e.g. `mod.__tools.versionedGreet.description`).

- [ ] **Step 3: Write `tests/agency/docstring-interpolation.test.ts`**

  Use the simplest verification that catches the failure modes. Either:

  - Read the compiled `.mjs` text and assert it contains the template literal `` `…${toolVersion}…` ``. Cheap, deterministic, no execution needed.
  - Import the compiled module, then assert that whichever path holds the tool description contains the string `"Tool version: 2.0."`. Matches existing patterns under `tests/agency/`.

  Either is acceptable. If both are cheap, do both.

- [ ] **Step 4: Run the test**

  ```bash
  pnpm run agency test tests/agency/docstring-interpolation.agency 2>&1 | tee /tmp/task7-run.log
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/agency/docstring-interpolation.agency tests/agency/docstring-interpolation.test.ts
  git commit -m "test: agency execution test for doc string interpolation"
  ```

---

## Task 8 — Final verification

- [ ] **Step 1: Run the full test suite (save to file!)**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/full-test.log
  ```

  Expected: green. If anything fails, fix before moving on — don't re-run blindly.

- [ ] **Step 2: Rebuild all fixtures**

  ```bash
  make fixtures 2>&1 | tee /tmp/fixtures.log
  ```

  Expected: only `tests/typescriptGenerator/docstrings.mjs` changes (already committed in Task 3). If anything else changes, inspect — those are downstream effects you need to understand and either accept or revert.

- [ ] **Step 3: Verify the structural linter**

  ```bash
  pnpm run lint:structure 2>&1 | tee /tmp/lint.log
  ```

  Expected: clean.

- [ ] **Step 4: Manually exercise the original motivating example**

  Edit `foo.agency` (or any sandbox file) so a function has `"""Greets ${name}"""` with `name` as a parameter. Run `pnpm run compile foo.agency`. Verify the type checker error fires with the new message. Then change it to use a global and verify it compiles cleanly with a template literal in the output.

  When done, revert `foo.agency` to its pre-task state.

- [ ] **Step 5: Final commit (only if anything was modified above)**

  ```bash
  git add -A
  git commit -m "chore: rebuild fixtures after doc string interpolation support"
  ```

---

## Roll-back strategy

Each task ends in a clean commit, so any single task can be reverted with `git revert <sha>`. Task 1 is the only one that other tasks depend on (the type rename) — reverting it requires reverting all subsequent tasks. The recommended unwind order is the reverse of the implementation order: Task 7 → 6 → 5 → 4 → 3 → 2 → 1.
