# Try Keyword Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `try` keyword that converts exceptions thrown by function calls into `Result` values, bridging JavaScript's exception-based error handling with Agency's value-based Result type.

**Architecture:** `try` is parsed as a unary prefix keyword applied to function call expressions, producing a `TryExpression` AST node. The builder desugars to `__tryCall(() => fn(args))` or `await __tryCallAsync(async () => fn(args))` runtime helpers. Typechecker rules (inferring `Result` type for `try` expressions and warning on double-wrapping) are deferred to Stage 7 (consolidated typechecker work).

**Tech Stack:** TypeScript, tarsec (parser combinators), vitest (testing)

---

## Task 1: Define `TryExpression` AST node type

- [ ] Create `lib/types/tryExpression.ts` with the following type:

```typescript
import { FunctionCall } from "./function.js";

export type TryExpression = {
  type: "tryExpression";
  call: FunctionCall;
  isAsync?: boolean;
};
```

- [ ] In `lib/types.ts`, import and re-export `TryExpression`:

```typescript
export { TryExpression } from "./types/tryExpression.js";
```

- [ ] Add `TryExpression` to the `Expression` union type in `lib/types.ts`:

```typescript
export type Expression = ValueAccess | Literal | FunctionCall | BinOpExpression | AgencyArray | AgencyObject | TryExpression;
```

- [ ] Add `TryExpression` to the `AgencyNode` union type in `lib/types.ts`.

**Verify:** `pnpm run build` compiles without errors.

---

## Task 2: Parse `try functionCall()` and `try async functionCall()`

- [ ] Create `lib/parsers/tryExpression.ts` with the parser:

```typescript
import { str, seq, optional, map } from "tarsec";
import { functionCallParser } from "./function.js";
import { TryExpression } from "../types.js";

// Parses: try functionCall(args)
// Parses: try async functionCall(args)
export const tryExpressionParser = map(
  seq(str("try "), optional(str("async ")), functionCallParser),
  ([_try, async_, call]): TryExpression => ({
    type: "tryExpression",
    call,
    ...(async_ ? { isAsync: true } : {}),
  })
);
```

Note: The exact tarsec combinators and function call parser import may need slight adjustment to match the actual exports. The key idea is: parse `try`, optional `async`, then delegate to `functionCallParser`.

- [ ] Wire `tryExpressionParser` into the `atom` parser in `lib/parsers/expression.ts`. Add it to the `or(...)` list that defines `atom`, before `valueAccessParser` (since `try` is a keyword prefix that won't conflict with identifiers):

```typescript
atom = or(unaryNotParser, tryExpressionParser, agencyArrayParser, agencyObjectParser, booleanParser, valueAccessParser, literalParser)
```

- [ ] Create `lib/parsers/tryExpression.test.ts` with unit tests:

```typescript
import { describe, it, expect } from "vitest";
import { tryExpressionParser } from "./tryExpression.js";

describe("tryExpressionParser", () => {
  it("parses try with a simple function call", () => {
    const result = tryExpressionParser("try fetchData(url)");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      type: "tryExpression",
      call: { type: "functionCall", functionName: "fetchData" },
    });
    expect(result.result.isAsync).toBeUndefined();
  });

  it("parses try async with a function call", () => {
    const result = tryExpressionParser("try async fetchData(url)");
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      type: "tryExpression",
      call: { type: "functionCall", functionName: "fetchData" },
      isAsync: true,
    });
  });

  it("fails on try without a function call", () => {
    const result = tryExpressionParser("try 42");
    expect(result.success).toBe(false);
  });

  it("parses try with no-arg function call", () => {
    const result = tryExpressionParser("try doSomething()");
    expect(result.success).toBe(true);
    expect(result.result.call.functionName).toBe("doSomething");
  });

  it("parses try with multiple arguments", () => {
    const result = tryExpressionParser("try sendEmail(to, subject, body)");
    expect(result.success).toBe(true);
    expect(result.result.call.functionName).toBe("sendEmail");
  });
});
```

**Verify:** `pnpm vitest run lib/parsers/tryExpression.test.ts`

- [ ] Test that `try` expressions parse correctly within full Agency programs by running `pnpm run ast` on a small test file that uses `try`.

---

## Task 3: Add `__tryCall` and `__tryCallAsync` runtime helpers

**Note:** This task depends on Stage 1 (Result type) being complete, which creates `lib/runtime/result.ts` with the `ResultValue` type. If Stage 1 has not been completed yet, **create** `lib/runtime/result.ts` with the `ResultValue` type definition:

```typescript
export type ResultValue =
  | { success: true; value: any }
  | { success: false; error: any; checkpoint: any | null };
```

- [ ] Add the following functions to `lib/runtime/result.ts` (create the file if it doesn't exist — see note above):

```typescript
// Note: The `checkpoint` parameter is always `null` unless Stage 3 (checkpointing)
// has been completed. In this plan, the builder never passes a checkpoint argument,
// so it will always default to `null` via the `??` operator.
export function __tryCall(fn: () => any, checkpoint?: any): ResultValue {
  try {
    const value = fn();
    return { success: true, value };
  } catch (error) {
    return { success: false, error, checkpoint: checkpoint ?? null };
  }
}

export async function __tryCallAsync(fn: () => Promise<any>, checkpoint?: any): Promise<ResultValue> {
  try {
    const value = await fn();
    return { success: true, value };
  } catch (error) {
    return { success: false, error, checkpoint: checkpoint ?? null };
  }
}
```

- [ ] Export `__tryCall` and `__tryCallAsync` from `lib/runtime/index.ts`.

- [ ] Create `lib/runtime/result.test.ts` (or add to existing test file) with unit tests:

```typescript
import { describe, it, expect } from "vitest";
import { __tryCall, __tryCallAsync } from "./result.js";

describe("__tryCall", () => {
  it("returns success for a function that succeeds", () => {
    const result = __tryCall(() => 42);
    expect(result).toEqual({ success: true, value: 42 });
  });

  it("returns failure for a function that throws", () => {
    const result = __tryCall(() => { throw new Error("boom"); });
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result as any).error.message).toBe("boom");
    expect(result.checkpoint).toBeNull();
  });

  it("includes checkpoint when provided", () => {
    const cp = { step: 3 };
    const result = __tryCall(() => { throw new Error("fail"); }, cp);
    expect(result.success).toBe(false);
    expect(result.checkpoint).toBe(cp);
  });
});

describe("__tryCallAsync", () => {
  it("returns success for an async function that resolves", async () => {
    const result = await __tryCallAsync(async () => "hello");
    expect(result).toEqual({ success: true, value: "hello" });
  });

  it("returns failure for an async function that rejects", async () => {
    const result = await __tryCallAsync(async () => { throw new Error("async boom"); });
    expect(result.success).toBe(false);
    expect((result as any).error.message).toBe("async boom");
    expect(result.checkpoint).toBeNull();
  });

  it("includes checkpoint when provided", async () => {
    const cp = { step: 5 };
    const result = await __tryCallAsync(async () => { throw new Error("fail"); }, cp);
    expect(result.success).toBe(false);
    expect(result.checkpoint).toBe(cp);
  });
});
```

**Verify:** `pnpm vitest run lib/runtime/result.test.ts`

---

## Task 4: Builder — desugar `try` expressions to runtime helper calls

- [ ] In `lib/backends/typescriptBuilder.ts`, add a case for `"tryExpression"` in `processNode()`:

```typescript
case "tryExpression":
  return this.processTryExpression(node);
```

- [ ] Implement `processTryExpression` method on the builder class:

```typescript
private processTryExpression(node: TryExpression): TsNode {
  const callNode = this.processFunctionCall(node.call);

  if (node.isAsync) {
    // try async fn(args) → await __tryCallAsync(async () => fn(args))
    return ts.await(
      ts.call(ts.id("__tryCallAsync"), [
        ts.arrowFn([], callNode, { async: true }),
      ])
    );
  } else {
    // try fn(args) → __tryCall(() => fn(args))
    return ts.call(ts.id("__tryCall"), [
      ts.arrowFn([], callNode),
    ]);
  }
}
```

Note: `ts.call()` takes a `TsNode` as its callee (not a string), so use `ts.id("__tryCall")`. `ts.arrowFn()` takes a single `TsNode` body (not an array). The key desugaring is:
- `try someFunction(args)` becomes `__tryCall(() => someFunction(args))`
- `try async someFunction(args)` becomes `await __tryCallAsync(async () => someFunction(args))`

- [ ] Ensure the generated code includes the import for `__tryCall` / `__tryCallAsync` from the runtime. Add `__tryCall` and `__tryCallAsync` to the import list in `lib/templates/backends/typescriptGenerator/imports.mustache` (in the `from "agency-lang/runtime"` import block, alongside other runtime helpers like `deepClone`). Then run `pnpm run templates` to regenerate `imports.ts`.

**Verify:** `pnpm run build` compiles. Then test with `pnpm run compile` on a small `.agency` file containing `try` to inspect the generated TypeScript.

---

## Task 5: Integration test fixtures

- [ ] Create `tests/typescriptGenerator/try-expression.agency`:

```
def riskyOperation(x: string): string {
  return x
}

node main() {
  let result = try riskyOperation("hello")
  return result
}
```

- [ ] Create the corresponding expected output `tests/typescriptGenerator/try-expression.mts` by running:

```bash
pnpm run compile tests/typescriptGenerator/try-expression.agency
```

Inspect the output to confirm it contains `__tryCall(() => riskyOperation("hello"))` and looks correct. Then copy/save as the `.mts` fixture.

- [ ] Create `tests/typescriptGenerator/try-async-expression.agency`:

```
def asyncOperation(x: string): string {
  return x
}

node main() {
  let result = try async asyncOperation("hello")
  return result
}
```

- [ ] Create the corresponding `.mts` fixture similarly.

- [ ] Run `make fixtures` to regenerate all fixtures and verify nothing else broke.

**Verify:** `pnpm vitest run` — all tests pass including the new fixtures.

---

## Task 6: E2E test

Agency does not have a `throw` keyword, so the E2E test uses an imported TypeScript helper function that throws.

- [ ] Create a TypeScript helper `tests/agency/try-expression-helper.ts`:

```typescript
export function mightFail(x: number): number {
  if (x < 0) {
    throw new Error("negative number");
  }
  return x * 2;
}
```

- [ ] Create `tests/agency/try-expression.agency`:

```
import { mightFail } from "./try-expression-helper.js"

node main() {
  let successResult = try mightFail(5)
  let failResult = try mightFail(-1)

  if (successResult.success) {
    let successValue = successResult.value
  } else {
    let successValue = -1
  }

  if (failResult.success) {
    let failValue = failResult.value
  } else {
    let failValue = -1
  }

  return { successValue: successValue, failValue: failValue }
}
```

Note: The exact Agency syntax for conditionals, object literals, property access, and JS imports may need adjustment to match the actual language. The key test is: `try` on a succeeding call returns `{ success: true, value: 10 }`, `try` on a failing call returns `{ success: false, error: ... }`.

- [ ] Create `tests/agency/try-expression.test.json` following the E2E test convention:

```json
{
  "sourceFile": "try-expression.agency",
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "{\"successValue\":10,\"failValue\":-1}",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

**Verify:** `pnpm vitest run tests/agency/try-expression` — the E2E test passes.

---

## Summary of files to create/modify

**New files:**
- `lib/types/tryExpression.ts` — AST node type
- `lib/parsers/tryExpression.ts` — parser
- `lib/parsers/tryExpression.test.ts` — parser unit tests
- `tests/typescriptGenerator/try-expression.agency` — generator fixture
- `tests/typescriptGenerator/try-expression.mts` — generator fixture expected output
- `tests/typescriptGenerator/try-async-expression.agency` — async generator fixture
- `tests/typescriptGenerator/try-async-expression.mts` — async generator fixture expected output
- `tests/agency/try-expression-helper.ts` — TypeScript helper that throws (for E2E test)
- `tests/agency/try-expression.agency` — E2E test
- `tests/agency/try-expression.test.json` — E2E test assertions

**Modified files (or created if Stage 1 not yet complete):**
- `lib/runtime/result.ts` — add `__tryCall` and `__tryCallAsync` (create file if Stage 1 has not been completed yet; see Task 3 note)

**Modified files:**
- `lib/types.ts` — add `TryExpression` to `Expression` and `AgencyNode` unions, re-export type
- `lib/parsers/expression.ts` — add `tryExpressionParser` to `atom`
- `lib/runtime/index.ts` — export new runtime helpers
- `lib/backends/typescriptBuilder.ts` — add `processTryExpression` case
- `lib/templates/backends/typescriptGenerator/imports.mustache` — add `__tryCall` and `__tryCallAsync` to runtime imports (then run `pnpm run templates`)

**Deferred to Stage 7:** Typechecker enforcement for `try` expressions (inferring `Result` type, validating operand is a function call, warning when `try` is applied to a function that already returns `Result`) is consolidated in Stage 7.
