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

## Edge cases and test cases

Each of these should have a corresponding Agency test (`.agency` + `.mjs` fixture pair in `tests/`) to verify the implementation handles it correctly.

### Basic async behavior

1. **Unassigned async calls complete before node returns.** The original bug. Both `async append(...)` calls should run concurrently and complete before `return arr`. Verify that all side effects have occurred.
    ```agency
    arr = []
    def append(sleepTime: number, value: any) {
      sleep(sleepTime)
      arr.push(value)
    }
    node main() {
      async append(1, "hello")
      async append(0.5, "world")
      return arr
    }
    ```

2. **Assigned async vars resolve before usage.** Existing behavior preserved with the new mechanism. `x = async func()` followed by `print(x)` should await `x` before the print.
    ```agency
    def slow(): string {
      sleep(0.1)
      return "done"
    }
    node main() {
      x = async slow()
      print(x)  // should print "done", not "[object Promise]"
      return x
    }
    ```

3. **Multiple assigned async vars resolve before usage.** Two async calls assigned to different variables, both used in the same expression.
    ```agency
    node main() {
      x = async funcA()
      y = async funcB()
      return [x, y]  // both should be resolved values
    }
    ```

4. **Mixed assigned and unassigned.** A node with both `x = async func()` and `async sideEffect()`. Both should complete before the node exits.
    ```agency
    log = []
    def sideEffect() { log.push("side") }
    def compute(): string { sleep(0.1); return "result" }
    node main() {
      x = async compute()
      async sideEffect()
      return { x: x, log: log }  // x should be "result", log should contain "side"
    }
    ```

5. **No async calls.** `awaitAll` is a no-op when there are no pending promises. Verify no performance impact or errors on purely synchronous code.

### Loops

6. **Async call inside while loop, variable used inside loop body.** The `awaitPending` is placed inside the loop, so each iteration resolves before the next.
    ```agency
    node main() {
      results = []
      i = 0
      while (i < 3) {
        x = async compute(i)
        results.push(x)  // x should be resolved here
        i = i + 1
      }
      return results
    }
    ```

7. **Async call inside while loop, variable used after loop.** Only the last iteration's value matters, but all promises should still complete (no orphaned promises crashing on cleanup).
    ```agency
    node main() {
      i = 0
      while (i < 3) {
        x = async compute(i)
        i = i + 1
      }
      return x  // should be compute(2)'s result
    }
    ```

8. **Unassigned async call inside while loop.** Fire-and-forget inside a loop. All calls should complete before node exit.
    ```agency
    log = []
    def record(val: number) { log.push(val) }
    node main() {
      i = 0
      while (i < 3) {
        async record(i)
        i = i + 1
      }
      return log  // should contain [0, 1, 2] (order may vary)
    }
    ```

9. **Async call inside for loop.** Same patterns as while loop but with for loop syntax.
    ```agency
    node main() {
      results = []
      for item in [1, 2, 3] {
        x = async compute(item)
        results.push(x)
      }
      return results
    }
    ```

### Concurrent function calls

10. **Same function called async twice, with internal async vars.** Each call should get its own unique pending key. Neither call should interfere with the other's variable resolution.
    ```agency
    def helper(val: string): string {
      x = async transform(val)
      return x
    }
    node main() {
      a = async helper("first")
      b = async helper("second")
      return [a, b]  // should be [transform("first"), transform("second")]
    }
    ```

11. **Unassigned async calls to the same function.** Multiple fire-and-forget calls to the same function. All should complete before node exit.
    ```agency
    log = []
    def record(val: string) { log.push(val) }
    node main() {
      async record("a")
      async record("b")
      async record("c")
      return log  // should contain all three (order may vary)
    }
    ```

### Functions (not just nodes)

12. **Async call inside a sync function called from a node.** The pending promise is registered on the shared `RuntimeContext`. It should be caught by `awaitAll` at node exit.
    ```agency
    log = []
    def helper() {
      async record("from helper")
    }
    def record(val: string) { log.push(val) }
    node main() {
      helper()
      return log  // should contain "from helper"
    }
    ```

13. **Nested function calls with async.** A function calls another function that has async calls. The promises propagate up through the shared `RuntimeContext`.
    ```agency
    log = []
    def inner() { async record("inner") }
    def outer() { inner() }
    def record(val: string) { log.push(val) }
    node main() {
      outer()
      return log  // should contain "inner"
    }
    ```

### Conditionals

14. **Async assignment in conditional branch, variable used after.** If the branch didn't execute, `awaitPending` should silently skip the missing key.
    ```agency
    def compute(): string { return "computed" }
    node main() {
      x = "default"
      if (true) {
        x = async compute()
      }
      return x  // should be "computed"
    }
    ```

15. **Async assignment in conditional branch that doesn't execute.** The `awaitPending` should be a no-op for the missing key, and the variable retains its prior value.
    ```agency
    def compute(): string { return "computed" }
    node main() {
      x = "default"
      if (false) {
        x = async compute()
      }
      return x  // should be "default"
    }
    ```

### Interrupts

16. **Assigned async var resolves before interrupt.** `x = async func()` fires off, then a sync call triggers an interrupt. After `awaitAll`, `x` should hold the resolved value in the serialized state.
    ```agency
    def slow(): string { sleep(0.1); return "done" }
    node main() {
      x = async slow()
      y = interrupt("Need approval")
      return [x, y]
    }
    ```
    Test by triggering the interrupt, inspecting the serialized state to verify `x` is `"done"` (not a Promise), then approving and verifying the final result.

17. **Unassigned async call completes before interrupt.** Fire-and-forget should complete before the interrupt is returned.
    ```agency
    log = []
    def record(val: string) { sleep(0.1); log.push(val) }
    node main() {
      async record("background")
      y = interrupt("Need approval")
      return { log: log, y: y }
    }
    ```
    Test by triggering the interrupt, verifying `log` contains `"background"` in the serialized state.

18. **Concurrent interrupt error.** An unassigned async call triggers an interrupt while the main path also triggers an interrupt. Should throw `ConcurrentInterruptError`.
    ```agency
    def risky() { interrupt("from async") }
    node main() {
      async risky()
      y = interrupt("from main")
      return y
    }
    ```
    Test that this throws `ConcurrentInterruptError` with a helpful message.

19. **Interrupt resume after async calls.** After approving an interrupt, execution resumes correctly. Any async calls from before the interrupt should not re-execute.
    ```agency
    counter = 0
    def increment() { counter = counter + 1 }
    node main() {
      async increment()
      y = interrupt("Need approval")
      return { counter: counter, y: y }
    }
    ```
    Test: trigger interrupt, verify counter is 1, approve, verify counter is still 1 (not 2).

### Global and shared variables

20. **Async call in global variable initialization.** Global variables are initialized per-call, so async calls during init should be tracked and awaited.
    ```agency
    def compute(): number { return 42 }
    x = async compute()
    node main() {
      return x  // should be 42, not a Promise
    }
    ```

21. **Async call with shared variable.** Shared variables are initialized once and not serialized. Verify that async calls in shared init context don't interfere with the promise tracking.

### Error handling

22. **Async call that throws an error.** If a pending async call rejects, the error should propagate up and fail the node. The `Promise.all` fail-fast semantics mean no setters fire.
    ```agency
    def failing() { throw "async error" }
    node main() {
      async failing()
      return "should not reach"
    }
    ```
    Test that the node fails with the error from `failing()`.

23. **Assigned async call that throws, with other async calls pending.** The error from one should propagate; the other pending calls should not cause secondary crashes.
    ```agency
    def failing() { throw "error" }
    def slow(): string { sleep(1); return "ok" }
    node main() {
      x = async failing()
      y = async slow()
      return [x, y]
    }
    ```

### Code generation

24. **Verify generated TypeScript for assigned async call.** The builder should emit `__self.__pendingKey_x = __ctx.pendingPromises.add(...)` after the assignment. The `isInterrupt` check should be skipped for async calls.

25. **Verify generated TypeScript for unassigned async call.** The builder should emit `__ctx.pendingPromises.add(func(...))` without storing the key. No `isInterrupt` check.

26. **Verify `awaitAll` is inserted at node exit.** Every node body should end with `await __ctx.pendingPromises.awaitAll()` before the return.

27. **Verify `awaitAll` is inserted before interrupt returns.** Each `isInterrupt` check in the generated code should call `awaitAll` before returning the interrupt.

28. **Verify preprocessor generates `awaitPending` calls.** The preprocessor should emit `await __ctx.pendingPromises.awaitPending([__self.__pendingKey_x])` instead of `[__self.x] = await Promise.all([__self.x])`.

### Pre-existing bug fix

29. **`respondToInterrupt` cleanup.** Verify that `respondToInterrupt` now has a `finally { execCtx.cleanup() }` block, matching `runNode`'s pattern. This ensures `PendingPromiseStore.clear()` runs on error paths during interrupt resumption.

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
