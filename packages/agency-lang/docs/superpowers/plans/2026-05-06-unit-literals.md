# Unit Literals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unit literal syntax (`30s`, `500ms`, `2h`, `7d`, `$5.00`) that compiles to plain numbers, migrate stdlib time functions to milliseconds, and add a unified `add()` to the date stdlib.

**Architecture:** Unit literals are a new AST node type parsed as a variant of numeric literals. At compile time, the value is multiplied by a canonical multiplier and emitted as a plain number. The typechecker catches dimension mismatches only when both sides of a binary expression are direct unit literal nodes (no variable tracking — dimensions are erased once assigned). Stdlib functions are updated to accept milliseconds as the canonical time unit.

**Tech Stack:** Tarsec (parser), TypeScript IR, existing runtime/stdlib

**Spec:** `docs/superpowers/specs/2026-05-06-unit-literals-design.md`

**Breaking changes:** This plan adopts Option 1 from the spec — just break `sleep`, `exec`, and `bash` (Agency is pre-1.0). `sleep(1)` will now sleep for 1ms, not 1s. Users should write `sleep(1s)`.

**Note:** The failure type standardization (`error: string` + `data` field) is NOT part of this plan. It will be done as part of the guards implementation plan instead.

---

## File Structure

### New files:
- `lib/parsers/unitLiteral.ts` — parser for unit suffix literals
- `lib/parsers/unitLiteral.test.ts` — unit tests

### Modified files:
- `lib/types/literals.ts` — add `UnitLiteral` type
- `lib/types.ts` — add `UnitLiteral` to `Literal` union and `AgencyNode` union
- `lib/parsers/parsers.ts` — wire unit literal parser into expression parsing (before `numberParser`)
- `lib/backends/typescriptBuilder.ts` — emit canonical number for `unitLiteral` nodes (both `processNode` switch and `generateLiteral` switch)
- `lib/backends/agencyGenerator.ts` — round-trip unit literals back to source
- `lib/typeChecker.ts` — dimension mismatch detection (using a side map)
- `lib/preprocessors/typescriptPreprocessor.ts` — handle unitLiteral traversal (if switch exists)
- `lib/compilationUnit.ts` — handle unitLiteral (if switch exists)
- `stdlib/index.agency` — update `sleep` signature
- `stdlib/lib/builtins.ts` — update `_sleep` implementation
- `lib/templates/backends/typescriptGenerator/builtinFunctions/sleep.mustache` — update builtin sleep
- `stdlib/shell.agency` — update `exec`/`bash` timeout params
- `stdlib/lib/shell.ts` — update timeout handling
- `stdlib/browser.agency` — rename `timeoutMs` to `timeout`
- `stdlib/date.agency` — add `add()` function
- `stdlib/lib/date.ts` — add `_add` implementation
- `stdlib/lib/__tests__/date.test.ts` — test for `_add`
- `docs-new/guide/basic-syntax.md` — document unit literals
- Fixture files in `tests/typescriptGenerator/`

---

### Task 1: Define the UnitLiteral AST node type

**Files:**
- Modify: `lib/types/literals.ts`
- Modify: `lib/types.ts`

- [ ] **Step 1: Read the existing literal types**

Read `lib/types/literals.ts` and `lib/types.ts` to see how `NumberLiteral` and the `Literal` union are defined.

- [ ] **Step 2: Add the UnitLiteral type**

In `lib/types/literals.ts`, add:

```ts
export type UnitLiteral = BaseNode & {
  type: "unitLiteral";
  value: string;          // raw numeric part: "30", "5.00", "500"
  unit: string;           // "ms" | "s" | "m" | "h" | "d" | "w" | "$"
  canonicalValue: number; // normalized value: 30000 for 30s, 5.00 for $5.00
  dimension: "time" | "cost";
};
```

- [ ] **Step 3: Add to the Literal union and AgencyNode union**

In `lib/types/literals.ts`, add `UnitLiteral` to the `Literal` union type.
In `lib/types.ts`, export `UnitLiteral` and ensure it's part of `AgencyNode` (it should be via the `Literal` union).

- [ ] **Step 4: Commit**

```bash
git add lib/types/literals.ts lib/types.ts
git commit -m "feat: add UnitLiteral AST node type"
```

---

### Task 2: Parse unit literals

**Files:**
- Create: `lib/parsers/unitLiteral.ts`
- Create: `lib/parsers/unitLiteral.test.ts`
- Modify: `lib/parsers/parsers.ts`

- [ ] **Step 1: Write failing parser tests**

Create `lib/parsers/unitLiteral.test.ts`:

```ts
import { unitLiteralParser } from "./unitLiteral.js";

describe("unitLiteralParser", () => {
  // Time units
  test("parses milliseconds", () => {
    const result = unitLiteralParser("500ms");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("ms");
    expect(result.value.canonicalValue).toBe(500);
    expect(result.value.dimension).toBe("time");
  });

  test("parses seconds", () => {
    const result = unitLiteralParser("30s");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("s");
    expect(result.value.canonicalValue).toBe(30000);
  });

  test("parses minutes", () => {
    const result = unitLiteralParser("5m");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(300000);
  });

  test("parses hours", () => {
    const result = unitLiteralParser("2h");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(7200000);
  });

  test("parses days", () => {
    const result = unitLiteralParser("7d");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(604800000);
  });

  test("parses weeks", () => {
    const result = unitLiteralParser("1w");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(604800000);
  });

  test("parses decimal time values", () => {
    const result = unitLiteralParser("0.5s");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(500);
  });

  // Cost units
  test("parses dollar cost", () => {
    const result = unitLiteralParser("$5.00");
    expect(result.success).toBe(true);
    expect(result.value.unit).toBe("$");
    expect(result.value.canonicalValue).toBe(5.00);
    expect(result.value.dimension).toBe("cost");
  });

  test("parses dollar cost without decimals", () => {
    const result = unitLiteralParser("$10");
    expect(result.success).toBe(true);
    expect(result.value.canonicalValue).toBe(10);
  });

  // Negative cases
  test("does not parse plain numbers", () => {
    const result = unitLiteralParser("42");
    expect(result.success).toBe(false);
  });

  test("does not parse bare identifiers", () => {
    const result = unitLiteralParser("seconds");
    expect(result.success).toBe(false);
  });

  test("does not parse bare unit suffixes without a number", () => {
    expect(unitLiteralParser("m").success).toBe(false);
    expect(unitLiteralParser("ms").success).toBe(false);
    expect(unitLiteralParser("s").success).toBe(false);
    expect(unitLiteralParser("h").success).toBe(false);
  });

  test("does not conflict with string interpolation", () => {
    // $ followed by { is interpolation, not a cost literal
    const result = unitLiteralParser("${foo}");
    expect(result.success).toBe(false);
  });

  test("negative unit literals parse as unary minus + unit literal", () => {
    // -5s should NOT parse as a single unit literal
    // (the unary minus is handled at the expression level)
    const result = unitLiteralParser("-5s");
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- --testPathPattern unitLiteral 2>&1 | tee /tmp/claude/task2-fail.log`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the unit literal parser**

Create `lib/parsers/unitLiteral.ts`. The parser needs to handle two forms:

1. **Time literals:** `<number><suffix>` where suffix is `ms|s|m|h|d|w`
2. **Cost literals:** `$<number>` (but NOT `${` — that's string interpolation)

Important: `ms` must be tried before `m` (longer match first). Use Tarsec combinators following the same patterns as `numberParser` in `parsers.ts`.

```ts
const MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
};

const DIMENSIONS: Record<string, "time" | "cost"> = {
  ms: "time", s: "time", m: "time",
  h: "time", d: "time", w: "time",
  "$": "cost",
};
```

For time units, parse a number (no leading `-`) followed immediately by a suffix (no whitespace).
For cost units, parse `$` followed immediately by a digit (NOT `{`), then the rest of the number.

Return a `UnitLiteral` node with `canonicalValue = parseFloat(rawNumber) * MULTIPLIERS[unit]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- --testPathPattern unitLiteral 2>&1 | tee /tmp/claude/task2-pass.log`
Expected: PASS.

- [ ] **Step 5: Wire into the expression parser**

In `lib/parsers/parsers.ts`, add `unitLiteralParser` to the primary expression / literal parser. It must be tried **before** `numberParser`, because `30s` would otherwise parse as the number `30` followed by identifier `s`.

- [ ] **Step 6: Write an end-to-end parse test**

Write a test that parses a full Agency statement like `const timeout = 30s` and verify the AST contains a `unitLiteral` node.

- [ ] **Step 7: Run all parser tests**

Run: `pnpm test:run -- --testPathPattern parser 2>&1 | tee /tmp/claude/task2-parsers.log`
Expected: All pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add lib/parsers/unitLiteral.ts lib/parsers/unitLiteral.test.ts lib/parsers/parsers.ts
git commit -m "feat: parse unit literals (ms, s, m, h, d, w, $)"
```

---

### Task 3: Code generation for unit literals

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`
- Create: `tests/typescriptGenerator/unitLiterals.agency` + `.mts`

- [ ] **Step 1: Write a fixture test**

Create `tests/typescriptGenerator/unitLiterals.agency`:

```ts
node main() {
  const a = 30s
  const b = 500ms
  const c = $5.00
  const d = 2h
  const e = 7d
  const f = 1w
  const g = 0.5s
  return a
}
```

Create the corresponding `.mts` expected output file. Unit literals should compile to their canonical values: `30s` -> `30000`, `500ms` -> `500`, `$5.00` -> `5.00`, `2h` -> `7200000`, `7d` -> `604800000`, `1w` -> `604800000`, `0.5s` -> `500`.

- [ ] **Step 2: Add case in typescriptBuilder.ts**

Two changes needed:

1. In the `processNode` switch statement (~line 831), add `"unitLiteral"` to the literal fall-through case that routes to `generateLiteral`:

```ts
case "number":
case "unitLiteral":  // <-- add this
case "multiLineString":
// ...
  return this.generateLiteral(node);
```

2. In the `generateLiteral` method (~line 961), add:

```ts
case "unitLiteral":
  return ts.num(node.canonicalValue);
```

- [ ] **Step 3: Run fixture tests**

Run: `pnpm test:run -- --testPathPattern typescriptGenerator 2>&1 | tee /tmp/claude/task3-fixtures.log`
Expected: New fixture passes, existing fixtures unaffected.

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/unitLiterals.agency tests/typescriptGenerator/unitLiterals.mts
git commit -m "feat: code generation for unit literals — emit canonical numbers"
```

---

### Task 4: Agency generator (formatter) support

**Files:**
- Modify: `lib/backends/agencyGenerator.ts`

- [ ] **Step 1: Read the generator's generateLiteral method**

Read `lib/backends/agencyGenerator.ts` around line 465 where `generateLiteral` handles the `"number"` case. Also check the `processNode` switch (~line 191) to see if `"unitLiteral"` needs adding there too.

- [ ] **Step 2: Add case for unitLiteral**

In `processNode`, add `"unitLiteral"` to the literal fall-through case (alongside `"number"`).

In `generateLiteral()`, add a case for `"unitLiteral"`. For cost literals, `$` goes before the number. For time literals, the suffix goes after:

```ts
case "unitLiteral":
  if (literal.unit === "$") {
    return `$${literal.value}`;
  }
  return `${literal.value}${literal.unit}`;
```

- [ ] **Step 3: Write a round-trip test**

Parse `const x = 30s`, format it with the generator, and verify the output is `const x = 30s` (not `const x = 30000`). Also test `$5.00` round-trips correctly.

- [ ] **Step 4: Run formatter tests**

Run: `pnpm test:run -- --testPathPattern agencyGenerator 2>&1 | tee /tmp/claude/task4-gen.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts
git commit -m "feat: agency generator round-trips unit literals"
```

---

### Task 5: Handle preprocessor and compilation unit traversal

This must be done before integration tests to avoid confusing failures.

**Files:**
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` (if needed)
- Modify: `lib/compilationUnit.ts` (if needed)
- Modify: `lib/symbolTable.ts` (if needed)

- [ ] **Step 1: Check if the preprocessor needs changes**

Read `lib/preprocessors/typescriptPreprocessor.ts` to see if it has a switch/case over node types that would throw on an unrecognized `"unitLiteral"` type. Since `unitLiteral` is a leaf node (no children to traverse), it likely just needs a no-op case added.

- [ ] **Step 2: Check compilationUnit.ts and symbolTable.ts similarly**

If they have switch statements over node types, add the `"unitLiteral"` case (likely a no-op passthrough).

- [ ] **Step 3: Run full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task5-traversal.log`
Expected: All pass.

- [ ] **Step 4: Commit (if changes were needed)**

```bash
git add lib/preprocessors/typescriptPreprocessor.ts lib/compilationUnit.ts lib/symbolTable.ts
git commit -m "feat: handle unitLiteral in preprocessor and compilation unit traversal"
```

---

### Task 6: Typechecker dimension mismatch detection

**Files:**
- Modify: `lib/typeChecker.ts` (or `lib/typeChecker/synthesizer.ts` — check which has the binary expression logic)
- Add test cases in typechecker tests

- [ ] **Step 1: Read how the typechecker handles binary expressions**

Read the typechecker to understand how it processes `BinOpExpression` nodes. The `synthType` function returns `VariableType | "any"`, and for numbers returns `NUMBER_T`. Look at `synthBinOp` around line 120 of `lib/typeChecker/synthesizer.ts`.

- [ ] **Step 2: Write failing typechecker tests**

Add tests that:
- `1s + 500ms` — no error (both are time dimension)
- `1s + $5.00` — error: cannot add time and cost
- `30s > $2.00` — error: cannot compare time and cost
- `30s * 2` — no error (dimensioned value * plain number is fine)
- `1s + 42` — no error (dimensioned + plain number is fine)
- `1h == 60m` — no error (same dimension, different units)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test:run -- --testPathPattern typeCheck 2>&1 | tee /tmp/claude/task6-fail.log`
Expected: FAIL — no dimension checking exists yet.

- [ ] **Step 4: Implement dimension checking on direct unit literal expressions**

Do NOT use a side map or track dimensions through variables. Unit literals compile to plain numbers, so once assigned to a variable (`const x = 30s` → `const x = 30000`), the dimension is gone. Tracking dimensions through assignments would be fighting the design.

Instead, only check dimensions when both sides of a binary expression are directly `unitLiteral` nodes. In the binary expression checker, inspect the left and right AST nodes: if both have `type === "unitLiteral"`, compare their `dimension` field. If they differ, emit an error.

This catches `1s + $5.00` (error) and allows `1s + 500ms` (both time). It does NOT catch `const x = 1s; x + $5.00` — and that's fine. The dimension check is a convenience for catching obvious mistakes at the literal level, not a full unit type system.

Operations that should check dimensions: `+`, `-`, `>`, `<`, `>=`, `<=`, `==`, `!=`.
Operations that should NOT check: `*`, `/` (scalar multiplication is fine).

- [ ] **Step 5: Run typechecker tests**

Run: `pnpm test:run -- --testPathPattern typeCheck 2>&1 | tee /tmp/claude/task6-pass.log`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker/
git commit -m "feat: typechecker dimension mismatch detection for unit literals"
```

---

### Task 7: Migrate sleep to milliseconds

**Files:**
- Modify: `stdlib/index.agency` — update `sleep` docstring/description
- Modify: `stdlib/lib/builtins.ts` — update `_sleep` implementation
- Modify: `lib/templates/backends/typescriptGenerator/builtinFunctions/sleep.mustache` — update builtin template

- [ ] **Step 1: Read the current sleep implementation**

Read `stdlib/index.agency` (the `sleep` function at line 25), `stdlib/lib/builtins.ts` (the `_sleep` function at line 38), and `lib/templates/backends/typescriptGenerator/builtinFunctions/sleep.mustache`.

- [ ] **Step 2: Update _sleep in builtins.ts**

Change from:
```ts
export function _sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
```

To:
```ts
export function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
```

- [ ] **Step 3: Update the sleep.mustache builtin template**

Change from:
```
function _builtinSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}
```

To:
```
function _builtinSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
```

- [ ] **Step 4: Run `pnpm run templates` to recompile mustache templates**

Run: `pnpm run templates`

- [ ] **Step 5: Update sleep docstring in stdlib/index.agency**

Update the `sleep` function signature and docstring to reflect milliseconds:

```ts
export safe def sleep(ms: number) {
  """
  Pause execution for the given duration in milliseconds. Use with unit literals for clarity: sleep(1s), sleep(500ms), sleep(2m).
  """
  _sleep(ms)
}
```

- [ ] **Step 6: Update sleep calls in test files and fixtures**

Search for all `sleep(` callsites:

```bash
grep -r "sleep(" tests/ stdlib/ --include="*.agency" --include="*.ts" --include="*.mts"
```

Update calls like `sleep(0.1)` (0.1 seconds) to `sleep(100ms)` in `.agency` files, or `sleep(100)` in `.ts`/`.mts` files. For compiled `.mts` fixture files, run `make fixtures` to regenerate them rather than editing manually.

- [ ] **Step 7: Run `make` to rebuild everything**

Run: `make`

- [ ] **Step 8: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task7-tests.log`
Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add stdlib/index.agency stdlib/lib/builtins.ts lib/templates/backends/typescriptGenerator/builtinFunctions/sleep.mustache tests/
git commit -m "feat: migrate sleep to milliseconds, works with unit literals"
```

---

### Task 8: Migrate exec/bash timeout to milliseconds

**Files:**
- Modify: `stdlib/shell.agency`
- Modify: `stdlib/lib/shell.ts`

- [ ] **Step 1: Read current shell implementations**

Read `stdlib/shell.agency` and `stdlib/lib/shell.ts` to understand how timeout is currently handled. In `shell.ts`, `buildSpawnOptions` at line 75 converts seconds to milliseconds: `options.timeout = timeout * 1000`. Node.js `child_process` `timeout` option is already in milliseconds.

- [ ] **Step 2: Update stdlib/lib/shell.ts**

In the `buildSpawnOptions` function, change from `if (timeout > 0) options.timeout = timeout * 1000;` to `if (timeout > 0) options.timeout = timeout;` — the input value is now already in milliseconds.

- [ ] **Step 3: Update stdlib/shell.agency docstrings**

Update `exec` and `bash` docstrings to say timeout is in milliseconds, suggest unit literals:

```ts
export def exec(command: string, args: string[] = [], cwd: string = "", timeout: number = 0, stdin: string = ""): ExecResult {
  """
  Run an executable directly with an array of arguments, bypassing the shell. ... Pass timeout in milliseconds to enforce a time limit (e.g. timeout: 30s). ...
  """
```

Do the same for `bash`.

- [ ] **Step 4: Run `make` to rebuild**

Run: `make`

- [ ] **Step 5: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task8-tests.log`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add stdlib/shell.agency stdlib/lib/shell.ts
git commit -m "feat: migrate exec/bash timeout to milliseconds"
```

---

### Task 9: Rename browserUse timeoutMs to timeout

**Files:**
- Modify: `stdlib/browser.agency`
- Modify: `stdlib/lib/browserUse.ts`

- [ ] **Step 1: Read current browser implementation**

Read `stdlib/browser.agency` and `stdlib/lib/browserUse.ts`. The internal implementation already uses milliseconds, so only the parameter name changes.

- [ ] **Step 2: Rename parameter**

In `stdlib/browser.agency`, rename `timeoutMs` to `timeout` in the `browserUse` function signature and body.

In `stdlib/lib/browserUse.ts`, rename accordingly. No conversion change needed.

- [ ] **Step 3: Run `make` to rebuild**

Run: `make`

- [ ] **Step 4: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task9-tests.log`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add stdlib/browser.agency stdlib/lib/browserUse.ts
git commit -m "feat: rename browserUse timeoutMs to timeout for consistency"
```

---

### Task 10: Add unified `add()` to date stdlib

**Files:**
- Modify: `stdlib/date.agency`
- Modify: `stdlib/lib/date.ts`
- Modify: `stdlib/lib/__tests__/date.test.ts`

- [ ] **Step 1: Read current date implementation**

Read `stdlib/lib/date.ts` to see how `_addMinutes`, `_addHours`, `_addDays` work. They all follow the same pattern: parse the datetime, add the value, format back to ISO.

- [ ] **Step 2: Write failing test for _add**

In `stdlib/lib/__tests__/date.test.ts`, add:

```ts
describe("_add", () => {
  it("adds milliseconds to a datetime", () => {
    const result = _add("2026-05-05T10:00:00-07:00", 7200000); // 2 hours
    expect(result).toContain("2026-05-05T12:00:00");
  });

  it("adds negative duration", () => {
    const result = _add("2026-05-05T10:00:00-07:00", -3600000); // -1 hour
    expect(result).toContain("2026-05-05T09:00:00");
  });

  it("adds days worth of milliseconds", () => {
    const result = _add("2026-05-05T10:00:00-07:00", 86400000); // 1 day
    expect(result).toContain("2026-05-06T10:00:00");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run -- --testPathPattern date 2>&1 | tee /tmp/claude/task10-fail.log`
Expected: FAIL — `_add` doesn't exist.

- [ ] **Step 4: Implement _add in stdlib/lib/date.ts**

```ts
export function _add(datetime: string, ms: number): string {
  const d = new Date(datetime);
  d.setTime(d.getTime() + ms);
  return formatISO(d, datetime);
}
```

Use the same formatting helper that the existing `_addMinutes` etc. use.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:run -- --testPathPattern date 2>&1 | tee /tmp/claude/task10-pass.log`
Expected: PASS.

- [ ] **Step 6: Export add from stdlib/date.agency**

Add `_add` to the import line at the top of `stdlib/date.agency`, then add:

```ts
/** Add a duration to a datetime string. Use with unit literals: add(now(), 2h), add(start, 7d) */
export safe def add(datetime: string, ms: number): string {
  """
  Add a duration in milliseconds to a datetime string. Returns a new ISO 8601 datetime string. Use with unit literals for clarity: add(now(), 2h), add(start, 30m), add(start, 7d). Negative values subtract.
  """
  return _add(datetime, ms)
}
```

- [ ] **Step 7: Update the module docstring**

Update the docstring at the top of `stdlib/date.agency` to include examples using the new `add()` function with unit literals.

- [ ] **Step 8: Run `make` to rebuild stdlib**

Run: `make`

- [ ] **Step 9: Run full tests**

Run: `pnpm test:run 2>&1 | tee /tmp/claude/task10-full.log`
Expected: All pass.

- [ ] **Step 10: Commit**

```bash
git add stdlib/date.agency stdlib/lib/date.ts stdlib/lib/__tests__/date.test.ts
git commit -m "feat: add unified add() function to date stdlib for use with unit literals"
```

---

### Task 11: Integration tests

**Files:**
- Create: `tests/agency/units/unitLiterals.agency`
- Create: `tests/agency/units/unitMath.agency`

- [ ] **Step 1: Write integration test for unit literals**

Create `tests/agency/units/unitLiterals.agency`:

```ts
node main() {
  const a = 1s
  const b = 500ms
  const c = a + b
  assert(c == 1500)

  const d = 2h
  assert(d == 7200000)

  const e = $5.00
  assert(e == 5.00)

  sleep(100ms)
  return "pass"
}
```

- [ ] **Step 2: Run integration test**

Run: `pnpm run agency test tests/agency/units/unitLiterals.agency 2>&1 | tee /tmp/claude/task11-test.log`
Expected: PASS — returns "pass".

- [ ] **Step 3: Write integration test for unit math**

Create `tests/agency/units/unitMath.agency`:

```ts
node main() {
  assert(1s > 500ms)
  assert(1s + 500ms == 1500)
  assert(2s * 3 == 6000)
  assert(1h == 60m)
  assert(1d == 24h)
  assert(1w == 7d)
  return "pass"
}
```

- [ ] **Step 4: Run integration test**

Run: `pnpm run agency test tests/agency/units/unitMath.agency 2>&1 | tee /tmp/claude/task11-math.log`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/agency/units/
git commit -m "test: integration tests for unit literals and unit math"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs-new/guide/basic-syntax.md`
- Already updated: `stdlib/date.agency` docstring (Task 10)

- [ ] **Step 1: Read current basic-syntax.md**

Read `docs-new/guide/basic-syntax.md` to find the right place to add the unit literals section. It should go after the primitives section (strings, numbers, booleans) and before arrays/objects.

- [ ] **Step 2: Add unit literals section**

Add a section after the primitives:

```markdown
### Unit literals

Agency supports unit literals for time and cost values. They compile to plain numbers at compile time:

```ts
const timeout = 30s       // compiles to 30000 (milliseconds)
const delay = 500ms       // compiles to 500
const duration = 2h       // compiles to 7200000
const week = 1w           // compiles to 604800000
const budget = $5.00      // compiles to 5.00
```

Supported time units: `ms` (milliseconds), `s` (seconds), `m` (minutes), `h` (hours), `d` (days), `w` (weeks). All time units normalize to milliseconds.

Supported cost units: `$` (dollars).

Unit math works because both sides normalize to the same base unit:

```ts
1s + 500ms       // 1000 + 500 = 1500
2s * 3           // 2000 * 3 = 6000
if (elapsed > 30s) { ... }
```

Mixing dimensions is a type error:

```ts
1s + $5.00    // ERROR: cannot add time and cost
```
```

- [ ] **Step 3: Commit**

```bash
git add docs-new/guide/basic-syntax.md
git commit -m "docs: add unit literals to basic syntax guide"
```
