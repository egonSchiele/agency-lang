# Result Type and Pipe Operator Design

## Overview

This spec introduces three related features to Agency:

1. A built-in `Result` type for explicit error handling
2. A `|>` pipe operator for chaining Result-returning operations
3. Scoped partial application within `|>` chains

Together, these features give Agency users a principled way to handle errors — leveraging the type system to enforce that failures are handled, and leveraging Agency's checkpoint system to enable retrying from the point of failure.

## Motivation

In agent workflows, operations fail frequently: LLM calls time out, structured output doesn't match the schema, external APIs return errors. Today, Agency users handle these failures with ad-hoc patterns — checking return values, throwing exceptions, or ignoring errors entirely. None of these approaches leverage the type system.

The Result type makes failure explicit in function signatures. The typechecker enforces that callers handle failures before using return values. The pipe operator eliminates the boilerplate of chaining multiple fallible operations. And because Agency already has checkpoint/restore infrastructure, failures can carry execution snapshots that allow retrying from the point of failure with modified inputs — something no other language can do.

## Design

### The Result Type

`Result` is a new built-in opaque primitive type. Users cannot access its internals directly — they must use the provided built-in functions to inspect and unwrap it.

At runtime, a Result is a discriminated union:

```typescript
// Success case
{ success: true, value: any }

// Failure case
{ success: false, error: any, checkpoint: Checkpoint }
```

`Result` is opaque in the Agency type system — the typechecker does not track the inner success or failure types. When unwrapped, the value is typed as `any`. This is a deliberate scope decision; full type tracking (e.g., `Result<SuccessType, FailureType>`) requires generics, which will be added as a follow-up feature.

### Constructors

Two built-in functions construct Result values:

```
def riskyOperation(): Result {
  if someCondition {
    return success(userData)
  }
  return failure("user not found")
}
```

- `success(value)` — wraps a value as a successful Result
- `failure(error)` — wraps an error as a failed Result. The checkpoint is not created here — it was captured automatically at the function's entry point (see Checkpointing section). `failure()` retrieves that stored checkpoint and embeds it in the failure object.

**Typechecker rules:**
- `success()` and `failure()` can only be used inside functions that declare `Result` as their return type. Using them in a function with a different return type is a type error.
- If a function declares `Result` as its return type, every return path must use `success()` or `failure()`. Returning a bare value is a type error.

### Unwrapping and Type Guards

Two built-in functions inspect Result values:

```
const result = riskyOperation()

if isSuccess(result) {
  // Inside this branch, result.value is accessible (typed as any)
  print(result.value)
}

if isFailure(result) {
  // Inside this branch, result.error and result.checkpoint are accessible
  print(result.error)
}
```

- `isSuccess(result)` — returns true if the Result is a success. Acts as a type guard: inside the if-branch, `.value` is accessible.
- `isFailure(result)` — returns true if the Result is a failure. Acts as a type guard: inside the if-branch, `.error` and `.checkpoint` are accessible.

These are the only ways to unwrap a Result. Accessing `.value`, `.error`, `.checkpoint`, or `.retry()` outside of a guarded branch is a type error.

### Type Assignability Rules

`Result` is its own type. The typechecker enforces:

- `Result` is assignable to `Result` and `any`
- `Result` is NOT assignable to any other type (`string`, `number`, etc.)
- You can pass a `Result` to functions that accept `Result` or `any`
- You can `print()` a Result (since `print` accepts `any`)
- You can store a Result in a variable
- You can return a Result from a function that returns `Result`
- You CANNOT use a Result where a non-Result type is expected — this is a hard type error

The key guarantee: you cannot accidentally use a Result as if it were the underlying value. You must unwrap it first.

### The Pipe Operator (`|>`)

`|>` is a new left-associative binary operator with the lowest precedence (below `||`). It sits below all logical/arithmetic operators but is still an expression-level operator — it does not interact with assignment or declaration syntax. `const x = foo() |> bar` parses as `const x = (foo() |> bar)`.

```
const result = foo(x) |> bar |> baz
// Parses as: (foo(x) |> bar) |> baz
```

**Semantics:**

The left side must be a `Result`. The right side must be a function (either a function reference or a partial application — see below). The operator:

1. If the left side is a failure, short-circuit: return the failure as-is (with its checkpoint).
2. If the left side is a success, unwrap `.value` and pass it to the right-side function.
3. If the right-side function returns `Result`, the overall expression is that `Result` (monadic bind).
4. If the right-side function returns a non-Result type, wrap it in `success()` automatically (functorial fmap).

In all cases, the type of a `|>` expression is `Result`.

**Smart bind/fmap:** The typechecker inspects the return type of the right-side function to determine whether to bind (function returns `Result`) or fmap (function returns a plain type). This means the same operator handles both cases, and the user doesn't need to think about the distinction.

**Typechecker rules:**
- Left side of `|>` must be `Result`
- Right side must be a callable (function reference or partial application)
- Since `Result` is opaque (no inner type tracking), the typechecker cannot verify that the unwrapped value matches the function's parameter type. This will become a compile-time check when generics are added. For now, a type mismatch here is a runtime error.

### Scoped Partial Application in Pipe Chains

On the right side of `|>`, function calls use the `?` placeholder to indicate where the piped value should be inserted.

```
def multiply(factor: number, value: number): Result {
  return success(factor * value)
}

def validate(min: number, max: number, value: number): Result {
  if value < min || value > max {
    return failure("out of range")
  }
  return success(value)
}

const result = foo(1) |> multiply(10, ?) |> validate(0, ?, 100)
// multiply(10, unwrapped) then validate(0, unwrapped, 100)
```

The `?` placeholder makes it explicit which parameter receives the piped value, and allows it to be any parameter — not just the last one.

```
// Piped value as first argument:
foo(1) |> add(?, 10)

// Piped value as middle argument:
foo(1) |> validate(0, ?, 100)

// Piped value as last argument:
foo(1) |> multiply(10, ?)
```

**Rules:**
- Exactly one argument in the right-side function call must be `?`. Zero placeholders or more than one placeholder is a type error.
- A bare function reference (no call syntax) is also valid on the right side of `|>` for single-argument functions: `foo(1) |> bar` is equivalent to `foo(1) |> bar(?)`.
- A property access (method reference) is also valid on the right side of `|>`: `foo(1) |> obj.method` is equivalent to `foo(1) |> obj.method(?)`. The compiler preserves the `this` binding automatically (see Code Generation below).
- The `?` placeholder is only valid on the right side of `|>`. Using `?` as a function argument outside of a pipe chain is a syntax error.

**Code generation:** The compiler desugars the right side of `|>` into a lambda:

- Bare function reference: `bar` becomes `(x) => bar(x)`.
- Method reference: `obj.method` becomes `(x) => obj.method(x)`. This preserves the `this` binding — the compiler generates a call expression on the original object, not a detached function reference. This means users never need to think about JavaScript's `this` binding issues when piping to methods.
- Partial application: `multiply(10, ?)` becomes `(x) => multiply(10, x)`. `validate(0, ?, 100)` becomes `(x) => validate(0, x, 100)`.
- Method with partial application: `obj.method(10, ?)` becomes `(x) => obj.method(10, x)`. The same `this`-preserving rule applies.

### Automatic Checkpointing and Retry

**Checkpoint capture:** At the entry of every function that returns `Result`, the runtime automatically calls `checkpoint()`. This captures the StateStack (call stack frames, locals, arguments, step counters, message threads) and GlobalStore (module-scoped globals). The checkpoint ID is stored internally in the function's scope. When `failure()` is called within that function, it retrieves this stored checkpoint ID and embeds it in the failure object.

**Retry:** Failures support a `retry` call, which is syntactic sugar desugared by the compiler (not a real method on the runtime object):

```
shared attempts = 0

def riskyOperation(input: string): Result {
  attempts = attempts + 1
  if someCondition {
    return success(data)
  }
  return failure("bad input")
}

node main() {
  const result = riskyOperation("first try")
  if isFailure(result) {
    if attempts < 5 {
      result.retry("different input")
    }
    // gave up after 5 attempts
    print(result.error)
  }
}
```

`result.retry(newArg)` is compiler-desugared to `restore(result.checkpoint, { args: [newArg] })`. It is not a real method on the failure object — the compiler recognizes `.retry(...)` on a Result inside an `isFailure` guard and emits the corresponding `restore` call. Using `.retry()` outside an `isFailure` guard is a type error.

`retry` accepts variadic arguments that replace all of the original function's parameters. For a function `def riskyOp(a: string, b: number): Result`, `result.retry("new", 42)` replaces both arguments. The number of arguments passed to `retry` must match the original function's arity — the compiler knows this from the checkpoint metadata. A mismatch is a type error.

The desugared `restore` call:

1. Throws a `RestoreSignal` (never returns)
2. Rewinds execution to the checkpointed function entry
3. The `RestoreSignal` is caught by `runNode()`, which calls `ctx.restoreState(checkpoint)`
4. During state restoration, after the StateStack is deserialized from the checkpoint, the argument overrides from `RestoreOptions.args` are patched onto the top stack frame's arguments, replacing the original values
5. Execution re-enters the checkpointed node; step counters skip past already-executed statements up to the function entry
6. The function re-executes with the new arguments, along with everything after it (including remaining steps in a `|>` pipeline)

Because `retry` uses the checkpoint/restore mechanism, the full pipeline after the failed function re-executes naturally. Shared variables persist across retries (they are not serialized), while local variables and arguments are restored from the checkpoint (then overridden with the new arguments).

**Retry limit:** Result retries are governed by a separate `result.maxRetries` configuration, distinct from the existing `checkpoints.maxRestores` that governs manually-created checkpoints. The default is 50. This can be overridden:

```json
{
  "result": {
    "maxRetries": 50
  }
}
```

After N retries, the runtime throws a hard error and halts execution. The count tracks across all retries of the same checkpoint. This is separate from `checkpoints.maxRestores`, which governs manually-created checkpoints.

### Extensions to `restore()`

Currently, `restore()` supports overriding messages via `RestoreOptions`. This design extends `RestoreOptions` to also support:

- **Argument overrides** — replace the arguments the function was called with. This is what `retry` uses.
- **Global variable overrides** — modify module-scoped global variables before re-execution.

Updated `RestoreOptions`:

```typescript
type RestoreOptions = {
  messages?: MessageJSON[];
  args?: any[];           // new: override function arguments
  globals?: Record<string, Record<string, any>>;  // new: override globals by module
};
```

**How argument overrides work in the restore flow:**

1. `restore()` throws a `RestoreSignal` containing the checkpoint and the `RestoreOptions`
2. `runNode()` catches the signal and calls `ctx.restoreState(checkpoint)`
3. `restoreState` deserializes the `StateStack` from the checkpoint, entering deserialize mode
4. After deserialization, if `RestoreOptions.args` is provided, the runtime patches the top stack frame's `args` object with the override values, replacing the original arguments positionally
5. Similarly, if `RestoreOptions.globals` is provided, the runtime patches the `GlobalStore` with the override values after deserialization
6. Execution re-enters the checkpointed node with the modified state

### Interaction Between Features

**`|>` with retry:** When `foo |> bar |> baz` fails at `bar`, the failure carries a checkpoint from `bar`'s entry. Calling `result.retry(newArg)` restores to `bar`'s entry with the new argument. Since the checkpoint was taken within the pipeline's execution, the step counters ensure that `baz` re-executes after `bar` completes.

**`isSuccess`/`isFailure` with `|>`:** The result of a `|>` chain is a `Result`, so the user unwraps it with the same type guards:

```
const result = foo(1) |> bar |> baz

if isSuccess(result) {
  print(result.value)
}

if isFailure(result) {
  result.retry(newArg)
}
```

**Nested Results:** Since `|>` uses smart bind/fmap, there's no risk of `Result<Result<T>>` nesting. If the right-side function returns `Result`, the operator uses bind (no re-wrapping). If it returns a plain value, the operator uses fmap (wraps in `success()`).

**Sequentiality:** `|>` chains are inherently sequential — each step depends on the previous step's result. Even if functions in the chain make LLM calls or other async operations, they execute one at a time.

**Nested Result-returning functions:** When Result-returning functions call other Result-returning functions, each gets its own checkpoint at entry. The failure carries the checkpoint of the function that called `failure()` — the innermost one. This means the caller can only retry the innermost function, not an outer one. This is a known limitation. Users who need to retry at a higher level can use manual `checkpoint()` / `restore()` calls. A future enhancement could attach a checkpoint stack to failures, but this is out of scope for the initial implementation.

## Configuration

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| `result.maxRetries` | `agency.json` | 50 | Max retries per Result failure checkpoint before hard error |
| `checkpoints.maxRestores` | `agency.json` | 100 | Max restores per manually-created checkpoint (existing, unchanged) |

## Design Decisions and Rationale

### Why Result is opaque (no generic type parameters)

Agency does not currently support generics. Adding `Result<SuccessType, FailureType>` would require either full generics or a special-case parser for Result-specific type parameters. To keep scope contained, Result is opaque — the typechecker knows something is a Result but doesn't track inner types. This still provides the key safety guarantee (must unwrap before use). Full type tracking is a natural follow-up when generics are added.

### Why `|>` is hardcoded to Result (not general-purpose monadic bind)

We considered generalizing `|>` to work with any "wrapper" type (Optional, arrays, etc.). Analysis of agent workflow patterns showed that Result is the dominant use case. Other patterns are either already handled by Agency features (threads for state, implicit async for promises) or too niche to justify language-level support. Starting with Result-only keeps the implementation simple; the operator can be extended to other types later if needed.

### Why smart bind/fmap instead of two operators

We considered separate operators for bind (`|>` for monadic) and fmap (`|>` for functorial). While mathematically cleaner, this would confuse users who don't know the distinction. The smart approach — inspect the return type of the right-side function — is unambiguous and handles both cases transparently. The typechecker already knows the return type, so the implementation cost is minimal.

### Why automatic checkpointing (not opt-in)

Every function returning Result gets a checkpoint at entry automatically. This is simpler than requiring annotations or opt-in syntax. The performance overhead is bounded (one checkpoint per Result-returning function call, not per step). Users who don't need retry simply ignore the checkpoint on failures.

### Why retry rewinds (not returns)

`retry` uses the existing checkpoint/restore mechanism, which throws a `RestoreSignal` and rewinds the entire execution state. This means `retry` never returns a value — it replaces the call stack. This is consistent with how `restore()` already works and avoids introducing a new control flow pattern.

### Why explicit `?` placeholder instead of implicit parameter position

We initially considered having the piped value implicitly fill the last parameter (Haskell-style). The `?` placeholder is better because: (1) it's readable — you can see exactly where the piped value goes at a glance, (2) it's flexible — not locked to a fixed position, (3) there's no hidden convention to remember, and (4) it simplifies typechecking since the compiler doesn't need to infer which parameter is missing.

## Analogs in Other Languages

| Language | Error type | Chaining | Partial application |
|----------|-----------|----------|-------------------|
| Rust | `Result<T, E>` | `?` operator (early return on Err) | No built-in partial application |
| Haskell | `Either a b` | `>>=` (monadic bind) | All functions curried by default |
| Swift | `Result<Success, Failure>` | `flatMap` / `map` | No built-in partial application |
| Elixir | `{:ok, value}` / `{:error, reason}` | `with` blocks | Pipe `\|>` passes as first arg |
| **Agency** | `Result` (opaque) | `\|>` (smart bind/fmap) | Scoped to `\|>`, explicit `?` placeholder |

Agency's unique contribution is **checkpoint-backed retry on failure** — no other language can rewind execution state to the point of failure and retry with modified inputs.

## Known Omissions and Future Work

- **Generics:** `Result` is opaque — no inner type tracking. Adding `Result<SuccessType, FailureType>` is a natural follow-up when generics are added to Agency.
- **`unwrap()` convenience function:** A built-in that returns the value or throws on failure (common in Rust/Swift). Useful but not essential for the initial implementation.
- **Nested checkpoint retry:** Failures only carry the innermost checkpoint. A checkpoint stack for multi-level retry is a potential future enhancement.
- **`|>` for other types:** The operator is hardcoded to Result. Extending to Optional, arrays, or user-defined wrapper types is possible if demand arises.
- **`failure()` in nodes:** Nodes don't have return type annotations in the same way functions do. Using `success()` / `failure()` at the top level of a node is not supported in this design — these constructors are scoped to functions with an explicit `Result` return type.
