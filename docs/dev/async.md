# Async Function Calls

This document explains how async function calls work in Agency, the problems we encountered, and how they are solved. For the implementation spec, see `docs/superpowers/specs/2026-03-20-runtime-promise-tracking-design.md`.

## Background

Agency supports the `async` keyword on function calls to run them concurrently:

```agency
node main() {
  x = async openai(msg)
  y = async google(msg)
  // x and y run in parallel, awaited before first usage
  print(x, y)
}
```

The compiler generates the calls without `await`, stores the Promises in variables, and later inserts `Promise.all` before the variables are used. This is handled by the preprocessor, which analyzes first-usage locations and generates the appropriate await code.

For context on why execution isolation matters here: each call to an Agency node from TypeScript gets its own isolated execution context (its own `StateStack` and `GlobalStore`). Global variables are initialized fresh per call. Shared variables (`shared` keyword) are the exception — they are shared across all calls and never serialized. See the `ScopeType` comment in `lib/types.ts` for the full breakdown.

## Problem 1: Unassigned async calls crash

When you call an async function without assigning the result to a variable:

```agency
node main() {
  async append(1, "hello")
  async append(0.5, "world")
  return arr
}
```

The generated TypeScript calls `append(...)` without `await`, but nobody ever collects or awaits the resulting Promise. The preprocessor only tracks async calls that are assigned to variables (it uses the variable name for `Promise.all` insertion). So the Promises just float away.

Meanwhile, `append` is an Agency function that pushes a frame onto the `StateStack` in `setupFunction` and pops it in a `finally` block. When the node exits, `RuntimeContext.cleanup()` nullifies `stateStack`. The still-running Promises then crash when their `finally` block tries to pop from a null stateStack:

```
TypeError: Cannot read properties of null (reading 'pop')
```

## Problem 2: Async vars + interrupts

Even for assigned async calls, there's a bug when interrupts are involved:

```agency
node main() {
  x = async slowFunc()
  y = getApproval()  // triggers an interrupt
  print(x)
}
```

The interrupt at `getApproval()` serializes the execution state and returns to the TypeScript caller. But `x` still holds an unresolved Promise — it hasn't been awaited yet (the `Promise.all` was going to be inserted before `print(x)`, which we never reached). Promises can't be serialized to JSON, so the state is corrupted.

## Problem 3: Key collisions with variable-name tracking

An earlier design proposed tracking promises in a shared store keyed by variable name (e.g., `"x"` maps to the promise for `x = async func()`). This has two collision problems:

### Loops

```agency
while (condition) {
  x = async func()
}
print(x)
```

Each iteration registers under key `"x"`, overwriting the previous entry. Only the last iteration's promise is tracked. Earlier promises are orphaned — still running, but untracked and never awaited. If the node exits before they complete, they crash on cleanup.

(If `x` is used inside the loop body, the preprocessor places the await inside the loop, so each iteration resolves before the next. The problem only occurs when usage is after the loop.)

### Concurrent function calls

```agency
def helper() {
  x = async func()
  // awaitPending("x") inserted before usage
  print(x)
}

node main() {
  async helper()
  async helper()
}
```

Both helper calls share the same `RuntimeContext` and thus the same promise store. JavaScript async functions interleave at `await` points, so:

1. helper1 runs: registers `("x", promise1, setter1)` → hits internal `await`, yields
2. helper2 runs: registers `("x", promise2, setter2)` → **overwrites promise1!**
3. promise1 resolves, helper1 resumes: `awaitPending("x")` awaits **promise2** (helper2's promise, not helper1's)
4. helper1's `__self.x` is never properly resolved

Each `helper` call has its own `__self` object (from `setupFunction`), so the setters capture different targets. But the shared key means they interfere with each other.

## Solution: Runtime promise tracking with unique keys

Instead of the preprocessor generating inline `Promise.all` code, we centralize all promise tracking in a new `PendingPromiseStore` class on `RuntimeContext`. Promises are tracked with unique counter-based keys to avoid all collision issues.

### How it works

**Registration:** When the builder generates an async call, it registers the promise with the store. The `add` method returns a unique key (e.g., `"__pending_0"`, `"__pending_1"`):

```js
// For: x = async func(...)
__self.x = func(..., { ctx: __ctx, ... });
__self.__pendingKey_x = __ctx.pendingPromises.add(__self.x, (val) => { __self.x = val; });

// For: async func(...) (unassigned)
__ctx.pendingPromises.add(func(..., { ctx: __ctx, ... }));
```

The key is stored in `__self.__pendingKey_x`, which is per-stack-frame. Concurrent calls to the same function each have their own `__self`, so each gets a unique key. Loop iterations also get unique keys from the counter.

**Await before usage:** The preprocessor still determines *when* to await (before first usage), but instead of generating `Promise.all` raw code, it generates:

```js
await __ctx.pendingPromises.awaitPending([__self.__pendingKey_x, __self.__pendingKey_y]);
```

The `awaitPending` method resolves the promises and calls their setters to write the resolved values back to the variables.

**Await at node exit:** The builder inserts `await __ctx.pendingPromises.awaitAll()` before each node's return statement. This catches all unassigned async calls (fire-and-forget) that nobody explicitly awaited.

**Await before interrupt:** Before any interrupt return, the builder inserts `await __ctx.pendingPromises.awaitAll()`. This ensures all pending async work completes and all assigned variables hold resolved values before state is serialized. The serialized state is then complete and consistent.

### Why this solves each problem

- **Unassigned async calls:** Registered with `add` (no key stored). Caught by `awaitAll` at node exit.
- **Async vars + interrupts:** `awaitAll` resolves all pending promises (including assigned ones) before state serialization. The setter writes the resolved value back to the variable.
- **Loop collisions:** Each iteration gets a unique key from the counter. All promises are tracked independently.
- **Concurrent function collisions:** Each function call stores its key in its own `__self.__pendingKey_x`. The shared `PendingPromiseStore` holds all promises with distinct keys.

## Async + interrupts: phase 1 limitations

Interrupts allow Agency programs to pause execution, serialize state, and resume later. This creates a fundamental tension with async: you can't serialize something you've deliberately set loose.

### What happens when an async call triggers an interrupt

If an unassigned `async func()` is running in the background and it triggers an interrupt, the `awaitAll` call (at node exit or before another interrupt return) will discover the interrupt object among the resolved results.

In phase 1, this throws a `ConcurrentInterruptError` with a message telling the user to assign the call to a variable if it may interrupt. This is a deliberate limitation — the alternative (silently losing the interrupt or corrupting state) is worse.

### Why not just let both async calls keep running?

When one async function returns an interrupt, it would be nice if the other async functions kept running while the user handles the interrupt. This way the user doesn't have to wait.

But this means the execution state is only partially serialized — some work is still running. If you wanted to save the state and resume on a different machine (a core feature of Agency's durable execution), you couldn't, because the running promises aren't captured.

### The "await before interrupt" decision

We chose: when any interrupt is triggered, first await ALL pending promises before returning the interrupt. This means:

1. All async work completes before the interrupt is surfaced
2. All assigned variables have their resolved values
3. The serialized state is complete — you can resume on a different machine
4. No orphaned promises

The tradeoff is that the user waits for all async work to finish before seeing the interrupt. If this is unacceptable, users can run parallel agents by calling multiple node functions in parallel from TypeScript — each gets its own isolated execution context, so interrupts in one don't block the other.

### Future: interrupt queues (phase 2)

If an async call triggers an interrupt while another interrupt is already being returned, phase 1 throws an error. Phase 2 will add an interrupt queue: multiple interrupts are collected and surfaced one at a time. This enables multi-agent patterns where different agents may each need human approval.

### Future: handler syntax (phase 3)

Phase 3 will add in-language interrupt handling:

```agency
try {
  val = func()
} handle (interrupt) {
  approve(interrupt)
}
```

Handlers intercept interrupts before they bubble to the TypeScript caller. Combined with interrupt queues, this allows sophisticated agent orchestration patterns.
