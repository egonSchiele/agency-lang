# Lambda Implementation Sketch

## Overview

Lambdas are anonymous functions that can be stored in variables, passed as arguments, and called later. They are closely related to blocks (which are already implemented) but differ in that they are standalone values rather than always being the last argument to a function call.

## Proposed Syntax

```
// Expression body
const double = (x: number): number => x * 2

// Block body
const transform = (x: number): number => {
  const result = x * 2
  return result + 1
}

// No type annotations
const add = (a, b) => a + b

// Used inline
const items = [1, 2, 3]
const doubled = items |> map(?, (x) => x * 2)
```

## Compilation

Very similar to the existing block wrapping with `TsAgencyFunctionWrap`. A lambda compiles to an arrow function wrapped in `AgencyFunction.create()`:

```typescript
// Agency:
const double = (x: number): number => x * 2

// Compiled TypeScript:
const double = __AgencyFunction.create({
  name: "__lambda_0",
  module: "myModule.agency",
  fn: async (x, __state) => { return x * 2; },
  params: [{ name: "x", hasDefault: false, defaultValue: undefined, variadic: false }],
  toolDefinition: null,
}, __toolRegistry);
```

The `TsAgencyFunctionWrap` IR node and mustache template already exist for blocks and can be reused directly.

## Complications and Proposed Solutions

### 1. Variable Capture (Closures) — Main Challenge

```
node main() {
  const multiplier = 3
  const fn = (x) => x * multiplier
  fn(5)  // should return 15
}
```

The lambda needs to close over `multiplier`, which lives in `__stack.locals.multiplier`. This is the core challenge because:

- Blocks sidestep this: they execute immediately in the same scope, so they can reference `__stack` directly.
- Lambdas are values that can be stored, passed around, and called later — potentially in a different scope context.

**Proposed solution (first pass):** Compile lambda bodies so they directly reference the enclosing scope's `__stack`. The arrow function in JavaScript naturally closes over variables in its lexical scope, so `__stack.locals.multiplier` will resolve correctly as long as the lambda is called while the enclosing scope is still alive.

This covers the common cases: lambdas passed to `map`, `filter`, `sort`, pipe stages, `fork` blocks, and any function that calls the lambda synchronously or within the same execution.

**Limitation:** If a lambda is returned from a function and called after the function returns, the `__stack` reference is stale (the stack frame was popped). This is an uncommon pattern in Agency code and can be documented as unsupported initially.

### 2. Serialization Through Interrupts

If a lambda is stored in a variable and an interrupt occurs, it needs to survive serialization. The `FunctionRefReviver` handles this for `AgencyFunction` instances — it serializes the `name` and `module`, then looks them up in `__toolRegistry` on deserialization.

For lambdas registered via `AgencyFunction.create()`, this works: the reviver finds `__lambda_0` in the registry and returns the AgencyFunction instance.

**Limitation:** The lambda's closure state (captured variables) is NOT serialized. After deserialization, the lambda exists but any captured variables point to the re-initialized scope, not the original values. This is the same limitation blocks have, but lambdas are more likely to hold meaningful captured state.

**Proposed solution (first pass):** Document this limitation. Most lambdas used with interrupts are pure functions (no captures) or capture immutable data that gets re-initialized to the same values. For the cases where this matters, users should store captured values in state explicitly.

**Future improvement:** Implement closure capture snapshots — at lambda creation time, snapshot the referenced outer variables into the AgencyFunction's metadata. The reviver would restore these on deserialization. This is a significant feature and should be designed separately.

### 3. Scoping in the Preprocessor

The preprocessor resolves variable scopes (local, global, shared, imported, functionRef). A lambda defined inside a node creates a nested scope.

**Proposed solution:** Treat lambda scope like block scope in the preprocessor. The `lookupScope` function already walks up the scope chain for blocks. Lambdas would work the same way:

- Variables declared inside the lambda body → `local` scope (relative to the lambda's own `__stack`)
- Variables referenced from the enclosing scope → resolved by `lookupScope` walking up to the enclosing function/node scope

The preprocessor already handles this nesting for blocks, so lambda support is straightforward.

### 4. `__state` Threading

When a lambda is called via `.invoke()`, state is passed as the second argument to `invoke()`, which appends it to the underlying function call. If the lambda body calls other Agency functions, it needs to forward state.

**Proposed solution:** The lambda's compiled body should follow the same pattern as function bodies — it receives `__state` as the last parameter and passes it through when calling other Agency functions via `.invoke()`. Since `.invoke()` already handles state threading, this should work without special treatment.

**Note:** Unlike full function definitions, lambdas probably should NOT have the full function setup machinery (setupFunction, state stack push/pop, hooks, runner). They should be lightweight. The state parameter should be passed through for forwarding but not used to set up a new execution frame.

### 5. Runner Step Tracking

Blocks have runner step tracking (checkpoints, debugger hooks) because they execute as part of a function's step sequence. Should lambdas?

**Proposed solution:** No step tracking for lambdas, at least initially. Lambdas are lightweight — they shouldn't participate in the checkpoint/debug machinery. If a lambda calls a full Agency function, that function has its own step tracking. This keeps lambdas fast and simple.

If multi-statement lambdas need step tracking in the future, it can be added as an opt-in feature.

### 6. Lambda vs Block Distinction in the Parser

The parser needs to distinguish lambda syntax from other constructs. The `=>` arrow is unambiguous in most contexts, but there are edge cases:

- `(x) => x * 2` vs a parenthesized expression followed by `=>`
- Single-param shorthand: `x => x * 2` (if supported)

**Proposed solution:** Start with the full parenthesized syntax only: `(params) => body`. This is unambiguous. Single-param shorthand can be added later.

## Implementation Order

1. **Parser:** Add lambda AST node type, parse `(params) => expr` and `(params) => { body }`
2. **Preprocessor:** Add lambda scope handling (similar to block scope)
3. **Builder:** Compile lambda to arrow function + `AgencyFunction.create()` wrapper (reuse `TsAgencyFunctionWrap`)
4. **Tests:** Lambda basics, closure capture, lambda as argument, lambda in pipe, lambda through interrupt

## Relationship to Existing Block Implementation

Blocks are very close to lambdas:

| Feature | Block | Lambda |
|---------|-------|--------|
| Syntax | `fn(args) as params { body }` | `(params) => body` |
| Is a value | No (always inline arg) | Yes (assignable) |
| Wrapped as AgencyFunction | Yes (via `TsAgencyFunctionWrap`) | Yes (same mechanism) |
| Runner step tracking | Yes | No |
| Closure capture | Same-scope only | Same-scope only (initially) |
| Survives interrupt | Yes (registered in `__toolRegistry`) | Yes (same mechanism) |

The implementation can share most of the block compilation infrastructure.
