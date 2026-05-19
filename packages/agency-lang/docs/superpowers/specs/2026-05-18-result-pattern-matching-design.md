# Result Pattern Matching

## Summary

Add `success` and `failure` as pattern keywords in `is` and `match` positions, providing ergonomic unwrapping of Result types without manual `isSuccess`/`isFailure` + field access.

## Current State

Unwrapping Results today is verbose:

```agency
let result = tryParse("ok")
if (isSuccess(result)) {
  let value = result.value
  print(value)
}
if (isFailure(result)) {
  print(result.error)
}
```

## New Syntax

### `is` operator

Boolean test (no binding):

```agency
let worked = result is success
let failed = result is failure
```

With binding (in `if`/`while` conditions):

```agency
if (result is success(value)) {
  print(value)
}

if (result is failure(err)) {
  print(err)
}
```

Using `success(v)` or `failure(e)` in a pure-boolean context (assignment, return, function argument) is a compile error, consistent with how shorthand binders in `is` patterns already work. There is no scope for the binder to live in.

### `match` arms

```agency
match (result) {
  success(v) => print("Got: ${v}")
  failure(e) => print("Error: ${e}")
}
```

### Combined with `match(expr is pattern)` form

When you need to dispatch on the unwrapped value:

```agency
match (result is success(v)) {
  v > 0 => print("positive: ${v}")
  _     => print("zero or not a success")
}
```

Note: as with all `match(expr is pattern)` forms, if the head pattern does not match (i.e. the result is not a success), the function returns a `failure` Result. This is existing behavior for `match ... is` and is not specific to result patterns.

## Semantics

- `success` and `failure` lower to calls to the runtime `isSuccess()` / `isFailure()` functions (defined in `lib/runtime/result.ts`). The lowering always emits function calls, never inline checks.
- `success(v)` binds `result.value` to `v`
- `failure(e)` binds `result.error` to `e`
- In pattern position, `success()` and `failure()` with no argument are a parse error. In expression position they remain valid calls (e.g. `return success(42)`) — the parse error applies only to the new pattern forms.
- `success` and `failure` are already reserved function names in the typechecker, so there is no ambiguity between the new pattern keyword usage and variable identifiers
- No exhaustiveness check is performed on result pattern arms in `match` blocks, consistent with existing match semantics. A `match` with only `success(v) =>` and no `failure` arm silently does nothing when the result is a failure.

## Positions

- `is` operator: yes
- `match` arms: yes
- `let`/`const` declarations: no
- `for` loops: no

## Lowering

The preprocessor desugars result patterns into existing constructs. Bindings use `const` (consistent with existing pattern lowering).

### `is` with binding (inside `if`/`while`)

```agency
if (result is success(value)) {
  print(value)
}
```

lowers to:

```agency
if (isSuccess(result)) {
  const value = result.value
  print(value)
}
```

For `while` loops, the binding is prepended to the loop body and re-bound on each iteration (consistent with existing `while(expr is pattern)` behavior).

### `is` without binding (boolean test)

```agency
let worked = result is success
```

lowers to:

```agency
let worked = isSuccess(result)
```

### `match` arms

```agency
match (result) {
  success(v) => print("Got: ${v}")
  failure(e) => print("Error: ${e}")
}
```

lowers to:

```agency
const __scrutinee_0 = result
if (isSuccess(__scrutinee_0)) {
  const v = __scrutinee_0.value
  print("Got: ${v}")
} else if (isFailure(__scrutinee_0)) {
  const e = __scrutinee_0.error
  print("Error: ${e}")
}
```

The scrutinee is assigned to a temp variable so it is evaluated exactly once (following existing `match` lowering).

### `match(expr is pattern)` with result pattern

```agency
match (result is success(v)) {
  v > 0 => print("positive")
  _     => print("not positive")
}
```

lowers to:

```agency
const __scrutinee_0 = result
if (isSuccess(__scrutinee_0)) {
  const v = __scrutinee_0.value
  if (v > 0) {
    print("positive")
  } else {
    print("not positive")
  }
} else {
  return failure("match(... is pattern) head pattern did not match")
}
```

The scrutinee temp variable and `else` branch returning a failure on head-pattern mismatch are consistent with existing `match(expr is pattern)` behavior (see `matchIsFailure` test fixture).

## Interaction with pipe operator

The pipe operator (`|>`) always returns a `ResultValue` — either the return value of the last function wrapped in `success`, or a short-circuited `failure`. So the resulting variable is a valid target for result patterns:

```agency
const r = foo() |> bar
if (r is success(v)) {
  print(v)
}
```

No special handling is needed.

## AST representation and preprocessor extensions

### New AST node

Add a `ResultPattern` node type to the pattern AST:

```
ResultPattern {
  kind: "success" | "failure"
  binding: string | null   // null for bare form (no parens), identifier name for binding form
}
```

This node appears wherever `MatchPattern` is accepted (in `is` expressions and `match` arms).

### Parser changes

In pattern-position parsing, when the parser encounters the identifier `success` or `failure`:
- If followed by `(identifier)`: parse as `ResultPattern` with `binding` set to the identifier
- If followed by `()`: parse error (empty parens not allowed)
- Otherwise: parse as `ResultPattern` with `binding: null` (bare boolean form)

This is unambiguous because `success` and `failure` are reserved names and cannot appear as variable pattern binders.

### Lowering extension points

**`patternToCondition`**: Add a case for `ResultPattern` that emits a call expression:
- `kind: "success"` emits `isSuccess(source)`
- `kind: "failure"` emits `isFailure(source)`

**`extractBindings`**: Add a case for `ResultPattern` that, when `binding` is non-null, emits:
- `kind: "success"` emits `const <binding> = <source>.value`
- `kind: "failure"` emits `const <binding> = <source>.error`

**`assertNoBindersInBoolIs`**: Extend to reject `ResultPattern` nodes with a non-null `binding` in pure-boolean `is` contexts.

## What this does NOT include

- No guard clauses on result pattern arms (use `match(expr is success(v))` form instead)
- No destructuring in `let`/`const` or `for` positions
- No nested patterns inside result patterns (e.g. `success({ name, age })` is not supported -- use `success(v)` and destructure `v` separately)
- No empty-paren forms
- `failure(e)` exposes only the error string, not checkpoint/args/retryable. The error string is the most commonly needed field. For the rarer cases where checkpoint, functionName, or args are needed (e.g. the restore/retry workflow), users should use the traditional `if (isFailure(result))` form and access fields directly on the result variable. This keeps the common case simple without trying to expose the full failure structure in the pattern syntax.
