# Try Keyword Design

## Overview

This spec introduces the `try` and `catch` keywords to Agency. `try` converts exceptions thrown by any function call into `Result` values, bridging the gap between JavaScript's exception-based error handling and Agency's value-based error handling. `catch` provides a concise way to unwrap a `Result` with a fallback value on failure.

## Motivation

Agency does not use exceptions. Errors are values represented by the `Result` type (see the Result Type and Pipe Operator spec). However, Agency users can import TypeScript/JavaScript code that may throw exceptions. Without `try`, an exception from imported code crashes the program.

The `try` keyword lets users opt into exception-to-Result conversion at the call site. This keeps Agency's default behavior close to JavaScript (functions return values, not Results) while giving users a principled way to handle exceptions when they choose to.

### Design goals

- **Opt-in, not mandatory.** Users choose which calls to wrap with `try`. Functions that don't throw can be called normally.
- **Familiar to JavaScript developers.** Agency should not force a Rust-style "everything is a Result" paradigm. `try` is there when you need it, invisible when you don't.
- **Composable with `|>`.** A `try` expression produces a `Result`, which feeds naturally into pipe chains.

## Design

### Syntax

```
const result = try someFunction(args)
```

`try` is a unary prefix keyword that applies to a single function call expression. It wraps the call in a try-catch at runtime, converting the outcome into a `Result`:

- If the function returns normally, the return value is wrapped in `success()`.
- If the function throws, the caught exception is wrapped in `failure()`.

### Semantics

`try` can be applied to any function call — imported TypeScript, imported Agency functions, or Agency-defined functions. The type of a `try` expression is always `Result`.

```
import { parseJSON } from "./utils.js"

const result = try parseJSON(rawString)

if isSuccess(result) {
  print(result.value)
}

if isFailure(result) {
  print("Parse failed: " + result.error)
}
```

### Code generation

`try someFunction(args)` compiles to a runtime helper call:

```typescript
const result = __tryCall(() => someFunction(args));
```

Where `__tryCall` is a runtime function:

```typescript
function __tryCall(fn: () => any): Result {
  try {
    const value = fn();
    return { success: true, value };
  } catch (error) {
    return { success: false, error, checkpoint: __currentCheckpoint() };
  }
}
```

If the call is inside a function that returns `Result` (and therefore has automatic checkpointing), the failure includes the checkpoint. If the call is outside a Result-returning function, the checkpoint field is `null` and `retry` is not available.

### Async calls

For async function calls, `try` also awaits the result:

```
const result = try async fetchData(url)
```

Compiles to:

```typescript
const result = await __tryCallAsync(async () => fetchData(url));
```

### The `catch` Keyword

`catch` fully unwraps a `Result`, providing a fallback value if the Result is a failure. It always produces a **plain value** (not a Result) — on both the success and failure branches.

```
const data = try parseJSON(rawString) catch defaultData
```

- If `parseJSON` returns normally → `data` is the return value (unwrapped from the Result)
- If `parseJSON` throws → `data` is `defaultData`

In both cases, `data` is a plain value. `catch` is an assertion: "I will handle both outcomes right here, give me a value."

This is distinct from `try` alone:

- `try foo()` → gives you a `Result` to inspect later
- `try foo() catch default` → gives you a plain value, guaranteed

**`catch` applies to any `Result`, not just `try` expressions:**

```
const value = riskyOperation() catch 0
const config = loadConfig("app.json") catch defaultConfig
```

**The right side of `catch` is any expression:**

```
const data = try parseJSON(raw) catch {}
const port = try readPort() catch 8080
const user = fetchUser(id) catch createDefaultUser()
```

The right-side expression is only evaluated if the left side is a failure (short-circuit evaluation).

**Code generation:** `<result> catch <fallback>` compiles to:

```typescript
const data = __catchResult(try_result, () => fallback);
```

Where `__catchResult` is a runtime function:

```typescript
function __catchResult(result: Result, fallback: () => any): any {
  if (result.success) {
    return result.value;
  }
  return fallback();
}
```

### Chaining `catch`

`catch` can be chained to create a sequence of fallbacks. When the right side of `catch` is itself a `try` expression (which produces a `Result`), the next `catch` can handle that Result:

```
const data = try fetchFromCache(key) catch try fetchFromDB(key) catch try fetchFromAPI(key) catch defaultData
```

This reads left-to-right: try the cache; if that fails, try the database; if that fails, try the API; if that fails, use the default.

**How it evaluates:**

1. `try fetchFromCache(key)` produces a `Result`.
2. The first `catch` checks it. If success, return the cached value — done.
3. If failure, evaluate the fallback: `try fetchFromDB(key)`. This produces a new `Result`.
4. The second `catch` checks it. If success, return the DB value — done.
5. If failure, evaluate: `try fetchFromAPI(key)`. Another `Result`.
6. The third `catch` checks it. If success, return the API value — done.
7. If failure, return `defaultData`.

**The key rule:** `catch` always unwraps. If the right side of `catch` produces a `Result`, that `Result` becomes the new left side for the next `catch`. If the right side produces a plain value, that's the final value and the chain terminates.

**Precedence:** `catch` binds tighter than `|>` but looser than function calls and `try`. In a `try ... catch ... |>` expression, `catch` resolves first:

```
try foo() catch default |> bar
// Parses as: (try foo() catch default) |> bar
// Type error: left side of |> is a plain value, not a Result

// To pipe then catch, use parentheses:
(try foo() |> bar |> baz) catch default
```

### Interaction with `|>`

`try` produces a `Result`, so it composes directly with pipe chains:

```
const result = try parseJSON(rawString) |> validate |> transform
```

This reads as: try parsing the JSON; if it succeeds, pipe the value through validate and transform. If `parseJSON` throws, the failure short-circuits the entire chain.

**Combining `|>` and `catch`:**

```
// Pipe chain with a catch at the end — always produces a plain value
const value = (try parseJSON(raw) |> validate |> transform) catch defaultValue

// Fallback chain with its own pipe
const value = (try fetchData(url) |> process) catch (try fetchFallback() |> process) catch defaultValue
```

### Interaction with Result-returning functions

If the function being called already returns `Result`, `try` still wraps the call. This means:

- If the function returns `success(value)` normally, `try` wraps it in another `success()` — producing `success(Result)`. This is likely not what the user wants.
- If the function throws (which Result-returning functions shouldn't do), `try` catches the exception.

**Typechecker rule:** The typechecker emits a warning when `try` is applied to a function that already returns `Result`, since the double-wrapping is almost certainly a mistake. The user should call Result-returning functions directly without `try`.

### Interaction with checkpointing and retry

When `try` is used inside a function that returns `Result`, the function already has an automatic checkpoint at entry. The failure produced by `try` includes this checkpoint, so `retry` works:

```
def loadConfig(path: string): Result {
  const parsed = try parseJSON(readFile(path))
  if isFailure(parsed) {
    return failure("invalid config: " + parsed.error)
  }
  return success(parsed.value)
}

node main() {
  const config = loadConfig("config.json")
  if isFailure(config) {
    config.retry("fallback.json")
  }
}
```

When `try` is used outside a Result-returning function, the failure has no checkpoint and `retry` is not available. Accessing `.retry()` on such a failure is a type error.

### Top-level safety net

Independent of `try`, the top-level node execution is wrapped in a try-catch that produces a readable error message for any unhandled exception. This ensures that even without `try`, an exception from imported code does not produce a raw stack trace crash. Instead, the user sees a clear error message indicating which function threw and what the error was.

This is not a Result — it is a hard error that terminates execution. `try` is the mechanism for converting exceptions into handleable values; the top-level catch is a last resort for exceptions the user did not anticipate.

## Typechecker Rules

### `try`

- The type of `try <expr>` is `Result`.
- `try` can only be applied to function call expressions (not arbitrary expressions, variable references, or literals). `try 5` or `try someVariable` is a syntax error.
- The typechecker warns when `try` is applied to a function that returns `Result`, since this produces a double-wrapped Result.
- `Result` values produced by `try` follow all existing Result assignability rules (must unwrap before use, cannot be used where a non-Result type is expected, etc.).

### `catch`

- The left side of `catch` must be a `Result`. Using `catch` on a non-Result value is a type error.
- The type of `<result> catch <fallback>` is the type of the fallback expression. Since `Result` is opaque, the typechecker cannot verify that the success value and fallback have the same type — this will be checked when generics are added.
- Exception: when the right side of `catch` is a `Result` (e.g., `try foo() catch try bar()`), the type of the overall expression is `Result`, enabling further chaining. The final `catch` in a chain should have a plain value to ensure the chain always resolves to a non-Result type.

## Design Decisions and Rationale

### Why `try` is opt-in (not automatic wrapping)

We considered automatically wrapping all imported TypeScript function calls in try-catch. This was rejected because:

1. It would make every imported function call return `Result`, forcing users to unwrap on every call — even for functions that never throw. This makes the language feel fundamentally different from JavaScript.
2. It removes the user's choice. Some users may prefer to let exceptions propagate to the top-level safety net rather than handling them explicitly.
3. It adds overhead to every imported call, even when unnecessary.

### Why `try` wraps in Result (not a separate error type)

`try` produces the same `Result` type as `success()`/`failure()`. This means `try` expressions compose with `|>` pipes, `isSuccess`/`isFailure` guards, and `retry` — all the existing Result infrastructure. A separate error type would require duplicate handling code.

### Why not reuse `handle` blocks for exceptions

We considered routing exceptions through Agency's existing `handle` blocks (which are used for interrupts). This was rejected because interrupts and exceptions are semantically different:

- **Interrupts are intentional pauses** that expect resumption. The handler can approve, reject, modify, or resolve, and execution continues.
- **Exceptions are accidental failures.** There is no meaningful "approve" response to a TypeError. The only useful actions are to log the error, provide a fallback, or retry.

Unifying them under `handle` would conflate two different concerns and make handle blocks harder to reason about.

### Why `catch` always unwraps (returns a plain value)

We considered two alternatives:

1. **`catch` returns a `Result`** — wrapping the fallback in `success()`. This is clean but trivially implementable by the user (`if isSuccess(val) { return val } return success(defaultVal)`), so it doesn't justify a keyword.
2. **`catch` returns a plain value on the fallback branch but a `Result` on the success branch.** This means the variable's type depends on which branch was taken at runtime, which is confusing and breaks type safety.

The chosen design — always unwrap, always return a plain value — is the most useful. It covers the common case of "I want a value right now with a fallback" and eliminates five lines of `isSuccess`/`isFailure` boilerplate. When chained with another `try` on the right side, the intermediate `catch` evaluates to a `Result` (because `try` produces one), enabling the chain to continue.

### Why not a `?` operator

We considered Rust's `?` operator (unwrap or early-return the error). This was deferred because:

1. `try` + `catch` + `isSuccess`/`isFailure` already cover the main use cases.
2. `?` requires the enclosing function to return `Result`, adding an implicit contract that is less obvious than explicit `if isFailure` checks.
3. It can be added later without breaking existing code if verbosity proves to be a problem.

## Future Work

- **`?` operator:** A potential addition for early return on failure (Rust-style). Deferred until we see whether verbosity is a real pain point.
- **Typechecker warnings for unhandled exceptions:** When the typechecker is more mature, it could warn when an imported function is called without `try` and outside a `handle` block. This would help users identify potential crash points.
