# Runtime Promise Tracking for Async Calls

**Date:** 2026-03-20
**Status:** Draft

## Problem

Async function calls in Agency that are not assigned to a variable crash at runtime. For example:

```agency
node main() {
  async append(1, "hello")
  async append(0.5, "world")
  return arr
}
```

The generated TypeScript calls `append(...)` without `await` (because `async` is set), but nobody ever awaits the resulting promise. When the node exits, `RuntimeContext.cleanup()` nullifies `stateStack`, and the still-running promise crashes with `Cannot read properties of null (reading 'pop')`.

There is also a related bug with assigned async vars and interrupts: if `x = async func()` fires off a promise, and an interrupt is triggered before the preprocessor's `Promise.all` resolves `x`, the state is serialized with `x` still holding an unresolved Promise — which cannot be serialized to JSON.

## Design

### Core idea

Replace the preprocessor's inline `Promise.all` code generation with a centralized runtime mechanism on `RuntimeContext`. All async promises (assigned and unassigned) are registered with the runtime, and the runtime provides methods to await specific promises or all pending promises.

### RuntimeContext changes

Add to `RuntimeContext` (`lib/runtime/state/context.ts`):

```ts
type PendingPromise = {
  promise: Promise<any>;
  resolve?: (value: any) => void; // setter for assigned vars
};

// New fields on RuntimeContext:
pendingPromises: Map<string, PendingPromise>;  // keyed by var name or auto-generated key
private _pendingCounter: number;               // for generating keys for unassigned calls
```

Three new methods:

```ts
/**
 * Register an async promise for tracking.
 * @param key - variable name for assigned calls, or null for unassigned
 * @param promise - the promise to track
 * @param resolve - optional setter to write the resolved value back
 */
addPending(key: string | null, promise: Promise<any>, resolve?: (value: any) => void): void {
  const actualKey = key ?? `__unassigned_${this._pendingCounter++}`;
  this.pendingPromises.set(actualKey, { promise, resolve });
}

/**
 * Await specific pending promises by key. Used where the preprocessor
 * currently inserts Promise.all — before first usage of an async variable.
 * Resolves the promises and calls their setters to write values back.
 * Removes awaited promises from the pending map.
 */
async awaitPending(keys: string[]): Promise<void> {
  const entries = keys
    .map(k => ({ key: k, entry: this.pendingPromises.get(k) }))
    .filter(e => e.entry !== undefined);

  const results = await Promise.all(entries.map(e => e.entry!.promise));

  for (let i = 0; i < entries.length; i++) {
    const { key, entry } = entries[i];
    if (entry!.resolve) {
      entry!.resolve(results[i]);
    }
    this.pendingPromises.delete(key);
  }
}

/**
 * Await ALL pending promises (assigned and unassigned).
 * Used at node exit and before returning an interrupt.
 * Any pending promise that returns an interrupt object triggers
 * a ConcurrentInterruptError (phase 1 behavior).
 */
async awaitAllPending(): Promise<void> {
  if (this.pendingPromises.size === 0) return;

  const entries = [...this.pendingPromises.entries()];
  this.pendingPromises.clear();

  const results = await Promise.all(entries.map(([_, e]) => e.promise));

  for (let i = 0; i < entries.length; i++) {
    const [_, entry] = entries[i];
    const result = results[i];

    // Phase 1: error if a pending promise returned an interrupt
    if (isInterrupt(result)) {
      throw new ConcurrentInterruptError(
        "An async function returned an interrupt while another interrupt was pending. " +
        "Concurrent interrupts are not yet supported. Assign the async call to a " +
        "variable if it may trigger an interrupt."
      );
    }

    if (entry.resolve) {
      entry.resolve(result);
    }
  }
}
```

These fields must also be initialized in `createExecutionContext()` and handled in `cleanup()`. They are NOT serialized — pending promises cannot be serialized. By the time state is serialized (at interrupt time), `awaitAllPending()` will have already resolved everything.

### Builder changes (`lib/backends/typescriptBuilder.ts`)

#### Assigned async calls

Currently for `x = async func(...)`, `generateFunctionCallExpression` returns the call without `await` (line 1151: `shouldAwait = !node.async`). The call result is stored directly in the variable.

**New behavior:** After generating the unawaited call, also generate an `addPending` call:

```js
// For: x = async func(...)
// Generated:
__self.x = func(..., { ctx: __ctx, ... });
__ctx.addPending("x", __self.x, (val) => { __self.x = val; });
```

This happens in the assignment processing path in `processNode` (or wherever assignments with async function call values are handled in the builder).

#### Unassigned async calls

Currently for `async func(...)` as a statement, `processFunctionCallAsStatement` calls `processFunctionCall` which generates an unawaited call. The result is assigned to `__funcResult` for interrupt checking, but with `async` the call isn't awaited so this is broken.

**New behavior:** For unassigned async calls to Agency functions, skip the interrupt check (the promise hasn't resolved yet) and register with the runtime:

```js
// For: async func(...)
// Generated:
__ctx.addPending(null, func(..., { ctx: __ctx, ... }));
```

The `isInterrupt` check is removed for async unassigned calls — it will be handled by `awaitAllPending` later.

#### Node exit

At the end of each node body (before the return statement), the builder inserts:

```js
await __ctx.awaitAllPending();
```

This ensures all fire-and-forget async calls complete before the node returns to the graph engine.

#### Before interrupt return

Wherever the builder generates interrupt return code (the `isInterrupt` check + return pattern), insert `awaitAllPending` before the return:

```js
if (isInterrupt(__result)) {
  await __ctx.awaitAllPending();
  return { ...__state, data: __result };
}
```

This ensures all pending async work completes and assigned variables have their resolved values before state is serialized.

### Preprocessor changes (`lib/preprocessors/typescriptPreprocessor.ts`)

#### Replace `Promise.all` generation with `awaitPending` calls

The preprocessor currently:
1. Collects async variables from assignments (`_collectAsyncVariablesInScope`)
2. Finds first usage of each variable (`_findFirstUsageInScope`)
3. Inserts `rawCode` nodes with `[__self.x, __self.y] = await Promise.all([__self.x, __self.y])` before usage (`_insertPromiseAllCalls`)

**New behavior:** Step 3 changes. Instead of generating `Promise.all` raw code, generate `awaitPending` calls:

```js
// Old:
[__self.x, __self.y] = await Promise.all([__self.x, __self.y]);

// New:
await __ctx.awaitPending(["x", "y"]);
```

The `awaitPending` method handles resolving the promises AND writing values back via the setter registered by `addPending`. This is simpler because the preprocessor no longer needs to know about `__self` prefixes or array destructuring.

Steps 1 and 2 remain the same — the preprocessor still determines *when* to await based on first-usage analysis.

#### Parallel blocks

The parallel block `Promise.all` insertion (lines 836-854) also changes to use `awaitPending`:

```js
// Old:
[__self.x, __self.y] = await Promise.all([__self.x, __self.y]);

// New:
await __ctx.awaitPending(["x", "y"]);
```

### Error handling

#### `ConcurrentInterruptError`

A new error type in `lib/runtime/errors.ts`:

```ts
export class ConcurrentInterruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentInterruptError";
  }
}
```

This is thrown by `awaitAllPending` when a pending promise returns an interrupt object. This is the phase 1 behavior — a clear error message telling the user to assign the call to a variable if it may interrupt. Phase 2 will replace this with interrupt queue support.

### What does NOT change

- **`setupFunction` / `setupNode`** — no changes. They still push/pop stateStack frames as before.
- **`isInterrupt` checks for sync calls** — unchanged. Synchronous (non-async) function calls still check for interrupts immediately after the `await`.
- **State serialization** — `stateToJSON()` is unchanged. `pendingPromises` is not serialized; by the time serialization happens, all promises have been resolved via `awaitAllPending`.
- **`respondToInterrupt` / `approveInterrupt` / etc.** — unchanged for phase 1.

## Test cases

1. **Unassigned async calls complete before node returns** — the original bug (`foo.agency`). Both `async append(...)` calls should run concurrently and complete before `return arr`.

2. **Assigned async vars resolve before usage** — existing behavior preserved. `x = async func()` followed by `print(x)` should await `x` before the print, via the new `awaitPending` mechanism.

3. **Assigned async vars resolve before interrupt** — `x = async func()` fires off, then a sync call triggers an interrupt. `awaitAllPending` resolves `x` and writes the value back before state is serialized.

4. **Concurrent interrupt error** — `async riskyFunc()` (unassigned) where `riskyFunc` triggers an interrupt. Meanwhile, the main path also triggers an interrupt. `awaitAllPending` detects the interrupt from the pending promise and throws `ConcurrentInterruptError`.

5. **Mixed assigned and unassigned** — a node with both `x = async func()` and `async sideEffect()`. Both should complete before the node exits.

6. **Async calls in functions (not just nodes)** — `def helper() { async sideEffect() }` called from a node. The pending promise is registered on the shared `RuntimeContext`, so `awaitAllPending` at node exit catches it.

7. **No async calls** — `awaitAllPending` is a no-op when `pendingPromises` is empty. No performance impact on sync-only code.

## Future work (not in this phase)

- **Phase 2: Interrupt queues** — when `awaitAllPending` discovers an interrupt from a pending promise, queue it instead of throwing. Return interrupts one at a time to the caller.
- **Phase 3: Handler syntax** — `try { ... } handle (interrupt) { ... }` for in-language interrupt handling.
