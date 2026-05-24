# Guards

LLM-driven agents are easy to write, easy to deploy, and easy to set on fire — a runaway loop or a chatty tool can turn a planned $0.20 task into a $20 surprise, or a 200ms response into a five-minute hang. Agency's `guard` function caps the **cost** and/or **compute time** of a block of work and lets your code decide what to do when the budget is blown.

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

`guard` takes one or both of:

- `cost:` — a `number` of dollars (`$2.0` is the same as `2.0`; `$` is a no-op compile-time scale factor).
- `time:` — a `number` of milliseconds (use the unit literals: `30s`, `5m`, `100ms`, `1h`).

…and a trailing block. It runs the block, and:

- If the block completes within all configured limits, `guard` returns `success(blockReturnValue)`.
- If any limit is exceeded, the block aborts and `guard` returns a `Failure` carrying the structured `GuardFailureData`:

  ```ts
  type GuardFailureData = {
    type: string,         // "guardFailure" (cost) or "timeoutFailure" (time)
    maxCost: number | null,
    actualCost: number | null,
    maxTime: number | null,    // ms
    actualTime: number | null, // ms
  }
  ```

  Access these as `result.error.type`, `result.error.maxCost`, `result.error.maxTime`, etc. The unused dimension's fields are `null`.

The cost check fires every time an LLM call's cost is added to the per-branch accumulator. The time check fires at the next runner step boundary after the timer expires.

## Timeout

```ts
const result = guard(time: 30s) as {
  return planAndExecute()
}
if (isFailure(result)) {
  // result.error.type === "timeoutFailure"
  print("Took too long: " + result.error.actualTime + "ms (limit " + result.error.maxTime + ")")
}
```

Time semantics are **compute-time**: wall clock only ticks while a runner is actively executing inside the guarded scope. Time spent paused on an interrupt (waiting for user input, etc.) does **not** count against the budget; on resume, the timer is re-armed with the remaining budget. This mirrors how cost guards only count actual LLM spend, not wall-clock waiting.

In-flight LLM HTTP requests are cancelled when the timer fires — the abort signal is composed into the request via smoltalk. In-flight Agency tool bodies stop at the next runner step boundary.

## Combining cost and time

```ts
const result = guard(cost: $5.0, time: 60s) as {
  return runLongConversation()
}
if (isFailure(result)) {
  if (result.error.type == "guardFailure") {
    print("Out of money after " + result.error.actualCost)
  } else {
    print("Out of time after " + result.error.actualTime + "ms")
  }
}
```

Both limits trip independently; whichever fires first wins. Internally `guard` pushes two separate `Guard` instances onto the stack — each is responsible for its own dimension.

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

The inner cost guard sees its own baseline (the parent's `localCost` at the moment the inner scope opened) and trips on its own limit. The outer cost guard sees the *cumulative* spend including the inner's cost — but only against its own (larger) limit. Inner time guards similarly track only the compute time spent inside the inner scope; the outer's timer keeps ticking through the inner regardless of whether the inner tripped.

## Forks, parallel, and message threads

### `fork` / `race` / `parallel`

Both kinds of guard work, with different mechanics:

- **Cost guards** are *cloned* into each branch. Each branch independently tracks cost-since-push and trips its own clone from inside the branch. The parent's view of cost is updated only at branch completion (see "Limitations" below).
- **Time guards** are *not* cloned. The parent's `setTimeout` is the single source of truth. When it fires, the parent's `AbortController` propagates through the branches' composed abort signals; each branch halts at its next runner step boundary and control returns to the parent. The parent's next sync point then sees its own time guard's trip and produces the `timeoutFailure`.

If you want per-branch enforcement, put the guard **inside** each branch:

```ts
const results = fork(jobs) as job {
  return guard(cost: $0.50, time: 10s) as {
    return processOneJob(job)
  }
}
// results is an array of Result; each branch may have tripped independently.
```

### `thread { ... }` / `subthread { ... }`

These isolate *message history* but **not** cost or abort plumbing. A guard wrapping a thread block sees every LLM call inside it, just as it would without the block:

```ts
guard(cost: $1.0) as {
  thread {
    llm("first turn")  // counts toward the $1.0 budget
    llm("second turn") // also counts
  }
}
```

If you want per-thread cost or time limits, wrap each thread in its own `guard(...)`, or push the work into a fork to get a fresh `StateStack`.

### `goto`

`goto` is statically rejected inside any block, including a guard block. The check happens at compile time.

## Limitations (V1)

**JS-bodied tool calls cannot be aborted mid-execution.** Tool functions whose body is written in JavaScript (rather than Agency code) run to completion in the background once started; only the next runner step after they return will see the trip and abandon their result. Agency-bodied tools, in-flight LLM HTTP requests, and the runner itself all observe the abort signal and stop promptly. Long-term plan: opt-in cancellation by reading `state.stateStack.abortSignal` from inside JS tool bodies (currently only internal tools do this).

**Forks don't trip outer cost guards mid-flight.** Branch costs roll back into the parent stack only at branch completion (via `Runner.propagateBranchCost`). An outer cost guard wrapping a fork cannot pre-empt branches that are still running:

```ts
// AVOID this pattern if you want mid-fork cost enforcement
guard(cost: $1.0) as {
  fork(jobs) as job {
    expensiveCall(job)  // outer cost guard does NOT see this until the fork completes
  }
}
```

Use per-branch guards (see above) instead. After the fork completes, the next LLM call inside the outer guard will observe the rolled-up spend and trip, so the guard still catches the budget breach — just later than you might expect. Time guards do **not** have this limitation: the parent's timer fires on wall clock and aborts every branch directly.

**Memory layer LLM calls bypass cost guards.** Calls made internally by the memory layer (e.g. `memory.text`, `memory.embed` extraction prompts) currently don't flow through the guard check. The guard only enforces against LLM calls made via the standard `llm()` and `runPrompt` paths. Tracked as a follow-up.

**No dimensional unit checking.** `$2.0` and `2.0` are the same `number` at the type level — the unit literal is a notation aid, not a type-system distinction. You could pass a non-dollar number for `cost:` or a non-millisecond number for `time:`; the typechecker won't notice. This will improve when dimensioned types land.

## How it works under the hood

Both variants share the same `Guard` interface in `lib/runtime/guard.ts`. `StateStack.guards` is an array of `Guard` instances; `pushGuard` / `popGuard` call each guard's `install` / `uninstall` hooks.

**Cost guards** (`CostGuard`):

1. `install` captures `stack.localCost` as the baseline.
2. Every LLM call's cost is added to `stack.localCost` inside `prompt.ts`.
3. After each cost addition, `prompt.ts` walks the active guards innermost-first. Each guard's `check()` returns a `GuardExceededError` if `stack.localCost - baseline > limit`.
4. The error propagates through user code; the stdlib `guard`'s `try block()` catches it via `__tryCall`, which produces the structured `Failure`.

**Time guards** (`TimeGuard`):

1. `install` creates an `AbortController`, composes its signal into `stack.abortSignal`, and schedules a `setTimeout(timeLimit)` that calls `.abort()` when it fires.
2. Smoltalk and `Runner.shouldSkip` already observe `stack.abortSignal` for unrelated reasons (race-loser cancellation), so the abort propagates with no extra plumbing.
3. When the runner halts at an interrupt, `Guard.pause()` charges the in-flight window to `elapsedMs` and clears the timer. On resume, `Guard.resume()` re-arms `setTimeout(timeLimit - elapsedMs)`.
4. `Runner.shouldSkip()` converts the silent abort into a typed `GuardExceededError("time", ...)` at the next step boundary; the stdlib `guard`'s `try` catches it the same way as cost trips.

Checkpoint/restore cycles preserve guards: `toJSON` serializes only persistent state (cost baselines, accumulated elapsed time) and `Guard.resume()` re-establishes the runtime plumbing (abort controllers, timers) on the first runner step after deserialization.

See [the design spec](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md) for the cost-guard rationale.
