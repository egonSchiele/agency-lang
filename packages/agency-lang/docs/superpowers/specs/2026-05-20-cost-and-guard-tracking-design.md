# Cost Tracking and Guard Blocks

## Summary

Add runtime infrastructure for cost and timeout guards — blocks that automatically halt execution when a resource limit is exceeded. Guards are implemented as Agency stdlib functions built on low-level `__pushGuard`/`__popGuard` builtins, not as a new language construct.

## Dependencies

This spec depends on the thread-builtins spec (`2026-05-20-thread-builtins-and-stdlib-design.md`) for the `std::thread` module to exist. The `guard` function lives in `std::thread`.

## Motivation

Users need a way to limit how much an agent spends or how long it runs. The `guard` construct was originally planned as a new block type (see `docs/superpowers/plans/2026-05-05-guards-and-unit-literals.md`), but we want to avoid adding special-case block constructs when possible. Instead, guards are library functions built on composable primitives.

The key insight: when a guard's limit is exceeded, the entire guard block should halt and return a failure. Users should not have to check individual LLM calls for failures — the guard handles it.

## Design

### Developer experience

Note: the examples below use `$5.00` as a cost literal. Unit literals (including `$`) are a separate feature defined in the guards-and-unit-literals plan. If unit literals are not yet implemented, use plain numbers instead (e.g., `guard(5.00)`). The design works either way — `guard` just takes a number.

```
import { guard } from "std::thread"

node main() {
  const result = guard(5.00) as {
    const a = llm("step 1")
    const b = llm("step 2")
    return process(a, b)
  } catch "over budget"

  print(result)
}
```

If the budget is exceeded during step 2, the entire block halts. `result` is `"over budget"`. The user doesn't check individual LLM calls.

Nesting works:
```
guard(10.00) as {
  guard(2.00) as {
    llm("expensive thing")
  } catch "inner limit hit"
} catch "outer limit hit"
```

### Mechanism: thrown error, not interrupt

When a guard's limit is exceeded, the runtime throws a `GuardExceededError`. This is a regular JS error, not an interrupt. It propagates up the call stack through normal error propagation until the `guard` function's `try` catches it and converts it to a failure.

This was a deliberate choice. Interrupts require serializing execution state and pausing for user input, which is complex and doesn't match the use case — users almost always want "just stop," not "ask me if I want to continue." If a user does want the ask-me behavior, they can check `getCost()` manually and throw an interrupt themselves.

### GuardExceededError shape

```ts
class GuardExceededError extends Error {
  type: "cost" | "timeout";   // which limit was exceeded
  spent: number;               // amount spent (dollars for cost, ms for timeout)
  limit: number;               // the limit that was exceeded
}
```

The `type` field distinguishes cost vs timeout guards so the failure message can be informative. This also allows users to inspect the failure's `data` field if needed.

### Layer 1: `__` builtins

| Builtin | Behavior |
|---------|----------|
| `__pushGuard(limits)` | Push a guard scope onto the current `StateStack`'s guard list |
| `__popGuard()` | Pop the most recent guard scope from the current `StateStack`'s guard list |

These are context-injected builtins (registered in `CONTEXT_INJECTED_BUILTINS`), not builder macros, because they need access to the current `StateStack` via `__ctx`. They are not user-facing — they're used by the `guard` stdlib function.

### Layer 2: stdlib function

The `guard` function in `std::thread`:

```
export def guard(limit: number, block: () => any): Result {
  """
  Run a block with a cost limit. If LLM calls inside the block
  exceed the limit, the block halts and returns a failure.
  @param limit - Maximum cost in dollars
  """
  __pushGuard({ cost: limit })
  const result = try block()
  __popGuard()
  return result
}
```

The `try` keyword converts thrown errors (including `GuardExceededError`) into failures.

#### Cleanup safety: `__popGuard` must always run

The `try` keyword in Agency catches thrown JS errors and converts them to failures, so `GuardExceededError` is caught and `__popGuard()` runs on the next line. Agency also wraps every function body in an automatic try-catch, so unexpected errors are also caught.

**However, interrupts are a concern.** If code inside the guard block throws an interrupt, interrupts propagate differently than errors — they halt the runner and serialize state. If `__popGuard()` is skipped due to an interrupt, the guard stack is polluted on resume.

Possible solutions:
1. **Generated try/finally at the TS level**: The compiler emits `__popGuard()` in a `finally` block around the guard function's body, ensuring cleanup on all exit paths (normal return, error, interrupt halt). This is similar to how handlers use try/finally in `runner.ts`.
2. **Re-registration on resume**: Since the `guard` function re-executes on resume (skipping completed steps), it would re-encounter `__pushGuard` and the guard would be re-registered. But the step counter would skip past it (it already completed), so this doesn't work without special handling.
3. **Guard state serialization**: Include the guard list in `StateStack.toJSON()` so guards survive serialization. On resume, the guard list is restored from the checkpoint, so `__popGuard` not running during the interrupt is fine — the guard was already serialized.

Option 3 is the most natural fit. The guard list serializes with the `StateStack`, so it survives interrupt/resume. The `guard` function's `__pushGuard` call is a completed step that gets skipped on resume, but the guard entry is already in the deserialized `StateStack`. When the guard block eventually completes (or the guard function returns), `__popGuard` runs normally.

### Runtime: guard list on StateStack

The guard list lives on the `StateStack`, not on the global runtime context and not on individual `State` frames. `StateStack` is the right level because:
- It's per-branch in concurrent execution (each `BranchState` has its own `StateStack`)
- It spans across function frames (a guard pushed in one function applies to everything called from it)
- It serializes/deserializes with the rest of the stack state

The guard list is a simple array of `GuardEntry` objects:

```ts
type GuardEntry = {
  costLimit: number;      // the dollar limit
  spentSoFar: number;     // accumulated cost from LLM calls while this guard is active
  // future: timeoutMs, timeStarted, depthLimit, depthSoFar, etc.
};
```

### Runtime: cost checking after LLM calls

After each LLM call in `prompt.ts`, the runtime:
1. Walks the current `stateStack`'s guard list (all active guards, not just innermost)
2. Adds this call's cost to each guard's `spentSoFar` accumulator
3. If any guard's `spentSoFar` exceeds its `costLimit`, throws `GuardExceededError`

All active guards are updated, not just the innermost. This is because nesting means inner costs count toward outer limits.

## Open questions

### Cost accumulation across fork branches

When fork creates branches, each branch gets a cloned `StateStack` with cloned guard entries. Each branch accumulates costs independently. The question is: when fork collects all branch results back to the parent, should the parent guard see the sum of all branch costs?

It should — those costs were real. But the branches have independent `StateStack` copies, so the parent's guard entry was never updated.

Possible solutions:
1. **Cost-merge step**: When `Runner.runForkAll` collects results, it sums the `spentSoFar` deltas from each branch's guard entries and applies them to the parent's corresponding guard entries.
2. **Shared cost accumulator**: Instead of per-`StateStack` accumulators, use a shared atomic counter that all branches write to. But this reintroduces the concurrency issues we were trying to avoid.
3. **Accept the limitation**: Document that guards only account for costs on their own branch. Fork branches' costs are invisible to the parent guard. This is the simplest approach but means `guard(5.00) as { fork(items) as item { llm("expensive") } }` doesn't accurately track total cost.

**Unresolved.** Option 1 is the most correct but adds complexity to the fork completion path.

### Timeout guards

Timeout is conceptually different from cost:
- Cost is checked after each LLM call (discrete checkpoints)
- Timeout needs to fire even if the system is waiting on a single long LLM call

Timeout likely needs `AbortController`/`setTimeout` integration. The `StateStack` already carries an `abortSignal` for race cancellation — timeout guards could compose with this.

**Unresolved**: Should timeout use the same `__pushGuard`/`__popGuard` mechanism with a `timeout` field in the limits object? Or is it different enough to warrant separate primitives? The thrown-error approach works for both (`GuardExceededError` with a `type` field distinguishing cost vs timeout), but the runtime hooks are different (post-LLM-call check vs timer).

### Depth guards

Deferred. Not clear yet whether "depth" means number of LLM calls, number of tool call rounds, or call stack depth. Can be added later by extending the `GuardEntry` type.

### Memory layer costs

Memory layer LLM calls (`memory.text`, `memory.embed`) currently bypass the guard check because they call smoltalk directly, not through `prompt.ts`. Wiring them through the guard system is a future enhancement. For now, memory costs do not count toward guard limits.

### Interaction with the pipe operator

If a guard block is used inside a pipe chain, and the guard triggers a failure, this should compose naturally with pipe's short-circuit-on-failure behavior. But this hasn't been verified.

## Files to modify

### New files
- `lib/runtime/guard.ts` — `GuardEntry` type, `GuardExceededError` class
- `lib/runtime/guard.test.ts` — unit tests

### Modified files
- `lib/runtime/state/stateStack.ts` — add guard list to `StateStack`, include in `toJSON`/`fromJSON`
- `lib/runtime/prompt.ts` — check guard limits after each LLM call, update all active guards' accumulators
- `lib/codegenBuiltins/contextInjected.ts` — register `__pushGuard`/`__popGuard`
- `stdlib/thread.agency` — add `guard` function
