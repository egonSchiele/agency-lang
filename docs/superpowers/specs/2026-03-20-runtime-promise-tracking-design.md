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

### New class: `PendingPromiseStore` (`lib/runtime/state/pendingPromiseStore.ts`)

A dedicated class for tracking async promises, following the same pattern as `GlobalStore` and `StateStack`:

```ts
type PendingPromiseEntry = {
  promise: Promise<any>;
  resolve?: (value: any) => void; // setter for assigned vars
};

export class PendingPromiseStore {
  private pending: Record<string, PendingPromiseEntry> = {};
  private counter: number = 0;

  /**
   * Register an async promise for tracking.
   * @param key - variable name for assigned calls, or null for unassigned
   * @param promise - the promise to track
   * @param resolve - optional setter to write the resolved value back
   */
  add(key: string | null, promise: Promise<any>, resolve?: (value: any) => void): void {
    const actualKey = key ?? `__unassigned_${this.counter++}`;
    this.pending[actualKey] = { promise, resolve };
  }

  /**
   * Await specific pending promises by key. Used where the preprocessor
   * currently inserts Promise.all — before first usage of an async variable.
   * Resolves the promises and calls their setters to write values back.
   * Removes awaited promises from the store.
   *
   * If a requested key is not in the store (e.g., the async assignment
   * was inside a conditional branch that didn't execute), it is silently
   * skipped. This is safe because the variable was never assigned a Promise
   * in the first place — it retains whatever value it had before.
   */
  async awaitPending(keys: string[]): Promise<void> {
    const entries = keys
      .map(k => ({ key: k, entry: this.pending[k] }))
      .filter(e => e.entry !== undefined);

    if (entries.length === 0) return;

    const results = await Promise.all(entries.map(e => e.entry!.promise));

    for (let i = 0; i < entries.length; i++) {
      const { key, entry } = entries[i];
      if (entry!.resolve) {
        entry!.resolve(results[i]);
      }
      delete this.pending[key];
    }
  }

  /**
   * Await ALL pending promises (assigned and unassigned).
   * Used at node exit and before returning an interrupt.
   * Any pending promise that returns an interrupt object triggers
   * a ConcurrentInterruptError (phase 1 behavior).
   */
  async awaitAll(): Promise<void> {
    const keys = Object.keys(this.pending);
    if (keys.length === 0) return;

    const entries = keys.map(k => ({ key: k, entry: this.pending[k] }));
    this.pending = {};

    const results = await Promise.all(entries.map(e => e.entry.promise));

    for (let i = 0; i < entries.length; i++) {
      const { entry } = entries[i];
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

  /** Clear all pending promises without awaiting them. Used during error cleanup. */
  clear(): void {
    this.pending = {};
  }
}
```

### RuntimeContext changes

Add a single new field to `RuntimeContext` (`lib/runtime/state/context.ts`):

```ts
pendingPromises: PendingPromiseStore;
```

Initialize in the constructor:
```ts
this.pendingPromises = new PendingPromiseStore();
```

Initialize in `createExecutionContext()`:
```ts
execCtx.pendingPromises = new PendingPromiseStore();
```

In `cleanup()`, clear pending promises before nullifying other state to prevent dangling promises from referencing a nullified context:
```ts
cleanup(): void {
  this.pendingPromises.clear();  // clear first, before nullifying deps
  this.stateStack = null as any;
  this.globals = null as any;
  this.statelogClient = null as any;
  this.callbacks = null as any;
}
```

The `PendingPromiseStore` is NOT serialized — pending promises cannot be serialized. By the time state is serialized (at interrupt time), `awaitAll()` will have already resolved everything.

### Builder changes (`lib/backends/typescriptBuilder.ts`)

#### Assigned async calls

Currently for `x = async func(...)`, `generateFunctionCallExpression` returns the call without `await` (line 1151: `shouldAwait = !node.async`). The call result is stored directly in the variable.

**New behavior:** After generating the unawaited call, also generate an `addPending` call:

```js
// For: x = async func(...)
// Generated:
__self.x = func(..., { ctx: __ctx, ... });
__ctx.pendingPromises.add("x", __self.x, (val) => { __self.x = val; });
```

This happens in the assignment processing path in `processNode` (or wherever assignments with async function call values are handled in the builder).

The existing `isInterrupt` check that follows assigned function calls (in `processAssignment`) must be skipped when `node.value.async` is true, since the variable holds a Promise, not a resolved value. This mirrors how `processLlmCall` already skips the interrupt check for async calls (line 1640-1642). The interrupt check for these calls will happen later via `awaitAll`.

#### Unassigned async calls

Currently for `async func(...)` as a statement, `processFunctionCallAsStatement` calls `processFunctionCall` which generates an unawaited call. The result is assigned to `__funcResult` for interrupt checking, but with `async` the call isn't awaited so this is broken.

**New behavior:** For unassigned async calls to Agency functions, skip the interrupt check (the promise hasn't resolved yet) and register with the runtime:

```js
// For: async func(...)
// Generated:
__ctx.pendingPromises.add(null, func(..., { ctx: __ctx, ... }));
```

The `isInterrupt` check is removed for async unassigned calls — it will be handled by `awaitAllPending` later.

#### Node exit

At the end of each node body (before the return statement), the builder inserts:

```js
await __ctx.pendingPromises.awaitAll();
```

This ensures all fire-and-forget async calls complete before the node returns to the graph engine.

#### Before interrupt return

Wherever the builder generates interrupt return code (the `isInterrupt` check + return pattern), insert `awaitAll` before the return. The specific locations are:

- `processFunctionCallAsStatement` — unassigned sync function call interrupt check
- `processAssignment` — assigned sync function call interrupt check
- `processLlmCall` — sync LLM call interrupt check

In each case:

```js
if (isInterrupt(__result)) {
  await __ctx.pendingPromises.awaitAll();
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
await __ctx.pendingPromises.awaitPending(["x", "y"]);
```

The `awaitPending` method handles resolving the promises AND writing values back via the setter registered by `addPending`. This is simpler because the preprocessor no longer needs to know about `__self` prefixes or array destructuring.

Steps 1 and 2 remain the same — the preprocessor still determines *when* to await based on first-usage analysis.

#### Parallel blocks

The parallel block `Promise.all` insertion (lines 836-854) also changes to use `awaitPending`:

```js
// Old:
[__self.x, __self.y] = await Promise.all([__self.x, __self.y]);

// New:
await __ctx.pendingPromises.awaitPending(["x", "y"]);
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
- **`respondToInterrupt` / `approveInterrupt` / etc.** — unchanged for phase 1. When a resumed execution spawns new async calls and hits another interrupt, the `awaitAll` calls in the generated node code handle it — `respondToInterrupt` itself does not need changes.

## Test cases

1. **Unassigned async calls complete before node returns** — the original bug (`foo.agency`). Both `async append(...)` calls should run concurrently and complete before `return arr`.

2. **Assigned async vars resolve before usage** — existing behavior preserved. `x = async func()` followed by `print(x)` should await `x` before the print, via the new `awaitPending` mechanism.

3. **Assigned async vars resolve before interrupt** — `x = async func()` fires off, then a sync call triggers an interrupt. `awaitAllPending` resolves `x` and writes the value back before state is serialized.

4. **Concurrent interrupt error** — `async riskyFunc()` (unassigned) where `riskyFunc` triggers an interrupt. Meanwhile, the main path also triggers an interrupt. `awaitAllPending` detects the interrupt from the pending promise and throws `ConcurrentInterruptError`.

5. **Mixed assigned and unassigned** — a node with both `x = async func()` and `async sideEffect()`. Both should complete before the node exits.

6. **Async calls in functions (not just nodes)** — `def helper() { async sideEffect() }` called from a node. The pending promise is registered on the shared `RuntimeContext`, so `awaitAllPending` at node exit catches it.

7. **No async calls** — `awaitAll` is a no-op when `pendingPromises` is empty. No performance impact on sync-only code.

8. **Async calls inside while loops** — each iteration registers a new pending promise with the same key. The `awaitPending` before usage within the loop body should resolve it each iteration.

9. **Nested function calls with async** — `def helper() { x = async func() }` called from a node. The pending promise is registered on the shared `RuntimeContext` and resolved when `helper` calls `awaitPending` or at node exit via `awaitAll`.

10. **Async assignment in conditional branch** — `if (cond) { x = async func() }` followed by usage of `x`. If the branch didn't execute, `awaitPending(["x"])` silently skips the missing key.

## Future work (not in this phase)

- **Phase 2: Interrupt queues** — when `awaitAllPending` discovers an interrupt from a pending promise, queue it instead of throwing. Return interrupts one at a time to the caller.
- **Phase 3: Handler syntax** — `try { ... } handle (interrupt) { ... }` for in-language interrupt handling.
