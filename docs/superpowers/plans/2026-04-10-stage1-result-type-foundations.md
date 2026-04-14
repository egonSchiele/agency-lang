# Result Type Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Result type, success/failure constructors, and isSuccess/isFailure type guards to Agency's type system, parser, runtime, and code generation.

**Architecture:** Result is represented as a dedicated `ResultType` variant in the `VariableType` union: `{ type: "resultType", successType: VariableType, failureType: VariableType }`. Bare `Result` (no angle brackets) is sugar for `Result<any, any>`. `Result<S, E>` parses the two type parameters explicitly — both are required when using angle brackets. A new `resultTypeParser` handles this, following the `angleBracketsArrayTypeParser` pattern. Runtime functions `success()`, `failure()`, `isSuccess()`, `isFailure()` are added as builtins. Guard-based property narrowing (`.value` inside `isSuccess`, `.error` inside `isFailure`) is deferred to a follow-up enhancement.

**Note on naming:** `lib/types/result.ts` already exists as a compiler-internal file (used for parser/AST result types). The new `lib/runtime/result.ts` created in this plan is for the Agency language runtime. These won't collide because generated code has its own import scope — generated code imports from `agency-lang/runtime`, not from `lib/types/`.

**Tech Stack:** TypeScript, tarsec (parser combinators), vitest (testing)

---

## Task 1: Add `ResultType` to the type system

Add a new `ResultType` variant to the `VariableType` union, export it from `lib/types.ts`, and update `formatTypeHint` to handle it.

- [ ] **1a. Define `ResultType` in `lib/types/typeHints.ts`**

Add the new type alongside the other type definitions:

```typescript
export type ResultType = {
  type: "resultType";
  successType: VariableType;
  failureType: VariableType;
};
```

Add `ResultType` to the `VariableType` union:

```typescript
export type VariableType =
  | PrimitiveType
  | ArrayType
  | StringLiteralType
  | NumberLiteralType
  | BooleanLiteralType
  | UnionType
  | ObjectType
  | TypeAliasVariable
  | BlockType
  | ResultType;
```

- [ ] **1b. Export `ResultType` from `lib/types.ts`**

Add `ResultType` to the exports in `lib/types.ts`, alongside the other type hint exports.

- [ ] **1c. Update `formatTypeHint` in `lib/cli/util.ts`**

Add a case for `resultType`:

```typescript
case "resultType": {
  const s = vt.successType;
  const f = vt.failureType;
  const isAny = (t: VariableType) => t.type === "primitiveType" && t.value === "any";
  if (isAny(s) && isAny(f)) {
    return "Result";
  }
  return `Result<${formatTypeHint(s)}, ${formatTypeHint(f)}>`;
}
```

Run: `pnpm run build` to verify no compilation errors.

- [ ] **1d. Commit**

---

## Task 2: Parse `Result` and `Result<S, E>` as type annotations

Create a new `resultTypeParser` that parses both bare `Result` and `Result<SuccessType, FailureType>`.

- [ ] **2a. Write failing parser tests**

In `lib/parsers/typeHints.test.ts`, add tests:

```typescript
describe("resultTypeParser", () => {
  it("parses bare Result as resultType with any/any", () => {
    const result = resultTypeParser.run("Result");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: "resultType",
      successType: { type: "primitiveType", value: "any" },
      failureType: { type: "primitiveType", value: "any" },
    });
  });

  it("parses Result<string, number> with explicit type params", () => {
    const result = resultTypeParser.run("Result<string, number>");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: "resultType",
      successType: { type: "primitiveType", value: "string" },
      failureType: { type: "primitiveType", value: "number" },
    });
  });

  it("parses Result with object failure type", () => {
    const result = variableTypeParser.run("Result<string, { message: string }>");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: "resultType",
      successType: { type: "primitiveType", value: "string" },
      failureType: {
        type: "objectType",
        properties: [{ key: "message", value: { type: "primitiveType", value: "string" } }],
      },
    });
  });

  it("parses Result with type alias params", () => {
    const result = resultTypeParser.run("Result<MySuccess, MyError>");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: "resultType",
      successType: { type: "typeAliasVariable", aliasName: "MySuccess" },
      failureType: { type: "typeAliasVariable", aliasName: "MyError" },
    });
  });

  it("Result<string> with one param fails", () => {
    // Must have either zero or two type params
    const result = resultTypeParser.run("Result<string>");
    expect(result.success).toBe(false);
  });
});
```

Run: `pnpm test:run -- lib/parsers/typeHints.test.ts`

Expected: tests fail because `resultTypeParser` does not exist.

- [ ] **2b. Create `resultTypeParser` in `lib/parsers/typeHints.ts`**

Follow the `angleBracketsArrayTypeParser` pattern. The parser should:
1. Match `str("Result")`
2. Optionally match `<Type1, Type2>` using angle brackets
3. If no angle brackets, produce `{ type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } }`
4. If angle brackets present, parse two comma-separated types and produce `{ type: "resultType", successType: <Type1>, failureType: <Type2> }`

```typescript
export const resultTypeParser: Parser<ResultType> = trace(
  "resultTypeParser",
  or(
    // Result<SuccessType, FailureType>
    seqC(
      set("type", "resultType"),
      str("Result"),
      char("<"),
      captureCaptures(
        parseError(
          "expected two type parameters separated by comma, e.g. `Result<string, number>`",
          capture(variableTypeParser, "successType"),
          char(","),
          optionalWhitespace,
          capture(variableTypeParser, "failureType"),
          char(">"),
        ),
      ),
    ),
    // Bare Result (sugar for Result<any, any>)
    seqC(
      set("type", "resultType"),
      str("Result"),
      set("successType", { type: "primitiveType", value: "any" }),
      set("failureType", { type: "primitiveType", value: "any" }),
    ),
  ),
);
```

**Note:** The `resultTypeParser` references `variableTypeParser` for parsing the type parameters, but `variableTypeParser` also needs to include `resultTypeParser`. This is a circular reference. To handle this, use the `lazy()` combinator from tarsec (like other parsers in the codebase do for circular references), OR define `resultTypeParser` before `variableTypeParser` and only use `primitiveTypeParser`, `objectTypeParser`, and `typeAliasVariableParser` inside the angle brackets (which covers the practical cases). Check how the codebase handles similar circular references and follow that pattern.

- [ ] **2c. Wire `resultTypeParser` into `variableTypeParser` and `unionItemParser`**

In `lib/parsers/typeHints.ts`, add `resultTypeParser` to the `variableTypeParser` `or()` list. Place it before `primitiveTypeParser` and `typeAliasVariableParser` so that `Result` is matched by the result parser rather than being treated as a type alias:

```typescript
export const variableTypeParser: Parser<VariableType> = trace(
  "variableTypeParser",
  or(
    blockTypeParser,
    unionTypeParser,
    arrayTypeParser,
    objectTypeParser,
    angleBracketsArrayTypeParser,
    resultTypeParser,               // <-- add here, before primitiveTypeParser
    stringLiteralTypeParser,
    numberLiteralTypeParser,
    booleanLiteralTypeParser,
    primitiveTypeParser,
    typeAliasVariableParser,
  ),
);
```

Also add `resultTypeParser` to `unionItemParser` if it exists as a separate parser, following the same pattern.

- [ ] **2d. Write a parser test for function with Result return type**

In the relevant function definition parser test file, add a test verifying that a function definition like `def foo(): Result` parses correctly with the return type `{ type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } }`.

Also add a test for `def foo(): Result<string, { message: string }>` to verify generic Result works as a return type.

Run: `pnpm test:run -- lib/parsers/`

Expected: all parser tests pass.

- [ ] **2e. Commit**

---

## Task 3: Runtime `success()` and `failure()` functions

Create the runtime Result module with constructor functions.

- [ ] **3a. Write failing runtime tests**

Create `lib/runtime/result.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { success, failure, isSuccess, isFailure } from "./result";

describe("success", () => {
  it("creates a success result", () => {
    const result = success(42);
    expect(result).toEqual({ success: true, value: 42 });
  });

  it("creates a success result with a string value", () => {
    const result = success("hello");
    expect(result).toEqual({ success: true, value: "hello" });
  });

  it("creates a success result with null value", () => {
    const result = success(null);
    expect(result).toEqual({ success: true, value: null });
  });
});

describe("failure", () => {
  it("creates a failure result with string error", () => {
    const result = failure("something went wrong");
    expect(result).toEqual({ success: false, error: "something went wrong", checkpoint: null });
  });

  it("creates a failure result with object error", () => {
    const result = failure({ code: 404, message: "not found" });
    expect(result).toEqual({
      success: false,
      error: { code: 404, message: "not found" },
      checkpoint: null,
    });
  });

  it("always sets checkpoint to null", () => {
    const result = failure("error");
    expect(result.checkpoint).toBeNull();
  });
});
```

Run: `pnpm test:run -- lib/runtime/result.test.ts`

Expected: test fails because `lib/runtime/result.ts` does not exist.

- [ ] **3b. Create `lib/runtime/result.ts`**

```typescript
// lib/runtime/result.ts
export type ResultValue = ResultSuccess | ResultFailure;

export type ResultSuccess = {
  success: true;
  value: any;
};

export type ResultFailure = {
  success: false;
  error: any;
  checkpoint: any;
};

export function success(value: any): ResultSuccess {
  return { success: true, value };
}

export function failure(error: any): ResultFailure {
  return { success: false, error, checkpoint: null };
}

export function isSuccess(result: ResultValue): result is ResultSuccess {
  return result != null && result.success === true;
}

export function isFailure(result: ResultValue): result is ResultFailure {
  return result != null && result.success === false;
}
```

Also add type guard tests in the same test file:

```typescript
describe("isSuccess", () => {
  it("returns true for success results", () => {
    expect(isSuccess(success(42))).toBe(true);
  });

  it("returns false for failure results", () => {
    expect(isSuccess(failure("error"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSuccess(null as any)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSuccess(undefined as any)).toBe(false);
  });
});

describe("isFailure", () => {
  it("returns true for failure results", () => {
    expect(isFailure(failure("error"))).toBe(true);
  });

  it("returns false for success results", () => {
    expect(isFailure(success(42))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFailure(null as any)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFailure(undefined as any)).toBe(false);
  });
});
```

Run: `pnpm test:run -- lib/runtime/result.test.ts`

Expected: all tests pass.

- [ ] **3c. Export from runtime index**

In `lib/runtime/index.ts`, add:

```typescript
export { success, failure, isSuccess, isFailure } from "./result";
```

Run: `pnpm run build` to verify no compilation errors.

- [ ] **3d. Commit**

---

## Task 4: Code generation - emit Result runtime imports and map builtins

The builder/codegen needs to: (a) recognize `success`, `failure`, `isSuccess`, `isFailure` as builtin functions, and (b) emit the correct import for them in generated code.

- [ ] **4a. Add to `BUILTIN_FUNCTIONS` in `lib/backends/typescriptGenerator/builtins.ts`**

Add entries mapping Agency builtin names to their runtime equivalents:

```typescript
success: "success",
failure: "failure",
isSuccess: "isSuccess",
isFailure: "isFailure",
```

This ensures `isBuiltinFunction()` returns true for these names and `mapFunctionName()` returns the correct runtime name.

- [ ] **4b. Add runtime import for Result functions**

Add `success, failure, isSuccess, isFailure` to the import from `agency-lang/runtime` in `lib/templates/backends/typescriptGenerator/imports.mustache`. These should be added to the existing destructured import block that imports other runtime builtins like `setupNode`, `setupFunction`, `runNode`, etc.

After editing the mustache file, run `pnpm run templates` to recompile the template to TypeScript.

Run: `pnpm run templates && pnpm run build` to verify compilation.

- [ ] **4c. Commit**

---

## Task 5: Integration test fixtures (builder + generator)

Add integration test fixtures that compile Agency code using Result types and verify the generated TypeScript.

- [ ] **5a. Create generator fixture: `tests/typescriptGenerator/result-basic.agency`**

```
def checkAge(age: number): Result {
  if age >= 18 {
    return success(age)
  }
  return failure("too young")
}
```

- [ ] **5b. Generate the expected `.mjs` fixture**

Run: `make fixtures`

This will compile the `.agency` file and produce the expected `.mjs` output. Review the generated `.mjs` to verify:
- It imports `success`, `failure` from the runtime
- The function body correctly calls `success(age)` and `failure("too young")`
- The function is set up with `setupFunction()` as expected

- [ ] **5c. Create generator fixture: `tests/typescriptGenerator/result-guards.agency`**

```
def checkValue(r: Result): string {
  if isSuccess(r) {
    return "ok"
  }
  return "error"
}
```

Run: `make fixtures`

Review the generated `.mjs` to verify `isSuccess` is correctly imported and called.

- [ ] **5d. Create builder fixture**

If the builder has its own fixture directory (`tests/typescriptBuilder/`), create matching fixtures there as well. Follow the same pattern as existing builder fixtures.

Run: `make fixtures`

- [ ] **5e. Run all integration tests**

Run: `pnpm test:run -- lib/backends/typescriptGenerator.integration.test.ts`
Run: `pnpm test:run -- lib/backends/typescriptBuilder.integration.test.ts`

Expected: all tests pass.

- [ ] **5f. Commit**

---

## Task 6: E2E test

Create an end-to-end test that compiles and executes an Agency program using Result types, without any LLM calls.

- [ ] **6a. Create `tests/agency/result-basic.agency`**

Agency has no `assert` keyword. E2E tests use `.test.json` files with `expectedOutput` and `evaluationCriteria`. Also, direct property access like `r.value` requires guard-based narrowing (deferred), so use `isSuccess`/`isFailure` guards and return a verifiable value.

```
def tryParse(input: string): Result {
  if input == "ok" {
    return success(42)
  }
  return failure("invalid input")
}

node main() {
  let r1 = tryParse("ok")
  let r2 = tryParse("bad")
  if isSuccess(r1) {
    if isFailure(r2) {
      return "both correct"
    }
  }
  return "unexpected"
}
```

- [ ] **6b. Create `tests/agency/result-basic.test.json`**

Follow the existing `.test.json` pattern (see e.g. `tests/agency/binop.test.json`):

```json
{
  "sourceFile": "result-basic.agency",
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"both correct\"",
      "evaluationCriteria": [
        {
          "type": "exact"
        }
      ]
    }
  ]
}
```

- [ ] **6c. Run the E2E test**

Run: `pnpm test:run -- tests/agency/`

Expected: program executes successfully, output matches "both correct".

- [ ] **6d. Commit**

---

## Deferred to follow-up

The following are explicitly NOT in scope for this plan:

- **All typechecker work**: Registering builtins in `BUILTIN_FUNCTION_TYPES`, Result assignability rules, constructor enforcement (only in Result-returning functions), return path enforcement (all paths must use success/failure). All typechecker tasks are deferred to Stage 7.
- **Guard-based property narrowing**: Inside `if isSuccess(r) { ... }`, accessing `r.value` should be typed as `any` and `r.error` should be a type error (and vice versa for `isFailure`). This requires flow-sensitive type narrowing in the typechecker, which is complex. For now, property access on Result values (.value, .error, .checkpoint) will work at runtime but won't have typechecker enforcement.
- **Pipe operator** (`|>`): Separate feature, separate plan.
- **Checkpoint integration**: The `checkpoint` field on failures is `null` for now. Stage 3 will integrate with the checkpointing system.
- **`retry()` method**: Will be added when checkpoint integration is done.
- **`try`/`catch` keywords**: Future enhancement for ergonomic Result handling.
