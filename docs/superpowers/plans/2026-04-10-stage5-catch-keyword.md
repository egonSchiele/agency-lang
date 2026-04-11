# Catch Keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `catch` keyword that unwraps a `Result` with a fallback value, supporting chaining for sequential fallback attempts.

**Architecture:** `catch` is parsed as a binary operator with precedence between `|>` (lower) and `||` (higher). The builder desugars to `__catchResult(result, () => fallback)` where the fallback is lazily evaluated. Chaining works naturally: when the fallback is a `try` expression (which produces a `Result`), the next `catch` handles that Result. Typechecker rules for `catch` are deferred to Stage 7 (consolidated typechecker work).

**Tech Stack:** TypeScript, tarsec (parser combinators), vitest (testing)

**Dependencies:** This plan depends on the `Result` type and `ResultValue` from `lib/runtime/result.ts` (Stage 1). That file must exist before Task 3.

---

## Task 1: Add `"catch"` to the Operator type

**File:** `lib/types/binop.ts`

- [ ] Add `"catch"` to the `Operator` type union:
  ```typescript
  export type Operator = "+" | "-" | "*" | "/" | "==" | "!=" | "+=" | "-=" | "*=" | "/=" | "<" | ">" | "<=" | ">=" | "&&" | "||" | "!" | "|>" | "catch";
  ```

- [ ] Add `"catch"` to the `PRECEDENCE` map. Use precedence `0`, which sits between `|>` at `-1` and `||` at `1`:
  ```typescript
  "catch": 0,
  ```

**Verify:** `pnpm run build` — confirm no type errors.

---

## Task 2: Add `catch` to the expression parser precedence table

**File:** `lib/parsers/expression.ts`

- [ ] Add a new precedence level for `catch` in the operator table passed to `buildExpressionParser`. It must sit between `|>` (lowest) and `||` (next highest). In the array (which is ordered highest-first), `catch` goes just before `|>`:
  ```
  // ... existing levels ...
  // level for ||
  // level for catch  <-- new
  // level for |>     <-- lowest
  ```
  The entry should look like (matching the existing operator table format):
  ```typescript
  [
    { op: wsOp("catch"), assoc: "left" as const, apply: makeBinOp("catch") },
  ],
  ```

  **Important:** `wsOp` uses `str("catch")` internally, which will greedily match identifiers like "catcher" or "catching". You must add a word boundary check. Create a `wsKeyword` helper (or modify the `wsOp` call for "catch") that verifies the next character after "catch" is NOT alphanumeric or underscore. For example:
  ```typescript
  function wsKeyword(kw: string): Parser<string> {
    return (input: string) => {
      const r1 = optionalSpaces(input);
      if (!r1.success) return r1;
      const r2 = str(kw)(r1.rest);
      if (!r2.success) return r2;
      // Word boundary: next char must not be alphanumeric or underscore
      if (r2.rest.length > 0 && /[\w]/.test(r2.rest[0])) {
        return failure(`expected word boundary after '${kw}'`, input);
      }
      const r3 = optionalSpaces(r2.rest);
      if (!r3.success) return r3;
      return { success: true as const, result: kw, rest: r3.rest };
    };
  }
  ```
  Then use `wsKeyword("catch")` instead of `wsOp("catch")` in the operator table entry.

- [ ] Write a unit test in `lib/parsers/expression.test.ts`:
  ```typescript
  test("catch binary operator", () => {
    const result = exprParser("x catch 0");
    expect(result).toEqual({
      type: "binOpExpression",
      operator: "catch",
      left: { type: "identifier", value: "x" },
      right: { type: "numberLiteral", value: 0 },
    });
  });

  test("catch precedence with pipe", () => {
    // catch binds tighter than |>
    const result = exprParser("x catch 0 |> bar");
    expect(result).toEqual({
      type: "binOpExpression",
      operator: "|>",
      left: {
        type: "binOpExpression",
        operator: "catch",
        left: { type: "identifier", value: "x" },
        right: { type: "numberLiteral", value: 0 },
      },
      right: { type: "identifier", value: "bar" },
    });
  });

  test("catch chaining", () => {
    // try foo() catch try bar() catch default
    // parses as: (try foo() catch (try bar())) catch default
    // but since catch is left-assoc: ((try foo()) catch (try bar())) catch default
    const result = exprParser("x catch y catch z");
    expect(result.type).toBe("binOpExpression");
    expect(result.operator).toBe("catch");
    expect(result.left.type).toBe("binOpExpression");
    expect(result.left.operator).toBe("catch");
  });
  ```

**Verify:** `pnpm vitest run lib/parsers/expression.test.ts`

---

## Task 3: Add `__catchResult` runtime function

**File:** `lib/runtime/result.ts` (or wherever Result-related runtime helpers live — if this file doesn't exist, add the function to `lib/runtime/builtins.ts` and export it from `lib/runtime/index.ts`)

- [ ] Implement the runtime helper:
  ```typescript
  export function __catchResult(result: ResultValue, fallback: () => any): any {
    if (result.success) {
      return result.value;
    }
    return fallback();
  }
  ```
  The fallback is a thunk (zero-argument function) so it is lazily evaluated — the fallback expression only runs if the result is a failure.

- [ ] Export `__catchResult` from `lib/runtime/index.ts` so compiled code can import it.

- [ ] Write a unit test in the same directory (co-located test file):
  ```typescript
  import { __catchResult } from "./result";

  describe("__catchResult", () => {
    test("returns value on success", () => {
      const result = { success: true, value: 42 };
      expect(__catchResult(result, () => 0)).toBe(42);
    });

    test("returns fallback on failure", () => {
      const result = { success: false, error: "oops" };
      expect(__catchResult(result, () => 0)).toBe(0);
    });

    test("fallback is lazy — not called on success", () => {
      const result = { success: true, value: 42 };
      const fallback = vi.fn(() => 0);
      __catchResult(result, fallback);
      expect(fallback).not.toHaveBeenCalled();
    });

    test("returns Result when fallback produces Result (chaining)", () => {
      const result = { success: false, error: "oops" };
      const fallbackResult = { success: true, value: 99 };
      expect(__catchResult(result, () => fallbackResult)).toEqual(fallbackResult);
    });
  });
  ```

**Verify:** `pnpm vitest run lib/runtime/result.test.ts` (or wherever the test file lives)

---

## Task 4: Builder — desugar `catch` to `__catchResult` call

**File:** `lib/backends/typescriptBuilder.ts`

- [ ] `processBinOpExpression()` is a simple pass-through that calls `ts.binOp()` for all operators — there is no switch statement. Add a conditional check at the top of the method to intercept `"catch"` before the generic path, then define a new `processCatchExpression` method:
  ```typescript
  private processBinOpExpression(node: BinOpExpression): TsNode {
    if (node.operator === "catch") {
      return this.processCatchExpression(node);
    }
    // ... existing code unchanged ...
  }

  private processCatchExpression(node: BinOpExpression): TsNode {
    const left = this.processNode(node.left);
    const right = this.processNode(node.right);
    return ts.call(ts.identifier("__catchResult"), [
      left,
      ts.arrowFn([], right),
    ]);
  }
  ```
  This generates: `__catchResult(<left>, () => <right>)`

- [ ] Add `__catchResult` to the import list in `lib/templates/backends/typescriptGenerator/imports.mustache`. Add it to the existing `import { ... } from "agency-lang/runtime"` block, alongside the other runtime helpers. Then run `pnpm run templates` to regenerate the compiled template file.

**Verify:** `pnpm run build` — confirm no type errors. Then compile a small test file manually:
```
pnpm run compile tests/typescriptGenerator/catch-basic.agency
```
(We will create this fixture in Task 6.)

---

## Task 5: Integration test fixtures

**Directory:** `tests/typescriptGenerator/`

- [ ] Create `tests/typescriptGenerator/catch-basic.agency`:
  ```
  function riskyCall() -> Result<number> {
    return { success: true, value: 42 }
  }

  node main {
    result = try riskyCall()
    value = result catch 0
    return value
  }
  ```

- [ ] Generate the expected `.mts` fixture by running:
  ```bash
  pnpm run compile tests/typescriptGenerator/catch-basic.agency
  ```
  Review the output and save it as the `.mts` fixture file. Then verify:
  ```bash
  pnpm vitest run tests/typescriptGenerator/catch-basic
  ```

- [ ] Create `tests/typescriptGenerator/catch-chain.agency`:
  ```
  function foo() -> Result<string> {
    return { success: false, error: "foo failed" }
  }

  function bar() -> Result<string> {
    return { success: false, error: "bar failed" }
  }

  node main {
    value = try foo() catch try bar() catch "default"
    return value
  }
  ```
  Generate and save the `.mts` fixture the same way.

**Verify:** `make fixtures` to regenerate all fixtures, then `pnpm test:run` to confirm all pass.

---

## Task 6: E2E tests — basic catch and chained catch

**Directory:** `tests/agency/`

- [ ] Create `tests/agency/catch-basic.agency`:
  ```
  function riskyFunc() -> Result<number> {
    return { success: true, value: 42 }
  }

  function failingFunc() -> Result<number> {
    return { success: false, error: "failed" }
  }

  node main {
    result1 = try riskyFunc()
    value1 = result1 catch 0
    assert(value1 == 42, "should unwrap success")

    result2 = try failingFunc()
    value2 = result2 catch 0
    assert(value2 == 0, "should use fallback on failure")

    return value1
  }
  ```

- [ ] Create `tests/agency/catch-chain.agency`:
  ```
  function fail1() -> Result<number> {
    return { success: false, error: "fail1" }
  }

  function fail2() -> Result<number> {
    return { success: false, error: "fail2" }
  }

  node main {
    value = try fail1() catch try fail2() catch 99
    assert(value == 99, "should fall through chain to default")
    return value
  }
  ```

- [ ] Add test entries in the relevant E2E test runner file (check how existing `tests/agency/*.agency` files are wired up — likely via a glob or explicit list).

**Verify:**
```bash
pnpm vitest run tests/agency/catch-basic
pnpm vitest run tests/agency/catch-chain
```

---

## Summary of files to modify

| File | Change |
|------|--------|
| `lib/types/binop.ts` | Add `"catch"` to `Operator` union and `PRECEDENCE` map |
| `lib/parsers/expression.ts` | Add `catch` precedence level |
| `lib/parsers/expression.test.ts` | Parser unit tests |
| `lib/runtime/result.ts` (or `builtins.ts`) | `__catchResult` helper |
| `lib/runtime/index.ts` | Export `__catchResult` |
| `lib/backends/typescriptBuilder.ts` | Desugar `catch` to `__catchResult(...)` via new `processCatchExpression` method |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Add `__catchResult` to runtime imports (then run `pnpm run templates`) |
| `tests/typescriptGenerator/catch-basic.agency` | Generator fixture |
| `tests/typescriptGenerator/catch-chain.agency` | Generator fixture |
| `tests/agency/catch-basic.agency` | E2E test |
| `tests/agency/catch-chain.agency` | E2E test |

**Deferred to Stage 7:** Typechecker enforcement for `catch` (left operand must be `Result`, inferring result type based on fallback type, chaining support) is consolidated in Stage 7.
