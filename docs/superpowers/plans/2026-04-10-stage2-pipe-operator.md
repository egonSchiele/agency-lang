# Pipe Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Dependency:** This plan depends on Stage 1 (Result type) being complete. Specifically, `success()`, `failure()`, and the `Result` type must already exist. The `__pipeBind` function will be added to `lib/runtime/result.ts`, which is created in Stage 1.

**Goal:** Add the `|>` pipe operator and `?` placeholder for partial application, enabling chaining of Result-returning operations with automatic short-circuiting on failure.

**Architecture:** `|>` is parsed as the lowest-precedence left-associative binary operator using the existing `buildExpressionParser`. The `?` placeholder is a new atom type scoped to pipe right-hand sides. The builder desugars `|>` expressions to `__pipeBind(left, (x) => rightSide(x))` calls, where `__pipeBind` handles both bind (Result-returning) and fmap (plain-returning) cases at runtime. Typechecker rules for `|>` and `?` are deferred to Stage 7 (consolidated typechecker work).

**Tech Stack:** TypeScript, tarsec (parser combinators), vitest (testing)

---

## Task 1: Add `"|>"` to the Operator type and PRECEDENCE map

- [ ] Done

**Files to modify:**
- `lib/types/binop.ts`

**Changes:**

1. Add `"|>"` to the `Operator` type union:

```typescript
export type Operator = "+" | "-" | "*" | "/" | "==" | "!=" | "+=" | "-=" | "*=" | "/=" | "<" | ">" | "<=" | ">=" | "&&" | "||" | "!" | "|>";
```

2. Add `"|>"` to the `PRECEDENCE` map with the lowest value (`-1`), below all other operators:

```typescript
export const PRECEDENCE: Record<string, number> = {
  "|>": -1, "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4,
  "+": 5, "-": 5, "*": 6, "/": 6, "+=": 0, "-=": 0, "*=": 0, "/=": 0, "!": 7,
};
```

**Tests:**

No new tests needed for this step alone. Existing tests should still pass.

```bash
pnpm test:run -- lib/types
```

---

## Task 2: Parse `|>` in the expression parser

- [ ] Done

**Files to modify:**
- `lib/parsers/expression.ts`

**Changes:**

Add a new precedence level at the END of the operator table array in `buildExpressionParser` (lowest precedence, parsed last). The `|>` operator must come after `||` to ensure it binds less tightly than everything else:

```typescript
export const exprParser: Parser<Expression> = label("an expression", buildExpressionParser<Expression>(
  atom,
  [
    // Precedence 6: multiplicative
    [
      { op: wsOp("*="), assoc: "right" as const, apply: makeBinOp("*=") },
      { op: wsOp("/="), assoc: "right" as const, apply: makeBinOp("/=") },
      { op: wsOp("*"), assoc: "left" as const, apply: makeBinOp("*") },
      { op: wsOp("/"), assoc: "left" as const, apply: makeBinOp("/") },
    ],
    // Precedence 5: additive
    [
      { op: wsOp("+="), assoc: "right" as const, apply: makeBinOp("+=") },
      { op: wsOp("-="), assoc: "right" as const, apply: makeBinOp("-=") },
      { op: wsOp("+"), assoc: "left" as const, apply: makeBinOp("+") },
      { op: wsOp("-"), assoc: "left" as const, apply: makeBinOp("-") },
    ],
    // Precedence 4: relational
    [
      { op: wsOp("<="), assoc: "left" as const, apply: makeBinOp("<=") },
      { op: wsOp(">="), assoc: "left" as const, apply: makeBinOp(">=") },
      { op: wsOp("<"), assoc: "left" as const, apply: makeBinOp("<") },
      { op: wsOp(">"), assoc: "left" as const, apply: makeBinOp(">") },
    ],
    // Precedence 3: equality
    [
      { op: wsOp("=="), assoc: "left" as const, apply: makeBinOp("==") },
      { op: wsOp("!="), assoc: "left" as const, apply: makeBinOp("!=") },
    ],
    // Precedence 2: logical AND
    [
      { op: wsOp("&&"), assoc: "left" as const, apply: makeBinOp("&&") },
    ],
    // Precedence 1: logical OR
    [
      { op: wsOp("||"), assoc: "left" as const, apply: makeBinOp("||") },
    ],
    // Precedence 0 (lowest): pipe
    [
      { op: wsOp("|>"), assoc: "left" as const, apply: makeBinOp("|>") },
    ],
  ],
  parenParser,
));
```

IMPORTANT: The `wsOp("|>")` parser must match the two-character sequence `|>`. Since `|` is not used as a standalone operator in the expression parser, there should be no ambiguity. However, verify that no existing parser tries to match a bare `|` that could conflict.

**Tests:**

Add parser unit tests in `lib/parsers/expression.test.ts`:

```typescript
describe("pipe operator |>", () => {
  it("parses a simple pipe expression", () => {
    const result = exprParser("a |> b");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({
      type: "binOpExpression",
      operator: "|>",
      left: { type: "valueAccess", path: ["a"] },
      right: { type: "valueAccess", path: ["b"] },
    });
  });

  it("parses chained pipe expressions left-to-right", () => {
    const result = exprParser("a |> b |> c");
    expect(result.success).toBe(true);
    // Left-associative: (a |> b) |> c
    expect(result.result).toEqual({
      type: "binOpExpression",
      operator: "|>",
      left: {
        type: "binOpExpression",
        operator: "|>",
        left: { type: "valueAccess", path: ["a"] },
        right: { type: "valueAccess", path: ["b"] },
      },
      right: { type: "valueAccess", path: ["c"] },
    });
  });

  it("pipe has lower precedence than ||", () => {
    const result = exprParser("a || b |> c");
    expect(result.success).toBe(true);
    // Should parse as (a || b) |> c
    expect(result.result.type).toBe("binOpExpression");
    expect(result.result.operator).toBe("|>");
    expect(result.result.left.operator).toBe("||");
  });

  it("parses pipe with function call on right side", () => {
    const result = exprParser("a |> foo(10)");
    expect(result.success).toBe(true);
    expect(result.result.operator).toBe("|>");
    expect(result.result.right.type).toBe("functionCall");
  });
});
```

```bash
pnpm test:run -- lib/parsers/expression.test.ts
```

---

## Task 3: Add `Placeholder` AST node type and parse `?` as an atom

- [ ] Done

**Files to create:**
- `lib/types/placeholder.ts`

**Files to modify:**
- `lib/types.ts`
- `lib/parsers/expression.ts`

**Changes:**

1. Create `lib/types/placeholder.ts`:

```typescript
export type Placeholder = {
  type: "placeholder";
};
```

2. In `lib/types.ts`, export the new type and add it to the `Expression` union:

```typescript
// Add to imports/exports
export type { Placeholder } from "./types/placeholder.js";

// Update the Expression union
export type Expression = ValueAccess | Literal | FunctionCall | BinOpExpression | AgencyArray | AgencyObject | Placeholder;
```

3. In `lib/parsers/expression.ts`, add a parser for `?` as an atom. The `?` must be parsed as a standalone token that doesn't consume surrounding identifiers. Add it to the `atom` parser:

```typescript
import { char } from "tarsec";

const placeholderParser: Parser<Placeholder> = (input: string) => {
  const result = char("?")(input);
  if (!result.success) return result;
  // Make sure `?` is not followed by an identifier character (e.g., `?foo` should not match)
  if (result.rest.length > 0 && /[a-zA-Z0-9_]/.test(result.rest[0])) {
    return failure("placeholder", input);
  }
  return { success: true as const, result: { type: "placeholder" as const }, rest: result.rest };
};
```

Then add `placeholderParser` as one of the alternatives in the `atom` parser (the `or(...)` that combines all atom-level expressions). Place it before the identifier/valueAccess parser so `?` is recognized before it tries to parse it as a variable name.

**Tests:**

Add parser unit tests in `lib/parsers/expression.test.ts`:

```typescript
describe("placeholder ?", () => {
  it("parses ? as a placeholder", () => {
    const result = exprParser("?");
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ type: "placeholder" });
  });

  it("parses ? inside function call arguments", () => {
    const result = exprParser("foo(10, ?)");
    expect(result.success).toBe(true);
    expect(result.result.type).toBe("functionCall");
    expect(result.result.arguments[1]).toEqual({ type: "placeholder" });
  });

  it("parses ? as first argument in function call", () => {
    const result = exprParser("foo(?, 10)");
    expect(result.success).toBe(true);
    expect(result.result.type).toBe("functionCall");
    expect(result.result.arguments[0]).toEqual({ type: "placeholder" });
  });

  it("parses pipe with partial application", () => {
    const result = exprParser("a |> multiply(10, ?)");
    expect(result.success).toBe(true);
    expect(result.result.operator).toBe("|>");
    expect(result.result.right.type).toBe("functionCall");
    expect(result.result.right.arguments[1]).toEqual({ type: "placeholder" });
  });
});
```

```bash
pnpm test:run -- lib/parsers/expression.test.ts
```

---

## Task 4: Add `__pipeBind` runtime function

- [ ] Done

**Files to modify:**
- `lib/runtime/result.ts` (created in Stage 1 — this task depends on Stage 1 being complete)

**Changes:**

Add the `__pipeBind` function to `lib/runtime/result.ts`. This function handles both bind (when the piped function returns a Result) and fmap (when it returns a plain value) cases at runtime:

```typescript
/**
 * Pipe bind for the |> operator. If the input result is a failure, short-circuit
 * and return it immediately. Otherwise, apply fn to the unwrapped value.
 * If fn returns a Result, use it directly (bind). If fn returns a plain value,
 * wrap it in success (fmap).
 */
export function __pipeBind(result: ResultValue, fn: (value: any) => any): ResultValue {
  if (!result.success) return result;
  const output = fn(result.value);
  // Smart bind/fmap: if fn already returns a Result, use it directly
  if (output != null && typeof output === "object" && "success" in output && typeof output.success === "boolean") {
    return output;
  }
  return { success: true, value: output };
}
```

Also export `__pipeBind` from `lib/runtime/index.ts` if it is not already re-exported from there.

Additionally, add `__pipeBind` to the import list in `lib/templates/backends/typescriptGenerator/imports.mustache`, then run `pnpm run templates`. This ensures compiled Agency code imports `__pipeBind` from the runtime.

**Tests:**

Add unit tests in `lib/runtime/result.test.ts` (create if it does not already exist):

```typescript
import { describe, it, expect } from "vitest";
import { success, failure, __pipeBind } from "./result.js";

describe("__pipeBind", () => {
  it("short-circuits on failure", () => {
    const fail = failure("something went wrong");
    const result = __pipeBind(fail, (x) => success(x + 1));
    expect(result.success).toBe(false);
    expect(result.error).toBe("something went wrong");
  });

  it("applies function on success (bind: fn returns Result)", () => {
    const ok = success(5);
    const result = __pipeBind(ok, (x) => success(x * 2));
    expect(result.success).toBe(true);
    expect(result.value).toBe(10);
  });

  it("wraps plain return value in success (fmap)", () => {
    const ok = success(5);
    const result = __pipeBind(ok, (x) => x * 2);
    expect(result.success).toBe(true);
    expect(result.value).toBe(10);
  });

  it("propagates failure from fn (bind)", () => {
    const ok = success(5);
    const result = __pipeBind(ok, (_x) => failure("downstream error"));
    expect(result.success).toBe(false);
    expect(result.error).toBe("downstream error");
  });

  it("chains multiple pipes", () => {
    const start = success(2);
    const r1 = __pipeBind(start, (x) => success(x + 3));  // 5
    const r2 = __pipeBind(r1, (x) => x * 10);              // 50, fmap
    const r3 = __pipeBind(r2, (x) => success(x + 1));      // 51
    expect(r3.success).toBe(true);
    expect(r3.value).toBe(51);
  });

  it("chains stop at first failure", () => {
    const start = success(2);
    const r1 = __pipeBind(start, (_x) => failure("oops"));
    const r2 = __pipeBind(r1, (x) => success(x + 100));
    expect(r2.success).toBe(false);
    expect(r2.error).toBe("oops");
  });
});
```

```bash
pnpm test:run -- lib/runtime/result.test.ts
```

---

## Task 5: Builder — desugar `|>` with bare function reference (no `?`)

- [ ] Done

**Files to modify:**
- `lib/backends/typescriptBuilder.ts`

**Changes:**

In `processBinOpExpression()`, add a special case for the `"|>"` operator. When the right-hand side is a bare function reference (a `valueAccess` node), desugar it:

For a bare function reference on the right (`a |> bar`):
```
__pipeBind(<left>, (__pipeArg) => bar(__pipeArg))
```

The generated IR should be:
```typescript
ts.call(
  ts.raw("__pipeBind"),
  [
    processedLeft,
    ts.arrowFn([{ name: "__pipeArg" }], ts.call(processedRight, [ts.raw("__pipeArg")]))
  ]
)
```

Where `processedLeft` is the recursively processed left-hand side, and `processedRight` is the right-hand side processed as a callee (not invoked yet).

Handle the case where the right side is a `valueAccess` (bare name like `bar` or dotted like `obj.method`). Note that `obj.method` is represented as a `valueAccess` node with `path: ["obj", "method"]` in the AST. The desugaring wraps it into `(__pipeArg) => obj.method(__pipeArg)`, which works correctly since `processNode` for a `valueAccess` produces the dotted access expression:

```typescript
case "|>": {
  const left = this.processNode(node.left);
  const right = node.right;

  if (right.type === "valueAccess") {
    // Bare function reference: a |> bar → __pipeBind(a, (__pipeArg) => bar(__pipeArg))
    const callee = this.processNode(right);
    return ts.call(ts.raw("__pipeBind"), [
      left,
      ts.arrowFn([{ name: "__pipeArg" }], ts.call(callee, [ts.raw("__pipeArg")]))
    ]);
  }

  // ... functionCall cases in Task 6
}
```

Also add a `case "placeholder"` to the builder's `processNode` switch statement. It should throw a clear error, since placeholders should always be desugared by the `|>` handler and should never reach `processNode` directly:

```typescript
case "placeholder":
  throw new Error("Placeholder '?' can only appear on the right side of a |> pipe operator");
```

Also ensure that `__pipeBind` is imported in the generated code. This likely means adding it to the runtime import list in the builder/generator. Look for where other runtime functions like `success` and `failure` are imported, and add `__pipeBind` alongside them.

**Tests:**

Add builder integration test fixtures. Create two files:

`tests/typescriptBuilder/pipe-bare-function.agency`:
```
function double(x: number) -> number:
  return x * 2

node main -> end:
  result = success(5) |> double
```

`tests/typescriptBuilder/pipe-bare-function.mjs` (expected output — fill in after generating):
The generated code should contain a `__pipeBind(...)` call wrapping a lambda.

Run:
```bash
make fixtures
pnpm test:run -- tests/typescriptBuilder
```

Also add a unit test in the builder test file to verify the IR structure if such a test file exists.

---

## Task 6: Builder — desugar `|>` with partial application (`?` placeholder)

- [ ] Done

**Files to modify:**
- `lib/backends/typescriptBuilder.ts`

**Changes:**

Extend the `"|>"` case in `processBinOpExpression()` to handle function calls with `?` placeholders.

When the right-hand side is a `functionCall` containing a `?` placeholder in its arguments:
- Replace the `?` with the lambda parameter `__pipeArg`
- Wrap in a lambda

**Note:** `FunctionCall.arguments` is broader than `Expression[]` — it also includes `SplatExpression` and `NamedArgument` variants. When checking for `?` placeholder, handle these cases: using `?` alongside named or splat arguments should be treated as a type error. Add a check that rejects pipes where the right-side function call uses named or splat arguments alongside `?`.

For `a |> multiply(10, ?)`:
```
__pipeBind(<left>, (__pipeArg) => multiply(10, __pipeArg))
```

```typescript
if (right.type === "functionCall") {
  const hasPlaceholder = right.arguments.some(
    (arg) => arg.type === "placeholder"
  );

  if (!hasPlaceholder) {
    // A function call on the right side of |> MUST have exactly one ?.
    // Zero placeholders in a function call is a type error (caught by the typechecker).
    // The builder should never reach this path if the typechecker runs first,
    // but throw defensively.
    throw new Error("Function call on right side of |> must contain exactly one ? placeholder");
  }

  // Partial application: a |> foo(10, ?) → __pipeBind(a, (__pipeArg) => foo(10, __pipeArg))
  const processedArgs = right.arguments.map((arg) => {
    if (arg.type === "placeholder") {
      return ts.raw("__pipeArg");
    }
    return this.processNode(arg);
  });
  const callee = this.processNode({
    type: "valueAccess",
    path: [right.functionName],
  });
  return ts.call(ts.raw("__pipeBind"), [
    left,
    ts.arrowFn([{ name: "__pipeArg" }], ts.call(callee, processedArgs))
  ]);
}
```

**Tests:**

Add builder integration test fixtures:

`tests/typescriptBuilder/pipe-partial.agency`:
```
function multiply(a: number, b: number) -> number:
  return a * b

node main -> end:
  result = success(5) |> multiply(10, ?)
```

Also test chained pipes:

`tests/typescriptBuilder/pipe-chain.agency`:
```
function double(x: number) -> number:
  return x * 2

function add(a: number, b: number) -> number:
  return a + b

node main -> end:
  result = success(5) |> double |> add(10, ?)
```

Expected generated code for the chain should nest `__pipeBind` calls:
```typescript
__pipeBind(__pipeBind(success(5), (__pipeArg) => double(__pipeArg)), (__pipeArg) => add(10, __pipeArg))
```

Run:
```bash
make fixtures
pnpm test:run -- tests/typescriptBuilder
```

---

## Task 7: Integration test fixtures

- [ ] Done

**Files to create:**
- `tests/typescriptGenerator/pipe-operator.agency`
- `tests/typescriptGenerator/pipe-operator.mjs`

**Changes:**

Create a comprehensive integration test that exercises the pipe operator through the full compilation pipeline (parse -> build -> generate).

`tests/typescriptGenerator/pipe-operator.agency`:
```
function double(x: number) -> number:
  return x * 2

function multiply(a: number, b: number) -> number:
  return a * b

function safeDivide(a: number, b: number) -> Result:
  if b == 0:
    return failure("division by zero")
  return success(a / b)

node main -> end:
  // Bare function reference
  r1 = success(5) |> double

  // Partial application with ?
  r2 = success(5) |> multiply(10, ?)

  // Chained pipes
  r3 = success(10) |> double |> multiply(3, ?)

  // Short-circuit on failure
  r4 = failure("nope") |> double

  // Chain with Result-returning function (bind)
  r5 = success(10) |> safeDivide(?, 2)
```

Generate the expected `.mjs` output by running:
```bash
make fixtures
```

Then verify the fixture matches expectations and tests pass:
```bash
pnpm test:run -- tests/typescriptGenerator
```

---

## Task 8: E2E test

- [ ] Done

**Files to create:**
- `tests/agency/pipe-operator.agency`
- `tests/agency/pipe-operator.test.json`

**Changes:**

Create an end-to-end test that compiles and runs a pipe operator program. Agency E2E tests do NOT require LLM calls, so we can test pure logic.

`tests/agency/pipe-operator.agency`:
```
function double(x: number) -> number:
  return x * 2

function multiply(a: number, b: number) -> number:
  return a * b

node main -> end:
  r1 = success(5) |> double
  r2 = success(5) |> multiply(10, ?)
  r3 = success(10) |> double |> multiply(3, ?)
  r4 = failure("nope") |> double
  return { r1: r1, r2: r2, r3: r3, r4: r4 }
```

`tests/agency/pipe-operator.test.json`:
```json
{
  "sourceFile": "pipe-operator.agency",
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "{\"r1\":{\"success\":true,\"value\":10},\"r2\":{\"success\":true,\"value\":50},\"r3\":{\"success\":true,\"value\":60},\"r4\":{\"success\":false,\"error\":\"nope\"}}",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

Run:
```bash
pnpm test:run -- tests/agency/pipe-operator
```

---

## Summary of all files to create or modify

**New files:**
- `lib/types/placeholder.ts` — Placeholder AST node type
- `lib/runtime/result.test.ts` — Unit tests for `__pipeBind` (if not already existing)
- `tests/typescriptGenerator/pipe-operator.agency` — Generator integration test
- `tests/typescriptGenerator/pipe-operator.mjs` — Generator integration test expected output
- `tests/typescriptBuilder/pipe-bare-function.agency` — Builder integration test
- `tests/typescriptBuilder/pipe-bare-function.mjs` — Builder integration test expected output
- `tests/typescriptBuilder/pipe-partial.agency` — Builder integration test
- `tests/typescriptBuilder/pipe-partial.mjs` — Builder integration test expected output
- `tests/typescriptBuilder/pipe-chain.agency` — Builder integration test
- `tests/typescriptBuilder/pipe-chain.mjs` — Builder integration test expected output
- `tests/agency/pipe-operator.agency` — E2E test
- `tests/agency/pipe-operator.test.json` — E2E test expected output

**Modified files:**
- `lib/types/binop.ts` — Add `"|>"` to Operator type and PRECEDENCE map
- `lib/types.ts` — Export Placeholder, add to Expression union
- `lib/parsers/expression.ts` — Parse `|>` operator and `?` placeholder
- `lib/parsers/expression.test.ts` — Parser unit tests
- `lib/runtime/result.ts` — Add `__pipeBind` function (depends on Stage 1)
- `lib/runtime/index.ts` — Re-export `__pipeBind`
- `lib/templates/backends/typescriptGenerator/imports.mustache` — Add `__pipeBind` to runtime imports
- `lib/backends/typescriptBuilder.ts` — Desugar `|>` to `__pipeBind` calls, add `case "placeholder"` error

**Deferred to Stage 7:** Typechecker enforcement for `|>` (left must be Result, result type is Result) and `?` (only valid on right side of `|>`) is consolidated in Stage 7.
