# Source Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a statement-level source map to compiled Agency files, mapping each step/substep in the generated TypeScript back to the corresponding Agency source location.

**Architecture:** A new `SourceMapBuilder` class accumulates source location entries as the builder processes function/node bodies. It records the `_subStepPath` and `loc` for each statement. After building, the source map is serialized as a `TsRaw` node appended to the output sections.

**Tech Stack:** TypeScript, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/backends/sourceMap.ts` | Create | `SourceMapBuilder` class with `enterScope`, `record`, `build` methods |
| `lib/backends/sourceMap.test.ts` | Create | Unit tests for `SourceMapBuilder` |
| `lib/backends/typescriptBuilder.ts` | Modify | Integrate `SourceMapBuilder` — call `enterScope` in function/node processing, `record` in `processBodyAsParts` and branch body methods, emit source map in `build()` |
| `tests/typescriptGenerator/sourceMap.agency` | Create | Integration test fixture with if/else, for loop, functions |
| `tests/typescriptGenerator/sourceMap.mjs` | Create | Expected output for integration test fixture |

---

### Task 1: SourceMapBuilder class — failing tests

**Files:**
- Create: `lib/backends/sourceMap.test.ts`

- [ ] **Step 1: Write unit tests for SourceMapBuilder**

```ts
import { describe, it, expect } from "vitest";
import { SourceMapBuilder } from "./sourceMap.js";

describe("SourceMapBuilder", () => {
  it("records entries and builds correct structure", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], { line: 1, col: 2, start: 0, end: 10 });
    builder.record([1], { line: 3, col: 2, start: 20, end: 30 });

    const result = builder.build();
    expect(result).toEqual({
      "foo.agency:main": {
        "0": { line: 1, col: 2, start: 0, end: 10 },
        "1": { line: 3, col: 2, start: 20, end: 30 },
      },
    });
  });

  it("handles multiple scopes", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], { line: 1, col: 2, start: 0, end: 10 });
    builder.enterScope("foo.agency", "greet");
    builder.record([0], { line: 5, col: 2, start: 50, end: 60 });

    const result = builder.build();
    expect(result).toHaveProperty("foo.agency:main");
    expect(result).toHaveProperty("foo.agency:greet");
  });

  it("silently skips undefined loc", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([0], undefined);
    builder.record([1], { line: 3, col: 2, start: 20, end: 30 });

    const result = builder.build();
    expect(result["foo.agency:main"]).toEqual({
      "1": { line: 3, col: 2, start: 20, end: 30 },
    });
  });

  it("formats substep paths with dot separator", () => {
    const builder = new SourceMapBuilder();
    builder.enterScope("foo.agency", "main");
    builder.record([2, 0, 1], { line: 10, col: 4, start: 100, end: 120 });

    const result = builder.build();
    expect(result["foo.agency:main"]).toHaveProperty("2.0.1");
  });

  it("returns empty object when nothing recorded", () => {
    const builder = new SourceMapBuilder();
    expect(builder.build()).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/backends/sourceMap.test.ts`
Expected: FAIL — cannot resolve `./sourceMap.js`

---

### Task 2: SourceMapBuilder class — implementation

**Files:**
- Create: `lib/backends/sourceMap.ts`

- [ ] **Step 3: Implement SourceMapBuilder**

```ts
import type { SourceLocation } from "../types/base.js";

export type SourceMap = Record<string, Record<string, SourceLocation>>;

export class SourceMapBuilder {
  private currentKey: string = "";
  private map: SourceMap = {};

  enterScope(moduleId: string, scopeName: string): void {
    this.currentKey = `${moduleId}:${scopeName}`;
    if (!this.map[this.currentKey]) {
      this.map[this.currentKey] = {};
    }
  }

  record(subStepPath: number[], loc: SourceLocation | undefined): void {
    if (!loc || !this.currentKey) return;
    this.map[this.currentKey][subStepPath.join(".")] = loc;
  }

  build(): SourceMap {
    return this.map;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/backends/sourceMap.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/backends/sourceMap.ts lib/backends/sourceMap.test.ts
git commit -m "feat: add SourceMapBuilder class for statement-level source maps"
```

---

### Task 3: Integrate SourceMapBuilder into TypeScriptBuilder

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 6: Add SourceMapBuilder instance property**

Add import at top of `typescriptBuilder.ts`:

```ts
import { SourceMapBuilder } from "./sourceMap.js";
```

Add instance property after `private _subStepPath: number[] = [];` (line 146):

```ts
private _sourceMapBuilder: SourceMapBuilder = new SourceMapBuilder();
```

- [ ] **Step 7: Call `enterScope` in `processFunctionDefinition` and `processGraphNode`**

In `processFunctionDefinition` (line ~1051), add after `this.startScope(...)`:

```ts
this._sourceMapBuilder.enterScope(this.moduleId, node.functionName);
```

In `processGraphNode` (line ~1404), add after `this.startScope(...)`:

```ts
this._sourceMapBuilder.enterScope(this.moduleId, node.nodeName);
```

- [ ] **Step 8: Call `record` in `processBodyAsParts`**

In `processBodyAsParts` (line ~2185), add a `record` call right after `this._subStepPath.push(stepIndex)` and before `const processed = this.processStatement(stmt)`:

```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

- [ ] **Step 9: Call `record` in branch body processing methods**

In each method that processes branch/loop bodies with substep tracking, add a `record` call after pushing to `_subStepPath` and before processing:

**`processIfElseWithSteps`** — inside `processBranchBody` (line ~722), after `this._subStepPath.push(i)`:
```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

**`processForLoopWithSteps`** — inside the body map (line ~780), after `this._subStepPath.push(i)`:
```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

**`processWhileLoopWithSteps`** — inside the body map (line ~846), after `this._subStepPath.push(i)`:
```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

**`processMatchBlockWithSteps`** — No changes needed. Match block cases have a single `body` node (not an array of statements), so there is no substep iteration within cases. The match block itself gets recorded at the top level via `processBodyAsParts`. The `ts.ifSteps` call handles branch selection at the IR level.

**`processMessageThread`** — This method uses a different substep pattern: it fully reassigns `_subStepPath` (`this._subStepPath = [...subStepPath]`) then pushes `i + 1` (because substep 0 is the thread setup). Add the `record` call after `this._subStepPath.push(i + 1)` (line ~2018) and before `const result = this.processStatement(stmt)`:
```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

**`processHandleBlockWithSteps`** — inside the body map (line ~2150), after `this._subStepPath.push(i)`:
```ts
this._sourceMapBuilder.record([...this._subStepPath], stmt.loc);
```

- [ ] **Step 10: Emit source map at end of `build()`**

In the `build()` method, right before `return ts.statements(sections)` (line ~472), add:

```ts
sections.push(ts.raw(`export const __sourceMap = ${JSON.stringify(this._sourceMapBuilder.build())};`));
```

- [ ] **Step 11: Run existing tests to verify nothing breaks**

Run: `pnpm vitest run lib/backends/typescriptBuilder.integration.test.ts`
Expected: Existing tests may fail because fixtures now lack `__sourceMap`. This is expected — we need to regenerate fixtures.

- [ ] **Step 12: Regenerate fixtures**

Run: `make fixtures`
Expected: All `.mjs` fixture files updated with `__sourceMap` export at end of file.

- [ ] **Step 13: Run all integration tests**

Run: `pnpm vitest run lib/backends/typescriptBuilder.integration.test.ts lib/backends/typescriptGenerator.integration.test.ts`
Expected: All PASS

- [ ] **Step 14: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/backends/sourceMap.ts
git add tests/typescriptGenerator/ tests/typescriptBuilder/
git commit -m "feat: integrate SourceMapBuilder into TypeScriptBuilder"
```

---

### Task 4: Integration test fixture

**Files:**
- Create: `tests/typescriptGenerator/sourceMap.agency`
- Create: `tests/typescriptGenerator/sourceMap.mjs`

- [ ] **Step 15: Create Agency fixture with mixed constructs**

Create `tests/typescriptGenerator/sourceMap.agency` with a function containing an if/else and a for loop — enough to exercise top-level steps and substeps:

```agency
fn greet(name: string) -> string
  result = ask "Hello {name}" -> string
  return result

node main
  x = 1
  if x == 1
    y = 2
  else
    y = 3
  for item in ["a", "b"]
    z = item
```

- [ ] **Step 16: Generate the expected output**

Run the compiler on the fixture to produce the `.mjs` file:

```bash
pnpm run compile tests/typescriptGenerator/sourceMap.agency
```

Then copy the generated output to `tests/typescriptGenerator/sourceMap.mjs`. Verify it contains `export const __sourceMap = ...` at the end with scope keys `"sourceMap.agency:greet"` and `"sourceMap.agency:main"`.

Alternatively, run `make fixtures` to regenerate all fixtures including this one.

- [ ] **Step 17: Verify the source map structure**

Inspect the generated `.mjs` — confirm:
- The `__sourceMap` export exists at end of file
- It has entries for `"sourceMap.agency:greet"` and `"sourceMap.agency:main"`
- Top-level steps have keys like `"0"`, `"1"`, etc.
- Substeps inside if/else and for loop have dot-separated keys like `"2.0"`, `"3.0"`
- `loc` values contain `line`, `col`, `start`, `end` fields — the parser populates `loc` via `withLoc()` for assignments, if/else, for loops, while loops, functions, graph nodes, and debugger statements. Statements without `withLoc` wiring will be silently skipped.

**Note on debugger mode:** When `agencyConfig.debugger` is true, the builder inserts synthetic `debuggerStatement` nodes before each step in `processBodyAsParts`. These synthetic nodes are created inline as `{ type: "debuggerStatement" }` (line ~2169) and will **not** have `loc` since they're not parsed. They are silently skipped by `record()`. Step indices in the source map will differ between debugger and non-debugger compilations because the synthetic steps shift indices, but this is correct — the source map always matches the generated code it accompanies. User-written `debugger` statements parsed from source **will** have `loc` (via `withLoc`) and will be recorded normally.

- [ ] **Step 18: Run integration tests**

Run: `pnpm vitest run lib/backends/typescriptGenerator.integration.test.ts`
Expected: All PASS, including the new sourceMap fixture.

- [ ] **Step 19: Commit**

```bash
git add tests/typescriptGenerator/sourceMap.agency tests/typescriptGenerator/sourceMap.mjs
git commit -m "test: add source map integration test fixture"
```
