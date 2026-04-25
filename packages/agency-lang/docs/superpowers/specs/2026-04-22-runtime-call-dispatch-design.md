# Runtime Call Dispatch Design

## Overview

Replace the builder's compile-time classification of function calls (Agency vs TypeScript) with a runtime dispatch system. Instead of the builder deciding at compile time whether to emit `.invoke()` or a direct call, all non-excluded function calls go through runtime helpers that check the target at call time and dispatch accordingly.

This eliminates the `isAgencyFunction` / `isPlainTsImport` classification system, which is inherently incomplete (can't account for JS globals, namespace imports, dynamically accessed functions, etc.) and is the source of a class of bugs where the builder guesses wrong.

## Problem

`AgencyFunction` instances are objects, not callable functions. They must be called via `.invoke(descriptor, state)`. Plain TS/JS functions are called directly: `fn(args)`. The builder currently decides which calling convention to emit at compile time, but this breaks down when:

- Functions are stored in variables and passed around
- Functions are accessed from data structures (`fns[0]()`, `handlers.onSuccess()`)
- JS globals like `JSON.stringify` aren't in any exclusion list
- Namespace imports (`import * as utils`) make it hard to track individual function types

Since Agency functions are first-class values, any function could end up in any variable or data structure. Compile-time classification cannot handle this reliably.

## Solution

Two runtime helper functions that check the target and dispatch:

### `__call(target, descriptor, state)` — direct function calls

Used when the callee is a variable or identifier, not a property access.

```ts
async function __call(
  target: unknown,
  descriptor: CallType,
  state?: unknown,
): Promise<unknown> {
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (typeof target !== "function") {
    throw new Error(`Cannot call non-function value: ${String(target)}`);
  }
  if (descriptor.type === "named") {
    throw new Error(`Named arguments are not supported for non-Agency function '${target.name || "(anonymous)"}'`);
  }
  return target(...descriptor.args);
}
```

### `__callMethod(obj, prop, descriptor, state, optional?)` — property/index access calls

Used for method calls (`obj.method()`), index access calls (`arr[0]()`), and computed property calls (`obj[key]()`). Preserves `this` binding for TS methods.

```ts
async function __callMethod(
  obj: unknown,
  prop: string | number,
  descriptor: CallType,
  state?: unknown,
  optional?: boolean,
): Promise<unknown> {
  if (optional && (obj === null || obj === undefined)) {
    return undefined;
  }
  const target = (obj as any)[prop];
  if (AgencyFunction.isAgencyFunction(target)) {
    return target.invoke(descriptor, state);
  }
  if (descriptor.type === "named") {
    throw new Error(`Named arguments are not supported for non-Agency function '${prop}'`);
  }
  return (obj as any)[prop](...descriptor.args);
}
```

The `optional` parameter supports optional chaining (`obj?.method()`). When `optional` is true and `obj` is nullish, `__callMethod` short-circuits to `undefined` instead of throwing a TypeError.

### Why two helpers

JavaScript binds `this` based on call syntax: `obj.method()` sets `this` to `obj`, but `const fn = obj.method; fn()` loses it. TS methods on built-in classes (Set, Map, Date) depend on `this`. `__callMethod` preserves `this` by calling `obj[prop](...)` directly rather than extracting the function first.

### Why not Proxy

Wrapping `AgencyFunction` in a `Proxy` with an `apply` trap would make it callable with `()` syntax, but doesn't actually solve the problem — the generated code still needs to know whether to pass a descriptor or raw args. Additionally, Proxies have ~3-5x function call overhead in V8, which every Agency function call would pay.

### Performance

The `.__agencyFunction === true` check is ~1 nanosecond. The descriptor object allocation (`{ type: "positional", args: [...] }`) is the only meaningful overhead, and it already happens for Agency function calls today. For TS function calls routed through `__call`, we add a small object + array allocation per call — negligible in a system where the bottleneck is LLM API calls taking hundreds of milliseconds.

## Where these live

New file: `lib/runtime/call.ts`, exported from `lib/runtime/index.ts`. The generated imports template adds `__call` and `__callMethod` to the standard import list.

## Builder Changes

### What gets removed

- `isAgencyFunction()` method — no longer needed
- `isPlainTsImport()` method and the `_plainTsImportNames` cache
- `TEMPLATE_FUNCTIONS` set — repurposed. Its role changes from "is this an Agency function?" to "does this bypass `__call`?" Consider renaming to `DIRECT_CALL_FUNCTIONS` or similar for clarity.
- The `emitAgencyFunctionCall` / `emitDirectFunctionCall` split — replaced by a single code path that always builds a descriptor and emits `__call` or `__callMethod`

### What the generated code looks like

```ts
// Before (Agency function):
await greet.invoke({ type: "positional", args: ["Bob"] }, { ctx: __ctx, threads: __threads, ... })

// Before (TS function):
await JSON.stringify(foo)

// After (both go through runtime dispatch):
await __call(greet, { type: "positional", args: ["Bob"] }, { ctx: __ctx, ... })
await __callMethod(JSON, "stringify", { type: "positional", args: [foo] }, { ctx: __ctx, ... })
```

### How the builder chooses `__call` vs `__callMethod`

Based on the AST node context, which the builder already tracks. If the call is part of a value access chain (property access, index access), emit `__callMethod` with the object and property separated out. Otherwise, emit `__call`.

For deep chains like `a.b.c()`, the builder separates into object (`a.b`) and property (`"c"`):
```ts
await __callMethod(a.b, "c", descriptor, state)
```

### What bypasses `__call` entirely

These are intercepted by the builder before reaching the dispatch logic:

**Builder macros (special code generation):**
- `llm()` — generates the full prompt/structured-output pipeline
- `fork()` / `race()` — generates parallel execution with isolated state
- `interrupt()` — generates interrupt return + serialization
- `system()` — pushes a system message onto the active thread
- `throw()` — emits `throw new Error(...)`
- `failure()` — special handling in function scope (checkpoint attachment). Still emitted as a direct call (listed under template functions below), but with extra arguments injected by the builder.
- `range()` — special-cased inside `for` loops for numeric iteration
- `schema` — handled as a `schemaExpression` AST node
- `debugger` — handled as a `debuggerStatement` AST node

**Template functions (emitted as direct plain calls):**
- Handler keywords: `approve`, `reject`, `propagate`
- Result constructors: `success`, `failure` (note: `failure` also has special builder handling in function scope for checkpoint attachment, but is still emitted as a direct call)
- Type predicates: `isInterrupt`, `isDebugger`, `isRejected`, `isApproved`, `isSuccess`, `isFailure`
- MCP: `mcp`

Note: `checkpoint`, `getCheckpoint`, and `restore` are NOT template functions — they are wrapped as `AgencyFunction` instances in the imports template and go through `__call` like other Agency functions.

**Internal helpers:** anything `__`-prefixed (`__deepClone`, `__validateType`, etc.)

**Agency stdlib functions go through `__call`:** All functions defined in `.agency` files — whether in the current module, imported from other `.agency` files, or from the stdlib — are `AgencyFunction` instances and go through `__call`. This includes stdlib functions like `print`, `read`, `write`, `input`, `sleep`, `fetch`, etc. The general rule is: if it's defined with `def` in an `.agency` file, it goes through `__call`.

## Edge Cases

### Blocks

Blocks are already wrapped in `AgencyFunction` instances via `ts.agencyFunctionWrap()` in `processBlockArgument`. They are included in the descriptor's `args` array. When the receiving function calls the block through `__call`, the runtime check sees an `AgencyFunction` and calls `.invoke()`, correctly passing `__state`. No special handling needed.

### Lambdas (future)

Lambdas don't exist yet. When added, they should follow the same pattern as blocks — wrapped in `AgencyFunction` — so they work correctly with `__call` and receive `__state`.

### Named args to TS functions

Both `__call` and `__callMethod` throw an error if a named-arg descriptor is passed and the target is not an `AgencyFunction`. Named args are an Agency-only feature and silently dropping them could mask bugs.

### Pipe operator

Currently has separate Agency/TS code paths. With this change, the pipe lambda always uses `__call`:

```ts
// value |> fn  becomes:
async (__pipeArg) => __call(fn, { type: "positional", args: [__pipeArg] }, __state)
```

### Async calls

Fork-branch setup (stack forking for isolated state) still happens at the call site before `__call` is invoked. `__call` is always awaited for synchronous calls; for async calls the promise is registered in the pending store as before.

### `this` binding in deep chains

For `a.b.c()`, the builder separates into object `a.b` and property `"c"`. `__callMethod(a.b, "c", descriptor, state)` preserves `this` because it calls `(a.b)["c"](...)`. Note that `a.b` is evaluated eagerly (once), which is consistent with normal JS semantics for `a.b.c()`.

### Chained function calls

For chains like `a().b().c()`, each call result becomes the `obj` for the next `__callMethod`. The calls nest naturally:

```ts
// a().b().c() becomes:
await __callMethod(
  await __callMethod(
    await __call(a, { type: "positional", args: [] }, __state),
    "b", { type: "positional", args: [] }, __state
  ),
  "c", { type: "positional", args: [] }, __state
)
```

The builder already processes value access chains element by element, accumulating a result. At each `methodCall` element, it wraps the accumulated result as the `obj` argument to `__callMethod`. Non-call chain elements (property access, index access, slicing) stay as regular JS expressions. Only the call portions get wrapped.

Mixed chains work the same way. For `a().b.c()`:

```ts
await __callMethod(
  (await __call(a, { type: "positional", args: [] }, __state)).b,
  "c", { type: "positional", args: [] }, __state
)
```

The `await` at each level ensures the result resolves before the next call uses it.

### Optional chaining

`obj?.method()` is handled by passing `optional: true` to `__callMethod`. When `obj` is nullish, the helper short-circuits to `undefined` instead of throwing. The builder already tracks optional chaining on value access chain elements, so it can pass this flag through.

### Agency class methods

The builder currently has an `isKnownClassMethod()` check that injects `__state` into method calls on Agency class instances. Since all class tests are currently skipped (per the fabb0187 commit), this path is dormant. For now, `__callMethod` does not handle Agency class methods specially — they would fail the `isAgencyFunction` check and be called as plain TS methods, which would break if they expect `__state`. Reconciling class methods with `__callMethod` is deferred to when/if class support is restored.

### Await semantics

Both `__call` and `__callMethod` are `async` and return `Promise<unknown>`. The builder must await them at most call sites. Currently, value access chain calls are not awaited (`shouldAwait` is false when `context === "valueAccess"`). With the new helpers, the builder continues to decide whether to await based on the same context logic — if a call is inside a value access chain that continues (e.g., `foo().bar`), it is awaited inline as part of the expression. The helpers being async does not change this; an un-awaited `__callMethod` simply produces a promise that the next step in the chain awaits.

### Pipe operator with value access stages

The pipe operator can have a `valueAccess` stage type (e.g., `value |> obj.method`). These use `__callMethod` rather than `__call`:

```ts
// value |> obj.method  becomes:
async (__pipeArg) => __callMethod(obj, "method", { type: "positional", args: [__pipeArg] }, __state)
```

## What Doesn't Change

- **`AgencyFunction` class** — unchanged. Still has `.invoke(descriptor, state)`, still has `__agencyFunction` flag, still serializes via `FunctionRefReviver`.
- **Serialization** — `FunctionRefReviver` continues to handle serialize/deserialize of function references.
- **Step runner** — functions still have their own Runner and step tracking regardless of how they're invoked.
- **Thread context** — functions receive `__ctx` and `__threads` through the state parameter, same as before.
- **Interrupts and handlers** — interrupt machinery is inside the function, not at the call site. Handlers wrap call sites and work the same way.

## Testing Strategy

### Unit tests (lib/runtime/call.test.ts)

- `__call` with an `AgencyFunction` target — invokes `.invoke()` with descriptor and state
- `__call` with a plain TS function — spreads positional args
- `__call` with named args to a TS function — throws error with function name
- `__call` with a non-function value (e.g., `42`) — throws a clear error
- `__callMethod` with an `AgencyFunction` stored as object property — invokes `.invoke()`
- `__callMethod` with a TS method — calls with `this` preserved
- `__callMethod` with array index access to an `AgencyFunction`
- `__callMethod` with `optional: true` and nullish `obj` — returns `undefined`
- `__callMethod` with `optional: true` and non-nullish `obj` — calls normally

### Integration test fixtures (tests/typescriptGenerator/)

- Verify generated code emits `__call` / `__callMethod` instead of `.invoke()` or direct calls

### Agency execution tests (tests/agency/)

- Call an Agency function stored in an array: `fns[0]("Bob")`
- Call an Agency function stored in an object: `handlers.onSuccess("ok")`
- Call a TS method on a built-in: `mySet.add(5)` (verify `this` works)
- Pass `print` as an argument to another function, call it dynamically
- Mix of Agency and TS calls in the same node
- Optional chaining: `obj?.method()` where `obj` might be null
- Deep chain with mixed property/index access: `a[0].b.c()`
- Pipe operator through `__call`
- Blocks passed through `__call` to Agency functions
- Async (forked) calls going through `__call`
