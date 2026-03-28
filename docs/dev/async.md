# Async Function Calls
CLAUDE: also read async-info-for-claude.md which contains detailed info.

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

## Problem 1: Unassigned async calls

When you call an async function without assigning the result to a variable:

```agency
node main() {
  async append(1, "hello")
  async append(0.5, "world")
  return arr
}
```

The generated TypeScript calls `append(...)` without `await`, but nobody ever collects or awaits the resulting Promise. The preprocessor only tracks async calls that are assigned to variables (it uses the variable name for `Promise.all` insertion). So the Promises just float away.

This was fixed by tracking all pending promises and awaiting them at certain boundaries, such as before returning to TypeScript.

## Problem 2: Async vars + interrupts

Even for assigned async calls, there's a bug when interrupts are involved:

```agency
node main() {
  x = async slowFunc()
  y = getApproval()  // triggers an interrupt
  print(x)
}
```

The interrupt at `getApproval()` serializes the execution state and returns to the TypeScript caller. But `x` still holds an unresolved Promise — it hasn't been awaited yet.

So interrupts are one of the boundaries where all in-flight promises are awaited to ensure they're resolved before the interrupt serializes all state.

## Problem 3: Key collisions with variable-name tracking

An earlier design proposed tracking promises in a shared store keyed by variable name (e.g., `"x"` maps to the promise for `x = async func()`). This has two collision problems:

### Loops

```agency
while (condition) {
  x = async func()
}
print(x)
```

Each iteration registers under key `"x"`, overwriting the previous entry. Only the last iteration's promise is tracked. Earlier promises are orphaned — still running, but untracked and never awaited.

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

## Branches
Note that the same state stack is not shared across multiple concurrent calls; instead, they each get their own state stack that starts fresh from the moment that thread starts executing branches on the current state stack. This lets us restore state across multiple threads in a pretty nice way. We resume a single thread, and for any async calls that that thread makes, we essentially unwind all those state stacks. So all these state stacks keep unrolling in a tree structure as you go through multiple layers of concurrent threads.

## LLM checkpoints don't work with async threads
I am just now adding a feature called LLM checkpoints. This feature would checkpoint after every LLM call. The idea is that LLM calls can be wrong, and if multiple LLM calls are made in a row where the input depends on the output of the previous call, well then the errors can compound.

This new feature lets you rewind to right after a specific LLM call. It also lets you override the value of that LLM call, as well as the values of any local variables in scope at this point. If an LLM chain goes wrong, you can trace exactly what happened, and then you can rewind to a previous checkpoint, change the data, and see if that helps.

Unfortunately, this doesn't deal with parallel threads very well. If I were to await all pending promises after each query, that would sort of destroy the point of parallelism, and I'm not sure if that would even be possible. It seems like that would maybe end with a lot of different threads all waiting for each other to finish. 

So, this LLM checkpoint feature not attempt to await any pending promises. That means if you resume using this feature, all pending promises are essentially useless. LLM checkpoints and async threads cannot be used together.

## Future work

### Interrupt queues (phase 2) — deferred

The idea here was to allow multiple different threads to throw interrupts. So, again, remember that when an interrupt is thrown, we wait for all pending promises to finish before returning to TypeScript. Well, it's possible that one of those pending promises throws an interrupt.
I wanted to add support for this and change from returning a single interrupt to returning an array of interrupts. Then TypeScript could handle each and respond to each interrupt.
This ended up being pretty hard to do. Most of the groundwork is there now, so it should be doable, though I am not sure how this would play with handlers because handlers currently get registered on the context. There is no way to register different handlers for different threads.

I actually don't think this would work anyway, as it would lead to deadlock. When an interrupt is thrown, the thread waits for all other threads to finish. What happens if two different threads throw interrupts?

1. Thread A interrupts → awaitAll() → yields, waiting for B
2. Thread B interrupts → awaitAll() → yields, waiting for A
3. Neither can return, so neither promise resolves

When an interrupt is thrown, each thread needs to remove itself from the store so that it isn't awaited, in order to break this deadlock.

Concurrency is hard.

#### Claude's notes on this
The original plan was for phase 2 to replace `ConcurrentInterruptError` with an interrupt queue: when `awaitAll` discovers multiple interrupts from pending promises, queue them and surface one at a time.

This is deferred because of significant complexity:

**Routing responses to the right function.** When multiple async functions each return an interrupt, and the user responds to each one, the responses need to be routed back to the correct function on resume. Currently `interruptData` is a single object on `GraphState`. Supporting multiple interrupts requires keying responses (by variable name or call index), changing the `interruptData` structure (breaking API change), and modifying the builder to pass the right response to each async call.

**StateStack interleaving.** The shared stateStack means we can't reliably capture per-function state snapshots while async calls are in flight. On resume, each async function would re-execute from scratch (step 0), replaying all side effects up to the interrupt point. This is the same replay behavior as current sync interrupts, but happening for multiple concurrent calls.

**Re-execution complexity.** On resume, the node re-runs, the step counter skips to the async calls, and each async function re-executes fully. Each function needs to find its own interrupt response in the (now keyed) `interruptData` and continue past its interrupt point. This requires builder changes to generate response routing code.

Given that the recommended pattern for parallel agents (calling from TypeScript) already works well, the interrupt queue feature is deferred until there's a concrete use case that can't be served by the TypeScript-level parallelism.
