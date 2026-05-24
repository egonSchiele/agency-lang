# Timeout Guards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing `guard(...) as { ... }` stdlib function with an optional `time:` parameter. When the wall-clock time spent *executing* inside the block exceeds the limit, the block aborts and `guard` returns a `Failure` carrying `GuardFailureData` with a `"timeoutFailure"` variant.

The compute-time semantics: time only accumulates while the guarded block is actively running. Time spent paused on an interrupt (waiting for user input, etc.) does NOT count. On checkpoint resume, the timer is re-armed with the remaining budget.

**Reference prior work:**
- Cost guards: [`docs/superpowers/plans/2026-05-23-builtin-cost-guards.md`](2026-05-23-builtin-cost-guards.md). This plan reorganizes that mechanism behind a `Guard` interface before adding the time variant.
- The cost-guard failure shape already reserves a `"timeoutFailure"` variant for the `type` field — see [`stdlib/thread.agency#L68-L72`](../../stdlib/thread.agency#L68-L72) and the V2 sketch at the bottom of [`docs/site/guide/cost-guards.md`](../../docs/site/guide/cost-guards.md).
- The abort plumbing already exists end-to-end:
  - [`StateStack.abortSignal`](../../lib/runtime/state/stateStack.ts#L275) is checked by [`Runner.shouldSkip()`](../../lib/runtime/runner.ts#L110-L114) — Agency tool bodies halt at the next step boundary.
  - [`ctx.getAbortSignal(stateStack)`](../../lib/runtime/state/context.ts#L377-L379) is already passed to smoltalk in [`prompt.ts#L90`](../../lib/runtime/prompt.ts#L90) — in-flight LLM HTTP requests cancel.
  - [`pr.parallel` → `runBatch`](../../lib/runtime/promptRunner.ts#L170-L182) passes the prompt's stack as `parentStack`, and [`composeBranchAbortSignal`](../../lib/runtime/runBatch.ts#L183-L194) does `AbortSignal.any([parentSig, branch.abortController.signal])` — child tool branches inherit the cancel.

---

## Design: the `Guard` interface

The existing implementation has a single `GuardEntry` record with a couple of cost-specific fields. Adding time as a second record-with-more-fields would spread per-guard lifecycle logic (install abort controller, compose signal, charge elapsed time, restore signal on pop) across `pushGuard`, `popGuard`, `Runner.halt`, `Runner.step`, and `Runner.shouldSkip`.

Instead, replace `GuardEntry` with a `Guard` interface. Every guard variant (cost, time, future) implements it. The stack and runner only ever talk to the interface; per-variant internals stay inside their class.

```ts
// lib/runtime/guard.ts
export interface Guard {
  /** Called when the guard is pushed onto a stack. May mutate the
   *  stack (e.g. compose its AbortController into stack.abortSignal).
   *  Must be paired with uninstall(). */
  install(stack: StateStack): void;

  /** Called when popped. Must undo whatever install() did. */
  uninstall(stack: StateStack): void;

  /** Called when the runner halts at an interrupt boundary.
   *  Used to freeze any in-process timers and charge elapsed time. */
  pause(): void;

  /** Called when the runner resumes after a checkpoint restore.
   *  Re-arms timers, rebuilds non-serialized runtime state. */
  resume(stack: StateStack): void;

  /** Called at each sync point (cost-accumulation in prompt.ts,
   *  Runner.shouldSkip). Returns the trip error or null. */
  check(stack: StateStack): GuardExceededError | null;

  /** Called when a fork/race branch is being seeded from this stack.
   *  Return a fresh Guard for the child branch, OR `undefined` if the
   *  branch doesn't need an independent copy — abort propagation via
   *  the composed AbortSignal alone is sufficient. See "Forks" below. */
  cloneForBranch(parentStack: StateStack, childStack: StateStack): Guard | undefined;

  /** Serialize persistent state only. The runtime fields
   *  (controllers, timer handles, perf stamps) are NOT included —
   *  they're re-initialized by resume(). */
  toJSON(): unknown;
}

// Registry of guard variants, keyed by a discriminator on toJSON output,
// so fromJSON can dispatch.
export function guardFromJSON(json: any): Guard {
  switch (json.kind) {
    case "cost": return CostGuard.fromJSON(json);
    case "time": return TimeGuard.fromJSON(json);
    default: throw new Error(`Unknown guard kind: ${json.kind}`);
  }
}
```

With this in place, the runner and stack code becomes declarative — no per-variant branching.

---

## Open questions resolved (V1)

| Question | V1 answer |
| --- | --- |
| Surface syntax | `guard(time: 30s) as { ... }` — reuses the existing `s`/`m`/`ms` unit literals; canonical value is milliseconds. `guard(cost: $X, time: Yms) as { ... }` installs both a CostGuard and a TimeGuard (two separate `Guard` instances on the stack — keeps each class single-responsibility). Whichever fires first wins. |
| Wall-clock vs compute-time | Compute-time. Time spent paused on interrupts does NOT count. Matches cost-guard semantics (cost only ticks during actual LLM calls). |
| Checkpoint durability | `TimeGuard.toJSON` serializes `{ timeLimit, elapsedMs }`. `resume()` re-arms `setTimeout((timeLimit - elapsedMs))` — or trips immediately if already over. |
| Aborting in-flight work | LLM HTTP: smoltalk already honors the composed `abortSignal`. Agency tool bodies: `Runner.shouldSkip()` already checks `stack.abortSignal?.aborted`. JS tool bodies: NOT cancellable in V1 — documented limitation. |
| Nested guards | Independent. Inner trip does not trip outer. Outer's `elapsedMs` keeps accumulating while the inner runs. |
| Fork/race branches | Per-guard decision via `cloneForBranch`. `CostGuard` returns a fresh clone (branch independently accumulates cost; trip must fire from inside the branch). `TimeGuard` returns `undefined` — the parent's timer is the single source of truth; abort cascade via the composed `stack.abortSignal` already propagates to every branch's `Runner.shouldSkip`. Branches halt silently on the signal; the parent's next sync point throws. See "Concurrency interactions" below. |
| Failure shape | Extend `GuardFailureData` with optional `maxTime`/`actualTime`. The `type` field becomes `"timeoutFailure"` on a time trip. Cost-only consumers keep working. |

---

## Concurrency interactions

How guards behave under each of Agency's concurrency / scoping constructs. **No new code is required for any of these** beyond what's in Tasks 1-5; this section documents how the existing primitives compose with the `Guard` interface.

| Construct | CostGuard behavior | TimeGuard behavior |
| --- | --- | --- |
| `fork` / `race` | Cloned into each branch via `cloneForBranch`. Each branch independently tracks cost-since-push against the limit; the trip throws from inside the branch's `Runner.shouldSkip`. Parent observes rolled-up cost at `propagateBranchCost`. | NOT cloned (`cloneForBranch` returns `undefined`). The parent's `setTimeout` is the single source of truth. When it fires, the parent's `AbortController.abort()` propagates through [`composeBranchAbortSignal`](../../lib/runtime/runBatch.ts#L183-L194) to every branch's `stack.abortSignal`. Each branch's `Runner.shouldSkip` halts silently (no guard present → no throw). Control returns to the parent's fork-wait; the parent's next sync point sees its own TimeGuard's `tripped === true` and throws `GuardExceededError("time", ...)`. |
| `parallel { ... }` | Same as `fork` — [`parallelBlock` desugars to `fork`](../../lib/preprocessors/parallelDesugar.ts#L406-L423) in the preprocessor, so codegen never sees it as a separate construct. | Same as `fork`. |
| `seq { ... }` | No effect — `seq` inside `parallel` is just one of the arms; outside `parallel` it has no runtime effect (its body is inlined). | Same — no special handling. |
| `thread { ... }` / `subthread { ... }` | The thread block creates a new `MessageThread` but reuses the same `StateStack`. Cost accumulates onto the surrounding stack's `localCost`, exactly as if there were no thread block. The surrounding guard sees everything. | Same — only message history is isolated, not cost/abort plumbing. The TimeGuard's window keeps ticking across the thread block. |
| Multiple interrupts propagating through nested Runners | Each Runner's `halt()` calls `g.pause()` on every guard. First call charges the elapsed delta and flips state to `"paused"`; subsequent calls (from outer Runners halting microseconds later in the same JS tick) are idempotent no-ops. | Same — pause/resume are idempotent on TimeGuard via the `state` field. |
| `goto` inside a guard block | Statically rejected at compile time by [`processGotoStatement`](../../lib/backends/typescriptBuilder.ts#L2285-L2289). `goto` requires node-body scope; the `guard(...) as { ... }` block is `"block"` scope. | Same — also rejected at compile time. |
| `return` inside a guard block | Block's `Runner` halts with the return value. Control returns to the `guard` stdlib function, `try block()` completes, `__internal_popGuard` runs and calls `g.uninstall(stack)`. The CostGuard's `uninstall` is a no-op. | Same flow — but `TimeGuard.uninstall` clears the in-process timer and restores `stack.abortSignal`, in that order, so any late-firing timer can't trip the outer scope. |

**One nuance to highlight in user-facing docs:** `thread { ... }` and `subthread { ... }` isolate *message history* but NOT cost or abort plumbing. A guard around `thread { ... }` sees every LLM call inside the thread block, just as it would without the block. This may surprise users who expect "thread" to isolate cost too.

---

## Files to create / modify

### New files
- `tests/agency/guards/guard-time-trip.agency` + `.test.json`
- `tests/agency/guards/guard-time-no-trip.agency` + `.test.json`
- `tests/agency/guards/guard-time-and-cost.agency` + `.test.json` — both limits, time trips first.
- `tests/agency/guards/guard-time-nested.agency` + `.test.json`
- `tests/agency/guards/guard-time-pause-resume.agency` + `.test.json` — proves interrupt time doesn't count.
- `tests/agency/guards/guard-time-aborts-tools.agency` + `.test.json` — proves in-flight Agency tool bodies abort.

### Modified files
- `lib/runtime/guard.ts` — refactor to the `Guard` interface; add `CostGuard` (extracted from existing logic), `TimeGuard`, `guardFromJSON`.
- `lib/runtime/guard.test.ts` — class-level tests for install/uninstall/pause/resume/check invariants.
- `lib/runtime/state/stateStack.ts` — change `guards: GuardEntry[]` → `guards: Guard[]`. `pushGuard(g)` calls `g.install(this)`; `popGuard()` calls `g.uninstall(this)`. `toJSON`/`fromJSON` delegate to each guard.
- `lib/runtime/prompt.ts` — replace the inline cost-check loop at lines 189-194 with `for (const g of targetStack.guards) { const err = g.check(); if (err) throw err; }`. Zero variant-specific code.
- `lib/runtime/runner.ts` — see Task 4 (pause on halt, resume on first step after restore, check in shouldSkip).
- `lib/stdlib/thread.ts` — `__internal_pushGuard` takes `(costLimit?, timeLimit?)`, constructs the right `Guard` instance(s), calls `stack.pushGuard`. `__internal_popGuard` calls `stack.popGuard()` once per guard pushed.
- `stdlib/thread.agency` — extend `guard` signature to accept `time:`, extend `GuardFailureData` type.
- `lib/runtime/result.ts` — `__tryCall`'s `GuardExceededError` → Failure conversion branches on `.type` to produce the right `GuardFailureData` shape.
- `docs/site/guide/cost-guards.md` (rename to `guards.md`) — add timeout section, update limitations.

---

## Task 1: Define the `Guard` interface and refactor cost guards onto it

**Files:** `lib/runtime/guard.ts`, `lib/runtime/guard.test.ts`, `lib/runtime/state/stateStack.ts`

This task is a refactor with no behavior change. It's a prerequisite for Task 2 and is independently mergeable.

- [ ] **Step 1.** Define the `Guard` interface as shown in the Design section. Define `GuardExceededError` with `type: "cost" | "time"`.
- [ ] **Step 2.** Implement `CostGuard implements Guard`:

```ts
export class CostGuard implements Guard {
  private costAtPush: number = 0;
  constructor(public readonly costLimit: number) {}

  install(stack: StateStack): void {
    this.costAtPush = stack.localCost;
  }
  uninstall(_stack: StateStack): void { /* nothing */ }
  pause(): void { /* nothing — cost is checked at sync points */ }
  resume(_stack: StateStack): void { /* nothing */ }

  check(stack: StateStack): GuardExceededError | null {
    const spent = stack.localCost - this.costAtPush;
    if (spent > this.costLimit) {
      return new GuardExceededError("cost", this.costLimit, spent);
    }
    return null;
  }

  cloneForBranch(_parentStack: StateStack, childStack: StateStack): Guard {
    // Branch independently accumulates cost; rebase costAtPush onto the
    // child's localCost (which seedBranchCost has already set to the
    // parent's localCost) so the delta math matches the parent's view.
    const g = new CostGuard(this.costLimit);
    g.costAtPush = childStack.localCost;
    return g;
  }

  toJSON() {
    return { kind: "cost", costLimit: this.costLimit, costAtPush: this.costAtPush };
  }
  static fromJSON(j: any): CostGuard {
    const g = new CostGuard(j.costLimit);
    g.costAtPush = j.costAtPush;
    return g;
  }
}
```

- [ ] **Step 3.** Change `lib/runtime/state/stateStack.ts`:
  - Type: `guards: Guard[]` (was `GuardEntry[]`).
  - `pushGuard(g: Guard)`: calls `g.install(this)`, then pushes.
  - `popGuard(): Guard | undefined`: pops, calls `g.uninstall(this)`, returns.
  - `toJSON`: `guards: this.guards.map(g => g.toJSON())`.
  - `fromJSON`: `stateStack.guards = (json.guards ?? []).map(guardFromJSON)`. The deserialized guards are NOT re-`install()`ed — install effects (e.g. composing abort signals) are runtime state and will be re-established by `resume()` at the first runner step (see Task 4).
- [ ] **Step 4.** Change `lib/runtime/prompt.ts` lines 189-194 to:

```ts
for (const g of targetStack.guards) {
  const err = g.check(targetStack);
  if (err) throw err;
}
```

- [ ] **Step 5.** Change `lib/stdlib/thread.ts`:

```ts
export async function __internal_pushGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
  _threads: ThreadStore,
  costLimit: number | undefined,
): Promise<void> {
  if (costLimit === undefined) {
    throw new Error("guard() requires at least one of: cost, time");
  }
  stack.pushGuard(new CostGuard(costLimit));
}

export async function __internal_popGuard(
  _ctx: RuntimeContext<any>,
  stack: StateStack,
): Promise<void> {
  stack.popGuard();
}
```

- [ ] **Step 6.** Run the existing cost-guard tests (`tests/agency/guards/*`, `tests/agency/guard-cost.agency`). Must all pass with zero changes — that's the contract of this refactor.

---

## Task 2: Implement `TimeGuard`

**File:** `lib/runtime/guard.ts`

```ts
export class TimeGuard implements Guard {
  /** Cumulative compute-time ms charged across all (pause, resume) windows. */
  private elapsedMs: number = 0;
  /** Lifecycle state. Pause/resume use this for idempotency so multiple
   *  Runners halting/stepping in the same JS tick don't double-charge or
   *  double-arm. */
  private state: "running" | "paused" = "paused";
  /** performance.now() stamp of the current window's start. Only valid when state === "running". */
  private windowStart: number | undefined = undefined;
  /** AbortController whose .abort() fires when the timer expires. */
  private controller: AbortController | undefined = undefined;
  /** The stack.abortSignal that existed before install — restored by uninstall. */
  private previousSignal: AbortSignal | undefined = undefined;
  /** Node setTimeout handle for the in-process timer. */
  private timerHandle: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Set when the timer fires, read by check() to convert the abort into a typed throw. */
  private tripped: boolean = false;

  constructor(public readonly timeLimit: number) {}

  install(stack: StateStack): void {
    this.installAbortPlumbing(stack);
    this.startWindow();
  }

  uninstall(stack: StateStack): void {
    // Pop-race fix: clear timer FIRST so a late-fire can't trip the
    // outer scope. Then restore the signal so the outer abort plumbing
    // is back in place before the next sync point.
    this.cancelTimer();
    if (this.state === "running") {
      this.elapsedMs += performance.now() - this.windowStart!;
      this.windowStart = undefined;
      this.state = "paused";
    }
    stack.abortSignal = this.previousSignal;
    this.previousSignal = undefined;
    this.controller = undefined;
  }

  pause(): void {
    if (this.state === "paused") return; // idempotent
    this.elapsedMs += performance.now() - this.windowStart!;
    this.windowStart = undefined;
    this.cancelTimer();
    this.state = "paused";
  }

  resume(stack: StateStack): void {
    if (this.state === "running") return; // idempotent
    // After deserialization, controller is undefined — re-establish plumbing.
    if (!this.controller) this.installAbortPlumbing(stack);
    this.startWindow();
  }

  check(_stack: StateStack): GuardExceededError | null {
    if (!this.tripped) return null;
    return new GuardExceededError("time", this.timeLimit, this.elapsedMs);
  }

  cloneForBranch(_parentStack: StateStack, _childStack: StateStack): undefined {
    // Time guards are NOT cloned into branches. The parent's timer is
    // the single source of truth; the abort cascade from
    // composeBranchAbortSignal propagates the trip to every branch's
    // stack.abortSignal. Branches halt silently in their own
    // Runner.shouldSkip (no guard → no throw); control returns to the
    // parent, whose next sync point sees the trip and throws.
    return undefined;
  }

  toJSON() {
    // If we're called while running, charge the in-flight window before
    // serializing so the snapshot reflects all elapsed time.
    const inFlight = this.state === "running"
      ? performance.now() - this.windowStart!
      : 0;
    return { kind: "time", timeLimit: this.timeLimit, elapsedMs: this.elapsedMs + inFlight };
  }
  static fromJSON(j: any): TimeGuard {
    const g = new TimeGuard(j.timeLimit);
    g.elapsedMs = j.elapsedMs;
    // state stays "paused"; resume() at first runner step will re-arm.
    return g;
  }

  private installAbortPlumbing(stack: StateStack): void {
    this.controller = new AbortController();
    this.previousSignal = stack.abortSignal;
    stack.abortSignal = stack.abortSignal
      ? AbortSignal.any([stack.abortSignal, this.controller.signal])
      : this.controller.signal;
    this.controller.signal.addEventListener("abort", () => { this.tripped = true; });
  }

  private startWindow(): void {
    const remaining = this.timeLimit - this.elapsedMs;
    const delay = remaining > 0 ? remaining : 0;
    this.timerHandle = setTimeout(() => this.controller?.abort(), delay);
    this.windowStart = performance.now();
    this.state = "running";
  }

  private cancelTimer(): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
```

- [ ] Add `guardFromJSON` registry entry for `"time"`.
- [ ] Extend `__internal_pushGuard` to accept `timeLimit: number | undefined` and push a `TimeGuard` if non-undefined. If both `costLimit` and `timeLimit` are set, push BOTH. Since this changes the number of stack entries created per `guard(...)` call, return the count from `__internal_pushGuard` and have `__internal_popGuard(count)` pop that many. The agency-level `guard` function threads the count through:

```agency
export def guard(cost: number | null = null,
                 time: number | null = null,
                 block: () => any): Result {
  const n = __internal_pushGuard(cost, time)
  const result = try block()
  __internal_popGuard(n)
  return result
}
```

- [ ] Unit tests for `TimeGuard`:
  - install → stack.abortSignal composed; uninstall restores it.
  - **Idempotency:** calling `pause()` twice charges elapsedMs exactly once; calling `resume()` twice arms the timer exactly once.
  - pause → timer cleared, elapsedMs incremented; resume → timer re-armed with remaining budget.
  - check returns null until controller fires, then returns `GuardExceededError("time", ...)`.
  - toJSON during a live window charges the in-flight delta.
  - fromJSON round-trips elapsedMs and timeLimit; deserialized guard starts in `"paused"` state.
  - `cloneForBranch` returns `undefined` (and a test that fork branches halt via abortSignal cascade without throwing from inside).

---

## Task 3: Convert `GuardExceededError("time", ...)` → Failure

**File:** `lib/runtime/result.ts`

`__tryCall` already catches `GuardExceededError` for cost guards. Extend it:

- [ ] On catching a `GuardExceededError`, branch on `e.type`:
  - `"cost"` → existing shape (`type: "costFailure"`, `maxCost`, `actualCost`).
  - `"time"` → new shape (`type: "timeoutFailure"`, `maxTime`, `actualTime`).

That's the only variant-specific spot outside the `Guard` classes themselves.

---

## Task 4: Runner hooks (pause / resume / check)

**File:** `lib/runtime/runner.ts`

The runner is the natural place to detect halt/resume boundaries. Keep it declarative — three one-liners that call into the interface. Because `pause()` and `resume()` are idempotent on the guard itself (via the `state` field on `TimeGuard`; trivially on `CostGuard`), we don't need any per-Runner bookkeeping.

- [ ] In `Runner.halt(result)`: call `this.stack?.guards.forEach(g => g.pause());` BEFORE setting `this.halted = true` (so the elapsed delta is captured before the halt propagates). Multiple Runners halting in sequence as an interrupt bubbles up will all call pause; only the first does work, the rest no-op.

- [ ] In `Runner.step(id, callback)`: at the very top, before any other logic:

```ts
this.stack?.guards.forEach(g => g.resume(this.stack!));
```

That's it. Every step call invokes resume; the first one after a halt or fresh deserialization actually does work, all subsequent ones no-op.

- [ ] Same one-liner at the top of `Runner.hook`, `Runner.pipe`, `Runner.thread`, `Runner.fork`, and `Runner.debugger` — anywhere a step-equivalent entry point exists. Alternative: hoist into a `Runner.beforeStep()` helper called by each. Pick whichever has the smaller diff.

- [ ] In `Runner.shouldSkip()`: after the existing `stack?.abortSignal?.aborted` check, walk `stack.guards`. If any returns a `GuardExceededError` from `check()`, throw it. Otherwise fall through to the existing halt behavior (so race-loser branch cancels still halt silently).

```ts
private shouldSkip(): boolean {
  if (this.stack?.abortSignal?.aborted && !this.halted) {
    for (const g of this.stack.guards) {
      const err = g.check(this.stack);
      if (err) throw err;
    }
    this.halt(undefined);
  }
  return this.halted || this._break || this._continue;
}
```

- [ ] Update `Runner.seedBranchCost` ([line 235](../../lib/runtime/runner.ts#L235)): replace `branchStack.guards = parentStack.guards.map((g) => ({ ...g }));` with:

```ts
branchStack.guards = parentStack.guards
  .map(g => g.cloneForBranch(parentStack, branchStack))
  .filter((g): g is Guard => g !== undefined);
```

The POJO spread was correct for the old `GuardEntry` records but breaks for class-based guards (no methods on the copy, AbortControllers shared). Delegating to `cloneForBranch` lets each guard variant decide: `CostGuard` returns a fresh clone with `costAtPush` rebased onto the child's `localCost`; `TimeGuard` returns `undefined` (parent's timer + abort cascade is sufficient — see the Concurrency interactions table). The `filter` drops the undefineds so branches see a sparser-than-parent guards list.

---

## Task 5: Stdlib surface

**File:** `stdlib/thread.agency`

- [ ] Extend `GuardFailureData`:

```agency
export type GuardFailureData = {
  type: string,        // "costFailure" | "timeoutFailure"
  maxCost?: number,
  actualCost?: number,
  maxTime?: number,    // ms (canonical)
  actualTime?: number, // ms (canonical)
}
```

- [ ] Extend `guard` to accept `time:` and call the updated `__internal_pushGuard`/`__internal_popGuard` pair (see Task 2's signature change to thread a `count`).

**File:** `lib/codegenBuiltins/contextInjected.ts`

- [ ] Update `__internal_pushGuard` and `__internal_popGuard` arities to match.

---

## Task 6: Documentation

**File:** `docs/site/guide/cost-guards.md` (rename to `docs/site/guide/guards.md`)

- [ ] Add a "Timeout" section showing `guard(time: 30s) as { ... }` and the new `GuardFailureData` fields.
- [ ] Add "Combining cost and time" showing `guard(cost: $2, time: 60s) as { ... }`.
- [ ] Add a "Forks, parallel, and message threads" section covering the three cases:
  - **`fork` / `race` / `parallel`**: Both cost and time guards work. CostGuards are cloned per-branch (each branch's spend is checked independently). TimeGuards rely on abort propagation — when the parent's timer fires, the parent aborts every in-flight branch.
  - **`thread { ... }` / `subthread { ... }`**: These isolate *message history* but NOT cost or abort plumbing. A guard wrapping a thread block sees every LLM call inside it, just as it would without the block. If you want per-thread cost limits, you need to either wrap each thread in its own `guard(...)` or use a fork to get a fresh `StateStack`.
  - **`goto`** isn't allowed inside any block, including a guard block.
- [ ] Update "Limitations":
  - **JS-bodied tool calls cannot be aborted mid-execution.** The tool runs to completion in the background, but its result is discarded once the timeout has fired. Long-term plan: opt-in cancellation by reading `state.stateStack.abortSignal` (currently only internal tools do this).
  - Cost-fork limitation unchanged: an outer cost guard around a fork sees the fork's accumulated cost only at fork-join, not mid-flight.
- [ ] Promote the V2 sketch in the current "What about timeouts?" section to a "Now supported" link to the new Timeout section.

---

## Validation

- [ ] **Task 1 refactor**: all existing cost-guard tests pass with no changes.
- [ ] **Task 2 unit tests**: `pnpm test:run lib/runtime/guard.test.ts`.
- [ ] **End-to-end agency tests**: `pnpm test:run tests/agency/guards/`.
- [ ] Manual smoke test:
  - 100ms time limit wrapping an LLM call that takes >100ms → `type: "timeoutFailure"`, populated `maxTime`/`actualTime`.
  - 5s time limit, block interrupts after 1s, resumes 30s later, runs 1s more → NO trip (only 2s of compute time).
  - Both limits, cost trips first → `type: "costFailure"`.
  - Fork where each branch's Agency tool runs for >limit → all branches halt at the next runner step boundary after the timer fires.
- [ ] `make` succeeds (regen stdlib).
- [ ] `pnpm run lint:structure` passes.

---

## Out of scope (V3 follow-ups)

- Cancelling user-written JS tool bodies. Requires user opt-in to read `state.stateStack.abortSignal`. Tracked separately.
- Streaming-LLM cancellation correctness (worth a one-line verification that `ctx.llmClient.textStream(promptConfig)` honors `promptConfig.abortSignal`).
- Mid-fork time propagation (same shape as the mid-fork cost-propagation limitation).
- Depth guards (call/round limits) — would slot in as a third `Guard` class with the same shape.
- Richer partial-result data on trip.
