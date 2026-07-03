---
name: Guards
description: Documents the `guard` function for capping the cost and/or compute time of a block of work, returning a `Result` that lets you handle budget overruns.
---

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

Cost guards also meter subprocesses: spend from `std::agency` `run()` —
including nested subprocesses — is charged to enclosing cost guards in
real time, and a tripped budget terminates the subprocess and fails the
guard block with the usual cost-limit failure. `getCost()` reflects
subprocess spend as it happens.

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

The inner cost guard owns its own `spent` counter (initialized to `0` at push) and trips on its own limit. The outer cost guard is also charged for every LLM call in scope (including ones made inside the inner) and trips against its own limit. The `prompt.ts` post-call walk goes innermost-first, so when an inner exceeds its limit the inner's trip fires first and the outer's check at the same call site is skipped — that's how the `if (isFailure(inner))` above works. Inner time guards similarly track only the compute time spent inside the inner scope; the outer's timer keeps ticking through the inner regardless of whether the inner tripped.

Inner guards that a branch pushes *after* a `fork` opens stay branch-local — they sit on the child's stack at indices past `inheritedGuardCount` and are never visible to the parent or other sibling branches. This lets you compose an outer "hard cap across all branches" with per-branch sub-budgets:

```ts
guard(cost: $5.0) as {              // shared across every branch below
  fork(jobs) as job {
    guard(cost: $0.50) as {         // per-branch sub-budget, isolated
      return processOneJob(job)
    }
  }
}
```

## Forks, parallel, and message threads

### `fork` / `race` / `parallel`

Both kinds of guard work, with different mechanics:

- **Cost guards** are *shared* across all branches. `CostGuard.cloneForBranch` returns the same in-memory object the parent holds, so every branch's `stack.guards` array contains a live reference to the same `CostGuard` instance. Any LLM call from any branch charges the same counter; the next post-call check (in any branch — whichever runs next) returns the trip when the cumulative shared spend exceeds the limit. Inner cost guards that a branch pushes *after* the fork opens stay branch-local (see [Nested guards](#nested-guards)).
- **Time guards** are *not* cloned. The parent's `setTimeout` is the single source of truth. When it fires, the parent's `AbortController` propagates through the branches' composed abort signals; each branch halts at its next runner step boundary and control returns to the parent. The parent's next sync point then sees its own time guard's trip and produces the `timeoutFailure`.

A `prompt.ts` **pre-call gate** also walks the guard stack immediately before issuing an LLM request. If a sibling branch's earlier charge has already pushed the shared cost guard over its limit, the gate refuses the request before it hits the wire — you don't pay for a response you'd just throw away.

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

**Memory layer LLM calls bypass cost guards.** Calls made internally by the memory layer (e.g. `memory.text`, `memory.embed` extraction prompts) currently don't flow through the guard check. The guard only enforces against LLM calls made via the standard `llm()` and `runPrompt` paths. Tracked as a follow-up.

**No dimensional unit checking.** `$2.0` and `2.0` are the same `number` at the type level — the unit literal is a notation aid, not a type-system distinction. You could pass a non-dollar number for `cost:` or a non-millisecond number for `time:`; the typechecker won't notice. This will improve when dimensioned types land.

## How it works under the hood

Both variants share the same `Guard` interface in `lib/runtime/guard.ts`. `StateStack.guards` is an array of `Guard` instances; `pushGuard` / `popGuard` call each guard's `install` / `uninstall` hooks.

**Cost guards** (`CostGuard`):

1. Each `CostGuard` instance owns a `spent` counter (initialized to `0`).
2. Inside `prompt.ts`, every LLM call's cost is dispatched to `guard.charge(cost)` on every guard in `stack.guards` — including any shared parent guards inherited by a child branch.
3. `prompt.ts` walks the active guards innermost-first **twice** per call: a pre-call gate (refuses to issue the request if any guard's `spent > limit`) and a post-call check after the charge. Either site returns a `GuardExceededError` which propagates through user code; the stdlib `guard`'s `try block()` catches it via `__tryCall` and produces the structured `Failure`.
4. **Shared across fork branches.** `CostGuard.cloneForBranch` returns `this` — the same JS object — so every branch's `stack.guards` array holds a reference to the parent's CostGuard. Mutations are race-free thanks to single-threaded JS. On serialize, each child stack's `inheritedGuardCount` records how many of its guards were inherited; `toJSON` only serializes branch-owned guards (the inherited parent guard is serialized once on the parent's snapshot). On resume, `runBatch.rehydrateInheritedGuards` re-prepends the parent's live refs onto each child, restoring real-time sharing.

**Time guards** (`TimeGuard`):

1. `install` creates an `AbortController`, composes its signal into `stack.abortSignal`, and schedules a `setTimeout(timeLimit)` that calls `.abort()` when it fires.
2. Smoltalk and `Runner.shouldSkip` already observe `stack.abortSignal` for unrelated reasons (race-loser cancellation), so the abort propagates with no extra plumbing.
3. When the runner halts at an interrupt, `Guard.pause()` charges the in-flight window to `elapsedMs` and clears the timer. On resume, `Guard.resume()` re-arms `setTimeout(timeLimit - elapsedMs)`.
4. `Runner.shouldSkip()` converts the silent abort into a typed `GuardExceededError("time", ...)` at the next step boundary; the stdlib `guard`'s `try` catches it the same way as cost trips.

Checkpoint/restore cycles preserve guards: `toJSON` serializes only persistent state (cost baselines, accumulated elapsed time) and `Guard.resume()` re-establishes the runtime plumbing (abort controllers, timers) on the first runner step after deserialization.

See [the design spec](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md) for the cost-guard rationale.
