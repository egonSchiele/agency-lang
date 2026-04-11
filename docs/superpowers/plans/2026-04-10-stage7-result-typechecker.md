# Result Typechecker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all typechecker rules for the Result type system: builtin signatures, assignability, constructor enforcement, return path enforcement, pipe operator typing, try/catch typing, generic type parameter tracking, and type guard narrowing.

**Architecture:** This is a pure typechecker plan — no parser, runtime, or builder changes. All type checking centers on the `ResultType` variant (`{ type: "resultType", successType, failureType }`). The typechecker registers Result builtins, enforces Result-specific constraints (constructors only in Result-returning functions, unwrap-before-use), tracks generic type parameters through pipe chains and try/catch expressions, and implements flow-sensitive narrowing for `isSuccess`/`isFailure` type guards.

**Dependency:** Requires Stages 1-6 to be complete (Result type system, pipe operator, checkpointing, try, catch, safety net all implemented).

**Tech Stack:** TypeScript, vitest (testing)

---

## File structure

All work is in two files:

- **Modify:** `lib/typeChecker.ts` — all typechecker logic
- **Test:** `lib/typeChecker.test.ts` (or co-located test file) — all tests

Helper used in error messages (already updated in Stage 1):
- `lib/cli/util.ts` — `formatTypeHint()` already handles `resultType`

---

## Helpers

Several tasks reference a `isResultType` helper. Define it once at the top of the typechecker file:

```typescript
function isResultType(t: VariableType | "any"): t is ResultType {
  return t !== "any" && t.type === "resultType";
}
```

Also useful: a helper to create a bare Result type:

```typescript
function bareResult(): ResultType {
  return {
    type: "resultType",
    successType: { type: "primitiveType", value: "any" },
    failureType: { type: "primitiveType", value: "any" },
  };
}
```

---

## Task 1: Register Result builtins in `BUILTIN_FUNCTION_TYPES`

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result builtins", () => {
  it("success() is recognized with correct signature", () => {
    // success(42) inside a Result-returning function — no errors
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "success", arguments: [{ type: "number", value: "42" }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("failure() is recognized with correct signature", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "failure", arguments: [{ type: "string", segments: [{ type: "text", value: "err" }] }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("isSuccess() accepts Result and returns boolean", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "primitiveType", value: "boolean" },
        body: [
          {
            type: "assignment",
            variableName: "r",
            declKind: "const",
            typeHint: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
            value: { type: "functionCall", functionName: "success", arguments: [{ type: "number", value: "1" }] },
          },
          {
            type: "returnStatement",
            value: { type: "functionCall", functionName: "isSuccess", arguments: [{ type: "variableName", value: "r" }] },
          },
        ],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("isFailure() accepts Result and returns boolean", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "primitiveType", value: "boolean" },
        body: [
          {
            type: "assignment",
            variableName: "r",
            declKind: "const",
            typeHint: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
            value: { type: "functionCall", functionName: "failure", arguments: [{ type: "string", segments: [{ type: "text", value: "e" }] }] },
          },
          {
            type: "returnStatement",
            value: { type: "functionCall", functionName: "isFailure", arguments: [{ type: "variableName", value: "r" }] },
          },
        ],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests fail — builtins not registered.

- [ ] **Step 2: Add builtins to `BUILTIN_FUNCTION_TYPES`**

```typescript
success: {
  params: ["any"],
  returnType: bareResult(),
},
failure: {
  params: ["any"],
  returnType: bareResult(),
},
isSuccess: {
  params: [bareResult()],
  returnType: { type: "primitiveType", value: "boolean" },
},
isFailure: {
  params: [bareResult()],
  returnType: { type: "primitiveType", value: "boolean" },
},
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): register Result builtins"
```

---

## Task 2: Result assignability rules

**Files:**
- Modify: `lib/typeChecker.ts` — `isAssignable()` method
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result assignability", () => {
  it("Result<S,E> is assignable to Result<S,E>", () => {
    // success() returning Result in a Result-returning function — no errors
    // (already tested in Task 1, but verify assignability specifically)
  });

  it("Result<string,any> is assignable to Result<any,any> (bare Result)", () => {
    // Assign a Result<string,any> to a variable typed as bare Result
  });

  it("Result<any,any> is assignable to Result<string,any>", () => {
    // Bare Result assignable to specific Result (any is flexible)
  });

  it("Result is NOT assignable to string", () => {
    // Function returns string but returns success(...) — error
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "primitiveType", value: "string" },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "success", arguments: [{ type: "number", value: "1" }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("string is NOT assignable to Result", () => {
    // Function returns Result but returns bare string — error
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
        body: [{
          type: "returnStatement",
          value: { type: "string", segments: [{ type: "text", value: "hello" }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: some tests fail.

- [ ] **Step 2: Add Result assignability to `isAssignable()`**

In `isAssignable(source, target)`, after the existing union/literal checks and before the final `return false`, add:

```typescript
// ResultType assignability
if (isResultType(resolvedSource) && isResultType(resolvedTarget)) {
  return (
    this.isAssignable(resolvedSource.successType, resolvedTarget.successType) &&
    this.isAssignable(resolvedSource.failureType, resolvedTarget.failureType)
  );
}

// Result is not assignable to non-Result (except any/unknown, handled above)
if (isResultType(resolvedSource) || isResultType(resolvedTarget)) {
  return false;
}
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): Result assignability rules with generic params"
```

---

## Task 3: Constructor enforcement — success()/failure() only in Result-returning functions

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result constructor enforcement", () => {
  it("success() inside Result-returning function is allowed", () => {
    // Already passes from Task 1
  });

  it("success() inside non-Result function is an error", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "primitiveType", value: "string" },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "success", arguments: [{ type: "number", value: "42" }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("success");
  });

  it("failure() inside non-Result function is an error", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "primitiveType", value: "number" },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "failure", arguments: [{ type: "string", segments: [{ type: "text", value: "err" }] }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("failure");
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: last two tests fail.

- [ ] **Step 2: Add constructor enforcement**

In `checkSingleFunctionCall()` (or a new check within scope iteration), when the function being called is `"success"` or `"failure"`:

1. Find the enclosing scope's `returnType` — this is available as `scope.returnType` in the scope iteration in `checkScopes()`. You may need to pass the scope's return type down to the function call checker, or add a new check in the scope iteration.
2. If `scope.returnType` is not a `resultType`, emit error: `"'success()' can only be used inside a function that returns Result"` (or `failure`).

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): enforce success/failure only in Result-returning functions"
```

---

## Task 4: Return path enforcement — Result functions must use success()/failure()

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result return path enforcement", () => {
  it("returning bare value from Result function is an error", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: { type: "resultType", successType: { type: "primitiveType", value: "any" }, failureType: { type: "primitiveType", value: "any" } },
        body: [{
          type: "returnStatement",
          value: { type: "number", value: "42" },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/success|failure/i);
  });

  it("all paths using success/failure is valid", () => {
    // Function with if/else, both branches return success/failure — no errors
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: first test fails.

- [ ] **Step 2: Add return path enforcement**

In `checkReturnTypesInScope()`, when `scope.returnType` is a `resultType`:

For each return statement, check that its value is a `functionCall` with `functionName` of `"success"` or `"failure"`. If not, emit error: `"Functions returning Result must return success(...) or failure(...), not a bare value"`.

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): enforce return paths use success/failure in Result functions"
```

---

## Task 5: Generic type checking for success()/failure()

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result generic type checking", () => {
  it("success(42) in Result<number, string> is valid", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: {
          type: "resultType",
          successType: { type: "primitiveType", value: "number" },
          failureType: { type: "primitiveType", value: "string" },
        },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "success", arguments: [{ type: "number", value: "42" }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors).toHaveLength(0);
  });

  it("success('hello') in Result<number, string> is an error", () => {
    const program: AgencyProgram = {
      type: "agencyProgram",
      nodes: [{
        type: "function",
        functionName: "foo",
        parameters: [],
        returnType: {
          type: "resultType",
          successType: { type: "primitiveType", value: "number" },
          failureType: { type: "primitiveType", value: "string" },
        },
        body: [{
          type: "returnStatement",
          value: { type: "functionCall", functionName: "success", arguments: [{ type: "string", segments: [{ type: "text", value: "hello" }] }] },
        }],
      }],
    };
    const { errors } = typeCheck(program);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("failure(42) in Result<string, number> is valid", () => {
    // number matches the failureType
  });

  it("failure(42) in Result<string, string> is an error", () => {
    // number does not match string failureType
  });

  it("bare Result<any,any> skips generic checks", () => {
    // success("anything") in a bare Result function — no errors
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: the "is an error" tests fail (no generic checking yet).

- [ ] **Step 2: Implement generic checking for constructors**

In the return path enforcement or function call checking:

When `success(val)` is called inside a function returning `Result<S, E>` where `S` is not `any`:
1. Infer the type of `val` via `synthType(val, scopeVars)`
2. Check `isAssignable(valType, S)` — if not, emit error: `"Argument type 'X' is not assignable to Result success type 'S'"`

When `failure(err)` is called inside a function returning `Result<S, E>` where `E` is not `any`:
1. Infer the type of `err`
2. Check `isAssignable(errType, E)` — if not, emit error

To find the enclosing Result's generic params: the scope's `returnType` is available as a `ResultType` node — read `.successType` and `.failureType`.

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): generic type checking for success/failure constructors"
```

---

## Task 6: synthType for pipe operator (`|>`)

**Files:**
- Modify: `lib/typeChecker.ts` — `synthType()` method
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Pipe operator type checking", () => {
  it("left side of |> must be Result", () => {
    // 42 |> someFunc — error: left side is number, not Result
  });

  it("|> expression has Result type", () => {
    // success(1) |> someFunc — result type is Result
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests fail.

- [ ] **Step 2: Add `|>` case to synthType**

In `synthType()`, in the `binOpExpression` case, add handling for `operator === "|>"`:

```typescript
if (op === "|>") {
  const leftType = this.synthType(expr.left, scopeVars);
  if (leftType !== "any" && !isResultType(leftType)) {
    this.errors.push({
      message: `Left side of '|>' must be a Result, but got '${formatTypeHint(leftType)}'.`,
    });
  }
  // The right side is desugared by the builder to a function call.
  // The result of a pipe expression is always Result.
  return bareResult();
}
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): pipe operator type checking"
```

---

## Task 7: synthType for try expression

**Files:**
- Modify: `lib/typeChecker.ts` — `synthType()` method
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("try expression type checking", () => {
  it("try expression has Result type", () => {
    // try someFunc() — synthType should return resultType
  });

  it("warns when try is applied to Result-returning function", () => {
    // try resultReturningFunc() — should emit a warning
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests fail.

- [ ] **Step 2: Add tryExpression case to synthType**

```typescript
case "tryExpression": {
  // try always produces a Result
  // Check for double-wrapping: if the wrapped function already returns Result, warn
  const callReturnType = this.synthType(expr.call, scopeVars);
  if (callReturnType !== "any" && isResultType(callReturnType)) {
    this.errors.push({
      message: `Warning: 'try' applied to a function that already returns Result. This will double-wrap the Result.`,
    });
  }
  return bareResult();
}
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): try expression type checking with double-wrap warning"
```

---

## Task 8: synthType for catch operator

**Files:**
- Modify: `lib/typeChecker.ts` — `synthType()` method
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("catch operator type checking", () => {
  it("left side of catch must be Result", () => {
    // 42 catch 0 — error: left side is number, not Result
  });

  it("catch with plain fallback returns fallback type", () => {
    // success(1) catch 0 — result type is number
  });

  it("catch with Result fallback returns Result (for chaining)", () => {
    // try foo() catch try bar() — result type is Result
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests fail.

- [ ] **Step 2: Add catch case to synthType**

In `synthType()` binOpExpression case, add handling for `operator === "catch"`:

```typescript
if (op === "catch") {
  const leftType = this.synthType(expr.left, scopeVars);
  if (leftType !== "any" && !isResultType(leftType)) {
    this.errors.push({
      message: `Left side of 'catch' must be a Result, but got '${formatTypeHint(leftType)}'.`,
    });
  }
  const fallbackType = this.synthType(expr.right, scopeVars);
  // catch always unwraps. If fallback is Result, the chain continues.
  return fallbackType;
}
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): catch operator type checking"
```

---

## Task 9: Placeholder validation

**Files:**
- Modify: `lib/typeChecker.ts` — `synthType()` method
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("placeholder outside of pipe is a type error", () => {
  // Construct an AST with a placeholder node not inside |>
  // synthType should emit an error
});
```

- [ ] **Step 2: Add placeholder case to synthType**

```typescript
case "placeholder":
  this.errors.push({
    message: "'?' placeholder can only be used on the right side of '|>'.",
  });
  return "any";
```

Note: The builder desugars `?` away before codegen. The typechecker sees the raw AST, so `?` nodes that appear outside `|>` right-hand sides will hit this case. Inside `|>`, the typechecker skips deep-checking the right side's arguments (since they're desugared by the builder).

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): placeholder validation"
```

---

## Task 10: Type guard narrowing for isSuccess/isFailure

This is the most complex task. Inside `if isSuccess(r) { ... }`, property access `r.value` should be typed as the Result's success type. Inside `if isFailure(r) { ... }`, `r.error` should be typed as the failure type.

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe("Result type guard narrowing", () => {
  it("r.value inside isSuccess guard is typed as successType", () => {
    // def foo(): string {
    //   const r: Result<string, number> = success("hello")
    //   if isSuccess(r) {
    //     return r.value   // should be string, assignable to return type string
    //   }
    //   return ""
    // }
    // Construct AST with: function returning string, assignment of r as Result<string, number>,
    // ifElse with condition isSuccess(r), thenBody with return r.value (valueAccess: base=r, chain=[{kind: "property", name: "value"}])
    // Expect: no errors
  });

  it("r.error inside isFailure guard is typed as failureType", () => {
    // Similar but with isFailure and .error access
  });

  it("r.value outside any guard is a type error", () => {
    // Direct access r.value on a Result without a guard — error
  });
});
```

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests fail.

- [ ] **Step 2: Implement narrowing in collectVariableTypes**

The approach: in `collectVariableTypes`, when processing an `ifElse` node, detect the type guard pattern.

**Detection:** Check if the ifElse condition is a `functionCall` where `functionName` is `"isSuccess"` or `"isFailure"` and the single argument is a `variableName`.

**Narrowing:** If detected:
1. Look up the variable's type in `vars` — must be a `resultType`
2. Save the original type
3. For `isSuccess`: temporarily set `vars[varName]` to an `objectType` with property `{ key: "value", value: resultType.successType }`
4. For `isFailure`: temporarily set `vars[varName]` to an `objectType` with properties `{ key: "error", value: resultType.failureType }` and `{ key: "checkpoint", value: { type: "primitiveType", value: "any" } }`
5. Recurse into `thenBody` with the narrowed vars
6. Restore the original type after processing thenBody

This leverages the existing `synthValueAccess` which already knows how to resolve property access on `objectType`. The narrowing just temporarily changes the variable's type so property access works.

**For the "outside guard" case:** Without narrowing, `r` has type `resultType`, and `synthValueAccess` will try to do property access on a `resultType` which is not an `objectType` — it will emit an error. This is the desired behavior.

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): type guard narrowing for isSuccess/isFailure"
```

---

## Task 11: .retry() validation (simplified)

**Files:**
- Modify: `lib/typeChecker.ts`
- Test: `lib/typeChecker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe(".retry() validation", () => {
  it(".retry() on a Result-typed variable is allowed", () => {
    // r.retry("new arg") where r is typed as Result — no error from typechecker
    // (the builder handles desugaring; the typechecker just validates the base type)
  });

  it(".retry() on a non-Result variable is an error", () => {
    // x.retry("arg") where x is typed as string — error
  });
});
```

- [ ] **Step 2: Add retry validation**

In `synthValueAccess`, when processing a `methodCall` element named `"retry"`:
- Check that the current type being accessed is a `resultType`
- If not, emit error: `"'.retry()' can only be called on a Result value"`.
- Return type is `"any"` (since retry never returns — it throws a RestoreSignal).

Note: Full validation (must be inside `isFailure` guard, arity must match) is hard to enforce statically. This simplified check catches the most common mistake (calling retry on a non-Result).

Run: `pnpm test:run -- lib/typeChecker`
Expected: tests pass.

- [ ] **Step 3: Commit**

```bash
git add lib/typeChecker.ts lib/typeChecker.test.ts
git commit -m "feat(typechecker): .retry() validation on Result types"
```

---

## Summary

| Task | What | Complexity |
|------|------|------------|
| 1 | Register builtins | Easy |
| 2 | Result assignability (with generics) | Easy |
| 3 | Constructor enforcement | Easy |
| 4 | Return path enforcement | Easy |
| 5 | Generic type checking for success/failure args | Medium |
| 6 | Pipe operator typing | Easy |
| 7 | Try expression typing + double-wrap warning | Easy |
| 8 | Catch operator typing | Easy |
| 9 | Placeholder validation | Trivial |
| 10 | Type guard narrowing | Hard |
| 11 | .retry() validation | Easy |
