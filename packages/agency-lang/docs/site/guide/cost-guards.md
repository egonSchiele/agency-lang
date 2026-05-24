# Cost guards

LLM-driven agents are easy to write, easy to deploy, and easy to set on fire — a runaway loop or a chatty tool can turn a planned $0.20 task into a $20 surprise. Agency's `guard` function caps the LLM cost of a block of work and lets your code decide what to do when the budget is blown.

## The shape

```ts
import { guard } from "std::thread"

node main() {
  const result = guard(cost: $2.0) as {
    const a = llm("classify this email")
    const b = llm("draft a reply")
    return a + " — " + b
  }
  if (isFailure(result)) {
    print("Over budget: spent " + result.error.actualCost)
    return "could not finish"
  }
  return result.value
}
```

`guard` takes a cost limit (a `number` of dollars — `$2.0` is the same as `2.0` because `$` is a no-op compile-time scale factor) and a trailing block. It runs the block, and:

- If the block completes within budget, `guard` returns `success(blockReturnValue)`.
- If the cumulative cost of LLM calls inside the block **exceeds** the limit, the block halts immediately and `guard` returns a `Failure` carrying the structured `GuardFailureData`:

  ```ts
  {
    type: "guardFailure",
    maxCost: number,   // the limit you passed
    actualCost: number, // what was actually spent before the trip
  }
  ```

  Access these as `result.error.type`, `result.error.maxCost`, `result.error.actualCost`.

The check fires every time an LLM call's cost is added to the per-branch accumulator. If a single call's cost pushes the total over the limit, the guard trips on that call.

## Nested guards

Guards are scoped — an inner trip does **not** trip an outer guard:

```ts
const outer = guard(cost: $10.0) as {
  const inner = guard(cost: $0.001) as {
    return llm("expensive job")
  }
  if (isFailure(inner)) {
    print("inner blew its $0.001 budget; outer still has plenty")
  }
  return "carry on"
}
```

The inner guard sees its own baseline (the parent's `localCost` at the moment the inner scope opened) and trips on its own limit. The outer guard sees the *cumulative* spend including the inner's cost — but only against its own (larger) limit.

## Guards inside fork branches (recommended)

If you fan out work across branches and want per-iteration enforcement, put the guard **inside** each branch:

```ts
const results = fork(jobs) as job {
  return guard(cost: $0.50) as {
    return processOneJob(job)
  }
}
// results is an array of Result; each branch may have tripped independently.
```

Each branch inherits a clone of the parent's guards plus any it pushes itself, so per-branch trips are isolated.

## Limitations (V1)

**Forks don't trip outer guards mid-flight.** Branch costs roll back into the parent stack only at branch completion (via `Runner.propagateBranchCost`). An outer guard wrapping a fork cannot pre-empt branches that are still running:

```ts
// AVOID this pattern if you want mid-fork enforcement
guard(cost: $1.0) as {
  fork(jobs) as job {
    expensiveCall(job)  // outer guard does NOT see this until the fork completes
  }
}
```

Use per-branch guards (see above) instead. After the fork completes, the next LLM call inside the outer guard will observe the rolled-up spend and trip, so the guard still catches the budget breach — just later than you might expect.

**Memory layer LLM calls bypass the guard.** Calls made internally by the memory layer (e.g. `memory.text`, `memory.embed` extraction prompts) currently don't flow through the guard check. The guard only enforces against LLM calls made via the standard `llm()` and `runPrompt` paths. Tracked as a follow-up.

**No dimensional unit checking.** `$2.0` and `2.0` are the same `number` at the type level — the unit literal is a notation aid, not a type-system distinction. You could pass a non-dollar number; the typechecker won't notice. This will improve when dimensioned types land.

## What about timeouts?

V1 is **cost-only**. The `GuardFailureData.type` field is a `string` rather than a literal `"guardFailure"` exactly so a future `"timeoutFailure"` variant can land without breaking V1 consumers. When timeout guards arrive, the shape will be:

```ts
type GuardFailureData = {
  type: "guardFailure" | "timeoutFailure",
  maxCost?: number,
  actualCost?: number,
  maxTime?: number,
  actualTime?: number,
}
```

Existing V1 code that only reads `maxCost` / `actualCost` will continue to work.

## How it works under the hood

1. `guard(cost: X) as { ... }` calls `__internal_pushGuard(X)`, which records `{ costLimit: X, costAtPush: stack.localCost }` on the active `StateStack`.
2. The block runs. Every LLM call's cost is added to `stack.localCost` inside `prompt.ts`.
3. After each cost addition, `prompt.ts` walks the active guards innermost-first. If any guard's delta (`stack.localCost - guard.costAtPush`) exceeds its `costLimit`, `prompt.ts` throws a `GuardExceededError`.
4. The thrown error propagates up through the user's code and the codegen's function-body auto-wrap (which explicitly re-throws `GuardExceededError` rather than converting it to a generic Failure).
5. The `guard` stdlib function's `try block()` catches the error. The runtime's `__tryCall` detects the `GuardExceededError` and returns a Failure with the structured `GuardFailureData` shape.
6. `__internal_popGuard()` removes the guard from the stack before `guard` returns. (The guard list is also serialized as part of `StateStack`, so checkpoint/restore cycles keep guards intact.)

See [the design spec](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md) for the full rationale.
