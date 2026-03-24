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

**Await at runtime entry points:** The `awaitAll` call does NOT live in generated node code. Instead, it lives in the three runtime functions that return control to TypeScript: `runNode`, `respondToInterrupt`, and `resumeFromState` (all in `lib/runtime/`). This is the right place because:

- Pending promises live on `RuntimeContext`, which persists across node transitions within the same execution. There's no need to await them at every node boundary.
- Node-to-node transitions (e.g., `return otherNode(...)`) should not wait for pending promises — that would add artificial slowness. The async work continues in the background and is only required to complete before we return to TypeScript or serialize state for an interrupt.
- Centralizing `awaitAll` in the runtime (rather than in generated code) means fewer code paths to maintain and less generated code.

**Await before interrupt:** Before any interrupt return, the builder inserts `await __ctx.pendingPromises.awaitAll()` in the generated code. This ensures all pending async work completes and all assigned variables hold resolved values before state is serialized. The serialized state is then complete and consistent. This is separate from the runtime `awaitAll` because interrupts return from inside generated node code, not from the runtime entry points.

### Why this solves each problem

- **Unassigned async calls:** Registered with `add` (no key stored). Caught by `awaitAll` in `runNode`/`respondToInterrupt`/`resumeFromState` when execution returns to TypeScript.
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

26. **Verify `awaitAll` is called in runtime entry points.** `runNode`, `respondToInterrupt`, and `resumeFromState` should all call `await execCtx.pendingPromises.awaitAll()` before returning to TypeScript.

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

## Known limitations

### StateStack is shared across concurrent async calls

The `StateStack` on `RuntimeContext` is a single LIFO stack shared across all concurrent async function calls within the same node. When two async functions run concurrently, they both push/pop frames on this stack. Since JavaScript async functions interleave at `await` points, the pops can be mismatched:

1. `agentA()` starts → pushes frame A (stack: `[A]`)
2. agentA hits `await` → yields
3. `agentB()` starts → pushes frame B (stack: `[A, B]`)
4. agentB finishes first → `finally` pops frame B (correct)
5. But if agentA finished first → `finally` pops frame **B** (wrong — B is on top, not A)

**Why this doesn't cause runtime errors in phase 1:** Each function captures a direct JavaScript object reference to its frame at setup time (`__stack = __setupData.stack`, `__self = __stack.locals`). When a mismatched `pop()` removes the wrong frame from the stateStack *array*, the frame object itself still exists in memory — JavaScript is garbage collected, and the function still holds its reference. So `__self.x = 5` continues to work correctly even after the frame has been removed from the array. Consider this scenario:

1. threadA pushes funcA1, threadB pushes funcB1, threadA pushes funcA2, threadB pushes funcB2
2. Stack array: `[A1, B1, A2, B2]`
3. threadB pops → removes B2 (correct). Stack: `[A1, B1, A2]`
4. threadB pops → removes **A2** (wrong!). Stack: `[A1, B1]`
5. funcA2 tries to set a variable → still works, because funcA2 holds a direct reference to the A2 frame object, which is still in memory even though it's no longer in the array

So the mismatched pops don't corrupt in-memory execution.

**Why this does break serialization:** When `stateStack.toJSON()` is called, it serializes `this.stack` — the array. If a frame was prematurely popped from the array by the wrong thread, it won't appear in the serialized output. On resume, that frame's state (locals, step counter, threads) is lost. This is why phase 1 awaits all async calls before any serialization occurs — by that point, all frames have been popped and the stateStack is empty. It also means we cannot reliably serialize the stateStack while async calls are in flight, which is one of the reasons phase 2 (interrupt queues) is complex — see below.

### Async calls are not allowed inside loops

Async function calls (`async func()`) are not allowed inside `while` or `for` loops. The compiler will reject them with an error at compile time.

**Why:** Agency's interrupt resumption relies on a branch system that tracks forked state stacks for each async call. Branches are keyed by the step index of the statement that contains the async call. Inside a loop, the entire loop body is a single step, so all async calls within it — across all iterations — share the same branch key. This causes collisions:

1. Two async calls in the same iteration (e.g., `async compute(i)` and `async record(i)`) overwrite each other's branch data.
2. Across iterations, a new call finds the previous iteration's branch data and incorrectly enters deserialization mode.

The result is corrupted state: promises resolve to `null`, side effects are lost, and interrupt resumption breaks.

**Workaround:** Move the async call into a separate function that is called from the loop:

```agency
def processItem(i: number): number {
  x = async compute(i)
  async record(i)
  return x
}

node main() {
  results = []
  i = 0
  while (i < 3) {
    results.push(processItem(i))
    i = i + 1
  }
  return results
}
```

Or remove the `async` keyword if concurrency within the loop body isn't needed.

### Functions must not trigger node transitions

Functions (`def`) must not call graph nodes. This is enforced at compile time by the type checker. The reason: a node call returns a `GoToNode` object that tells SimpleMachine to transition. If a function returns a `GoToNode`, it would need to propagate up through the call chain to the node level, which is not how functions work (they return values, not graph transitions).

This becomes especially dangerous with async:

```agency
def goFoo() {
  return foo()
}

def goBar() {
  return bar()
}

node main() {
  async goFoo()
  async goBar()
}
```

Two concurrent async functions both trying to transition the graph to different nodes is a race condition. Only one transition can happen, and which one "wins" depends on execution order. This is nonsensical.

The compile-time check prevents this class of bugs entirely.

### Parallel agents: recommended pattern

For running multiple agents in parallel where each may need interrupts or independent state, the recommended pattern is to call multiple node functions in parallel from TypeScript:

```typescript
const [result1, result2] = await Promise.all([
  agentA("task 1"),
  agentB("task 2"),
]);
```

Each call gets its own isolated `RuntimeContext` (its own `StateStack`, `GlobalStore`, `PendingPromiseStore`). Interrupts in one don't block the other. State serialization works correctly because each execution is independent.

This avoids all the shared-state issues that arise from concurrent async calls within a single node.

## Future work

### Interrupt queues (phase 2) — deferred

The original plan was for phase 2 to replace `ConcurrentInterruptError` with an interrupt queue: when `awaitAll` discovers multiple interrupts from pending promises, queue them and surface one at a time.

This is deferred because of significant complexity:

**Routing responses to the right function.** When multiple async functions each return an interrupt, and the user responds to each one, the responses need to be routed back to the correct function on resume. Currently `interruptData` is a single object on `GraphState`. Supporting multiple interrupts requires keying responses (by variable name or call index), changing the `interruptData` structure (breaking API change), and modifying the builder to pass the right response to each async call.

**StateStack interleaving.** The shared stateStack means we can't reliably capture per-function state snapshots while async calls are in flight. On resume, each async function would re-execute from scratch (step 0), replaying all side effects up to the interrupt point. This is the same replay behavior as current sync interrupts, but happening for multiple concurrent calls.

**Re-execution complexity.** On resume, the node re-runs, the step counter skips to the async calls, and each async function re-executes fully. Each function needs to find its own interrupt response in the (now keyed) `interruptData` and continue past its interrupt point. This requires builder changes to generate response routing code.

Given that the recommended pattern for parallel agents (calling from TypeScript) already works well, the interrupt queue feature is deferred until there's a concrete use case that can't be served by the TypeScript-level parallelism.

### Handler syntax (phase 3) — deferred

Phase 3 would add in-language interrupt handling:

```agency
try {
  val = func()
} handle (interrupt) {
  approve(interrupt)
}
```

Handlers would intercept interrupts before they bubble to the TypeScript caller. This depends on phase 2 (interrupt queues) for the multi-interrupt case, so it is also deferred.
