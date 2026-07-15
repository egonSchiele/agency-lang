import type { StateStack } from "./state/stateStack.js";
import { AgencyAbort, AgencyCancelledError, makeAbortCause } from "./errors.js";

/** Monotonic source of stable per-guard ids. Threaded into the
 *  `guardTrip` AbortCause a TimeGuard emits so boundaries can identify
 *  which guard tripped. NOTE: in Increment 1 no boundary actually
 *  MATCHES on this id — `__tryCall` converts any guardTrip cause it
 *  catches, relying on structural call-stack nesting to route a trip to
 *  its owning `try` (exactly as cost guards do today). Real id-matching
 *  (which would fix outer-tighter-than-inner mis-attribution; see
 *  tests/agency/guards/guard-time-nested-outer-tighter) needs threading
 *  the id into `__tryCall` — a codegen change deferred to Increment 2.
 *  The id is emitted now so the cause shape is stable for that work. */
let __guardIdCounter = 0;
export function nextGuardId(): string {
  __guardIdCounter += 1;
  return `g${__guardIdCounter}`;
}

/**
 * Per-guard scope state for cost / time limits. Held on
 * `StateStack.guards` as an array; `pushGuard` appends + calls
 * `install`, `popGuard` removes + calls `uninstall`. Serialized with
 * the rest of the stack via `toJSON` / `guardFromJSON` so guards
 * survive interrupt + resume cycles.
 *
 * The interface keeps per-variant logic (cost vs time) inside the
 * implementing class. `StateStack` and `Runner` only ever talk to the
 * interface — no `instanceof` checks, no variant-specific branching.
 *
 * Lifecycle in execution order:
 *   1. `install(stack)`  — on push. May mutate the stack
 *      (e.g. compose an AbortController into `stack.abortSignal`).
 *   2. `resume(stack)`   — at every Runner step entry; idempotent.
 *      First call after a halt or fresh deserialize actually arms
 *      timers / rebuilds runtime state, subsequent calls are no-ops.
 *   3. `pause()`         — on Runner.halt; idempotent.
 *   4. `check(stack)`    — at every LLM-cost-accumulation site and
 *      inside `Runner.shouldSkip`; returns the trip error or null.
 *   5. `uninstall(stack)` — on pop. Must undo whatever install() did.
 *
 * `cloneForBranch` lets each variant decide whether a fork/race
 * branch needs an independent copy:
 *   - `CostGuard` returns `this` (a shared in-memory reference). The
 *     parent's guard appears on every descendant branch's `guards`
 *     array via `StateStack.rehydrateInheritedGuardsFrom`, so a
 *     `charge()` from any branch mutates the same counter the parent
 *     and siblings see — real-time mid-fork enforcement.
 *   - `TimeGuard` returns a fresh per-branch clone carrying the
 *     parent's REMAINING budget and the parent's guardId. The parent
 *     pauses for the duration of the fork region (runBatch delegates
 *     enforcement to the clones) and advances by the max clone
 *     working time at the final join.
 *
 * `toJSON` serializes ONLY persistent state — runtime fields
 * (AbortControllers, setTimeout handles, performance.now() stamps)
 * are NOT included. They're re-established by `resume()` at the first
 * runner step after deserialization.
 */
export type Guard = {
  install(stack: StateStack): void;
  uninstall(stack: StateStack): void;
  pause(): void;
  resume(stack: StateStack): void;
  /** Record a per-event delta against this guard. Called from
   *  prompt.ts immediately after each LLM call's cost is known. Most
   *  guards (e.g. TimeGuard) ignore charges and derive their state
   *  from other sources; CostGuard mutates its own `spent` counter
   *  here. */
  charge(amount: number): void;
  check(stack: StateStack): GuardExceededError | null;
  /** True iff this guard's limit has been exceeded — even if `check`
   *  has already returned the trip once. Lets `Runner.shouldSkip`
   *  distinguish a still-aborted signal that originated from a
   *  guard's own controller (already consumed by user code via the
   *  stdlib `guard`'s `try`) from an external abort like a race
   *  loser. Without this distinction, popping a tripped guard would
   *  re-throw on every sync point. */
  isTripped(): boolean;
  /** Return a guard reference for the given child branch.
   *  CostGuard returns `this` (shared in-memory object — child charges
   *  the same counter the parent sees, enabling real-time mid-fork
   *  enforcement). TimeGuard returns a remaining-budget clone with the
   *  parent's guardId (per-branch working-time isolation; the parent
   *  pauses across the fork and charges max clone time at the join). */
  cloneForBranch(
    parentStack: StateStack,
    childStack: StateStack,
  ): Guard | undefined;
  toJSON(): GuardJSON;
};

/** Discriminated-union JSON shape. `guardFromJSON` dispatches on `kind`.
 *  `guardId` is serialized so it survives interrupt/resume: a guard's
 *  `try` boundary matches on it (ownedGuardIds), and the boundary's id list
 *  is checkpointed too — if the guard got a fresh id on resume they would no
 *  longer match and the trip would escape its guard. */
export type GuardJSON =
  | { kind: "cost"; costLimit: number; spent: number; guardId?: string }
  | { kind: "time"; timeLimit: number; elapsedMs: number; guardId?: string };

/**
 * Cost guard. Trips when its own `spent` counter exceeds `costLimit`.
 *
 * Unlike the previous design (which derived spent from
 * `stack.localCost - costAtPush`), the guard now owns its accumulator
 * directly. Every LLM-cost site walks `stack.guards` and calls
 * `guard.charge(cost)` on each one — including any shared parent guards
 * that were inherited by a child branch (see `cloneForBranch` below).
 *
 * `cloneForBranch` returns `this` — the same in-memory JS object. The
 * child branch's `stack.guards` then holds a *reference* to the parent's
 * CostGuard. Any charge from inside a child branch updates the same
 * counter the parent and all sibling branches see. Single-threaded JS
 * makes the increment race-free. This is what makes real-time mid-fork
 * trip detection work: when a charge pushes total spend over the limit,
 * the next `check()` from any descendant returns the trip — no waiting
 * for the fork to settle.
 *
 * CostGuard does NOT install an `AbortController` (unlike `TimeGuard`).
 * A sibling branch that's mid-LLM-call won't be cancelled the instant
 * another branch trips the shared guard — its smoltalk request will
 * run to completion, then its post-call check will see the over-limit
 * counter and throw. Mid-flight cancellation could be added by mirroring
 * `TimeGuard`'s abort plumbing, but that breaks the same-stack nested-
 * guard semantic ("inner trip should not retroactively trip the outer
 * via a stale abort signal" — see guard-nested-iteration-order.agency).
 * The pre-call gate in `prompt.ts` already catches "we're already
 * over budget" before issuing the next request, which is the more
 * important optimization.
 *
 * `check` is intentionally NOT idempotent across calls: every check
 * returns the trip if `spent > costLimit`. The trip propagates exactly
 * once per stack because the user's `try block()` catches it and then
 * the guard is popped (removed from `stack.guards`), so subsequent
 * stack-walks don't include it. A sibling stack still holding a
 * reference to the same shared guard WILL see the trip on its next
 * check — which is exactly what we want.
 *
 * `pause` / `resume` / `uninstall` are no-ops because there's no
 * in-process timer or signal plumbing to manage. The counter is
 * durable through serialization via `spent` in `toJSON`.
 */
export class CostGuard implements Guard {
  /** Cumulative cost charged since install. Serialized; survives
   *  interrupt/resume cycles. */
  private spent: number = 0;

  /** Stable id threaded into the emitted `guardTrip` cause so a boundary
   *  can identify which guard tripped (C2 ownedGuardIds matching). Not
   *  `readonly` so `fromJSON` can restore the serialized id (the id must
   *  survive interrupt/resume — see GuardJSON). */
  guardId: string = nextGuardId();

  constructor(public readonly costLimit: number) {}

  install(_stack: StateStack): void {
    /* nothing — no abort controller, no signal composition */
  }

  uninstall(_stack: StateStack): void {
    /* nothing */
  }

  pause(): void {
    /* nothing — cost is checked at sync points */
  }

  resume(_stack: StateStack): void {
    /* nothing */
  }

  charge(amount: number): void {
    this.spent += amount;
  }

  check(_stack: StateStack): GuardExceededError | null {
    if (this.spent <= this.costLimit) return null;
    return new GuardExceededError("cost", this.costLimit, this.spent, this.guardId);
  }

  /** CostGuards don't compose into `stack.abortSignal`, so they can't
   *  be the cause of a stuck abort. Always returns false — the
   *  isTripped check in `Runner.shouldSkip` is for guards (like
   *  TimeGuard) that own their abort controller. */
  isTripped(): boolean {
    return false;
  }

  /** Shared reference, not a clone. The child branch's guards array
   *  holds this same object; any charge from the child mutates the
   *  counter the parent and siblings see in real time. */
  cloneForBranch(_parentStack: StateStack, _childStack: StateStack): Guard {
    return this;
  }

  toJSON(): GuardJSON {
    return {
      kind: "cost",
      costLimit: this.costLimit,
      spent: this.spent,
      guardId: this.guardId,
    };
  }

  static fromJSON(j: { costLimit: number; spent: number; guardId?: string }): CostGuard {
    // Clean break with the prior `{costAtPush}` JSON shape: refuse to
    // restore a guard whose `spent` is missing rather than silently
    // initializing it to NaN/undefined and producing nonsense trips.
    // Older checkpoints from the per-branch-clone era are not
    // supported by this binary — re-run from scratch.
    if (typeof j.spent !== "number") {
      throw new Error(
        `CostGuard.fromJSON: missing or invalid 'spent' field ` +
          `(got ${JSON.stringify(j.spent)}). This checkpoint may have ` +
          `been written by a pre-shared-cost-guards version of the ` +
          `runtime; that format is no longer supported.`,
      );
    }
    const g = new CostGuard(j.costLimit);
    g.spent = j.spent;
    // Restore the serialized id so ownedGuardIds matching survives resume.
    // (Absent only in pre-Increment-2 checkpoints; keep the freshly-minted
    // id in that case.)
    if (j.guardId !== undefined) g.guardId = j.guardId;
    return g;
  }
}

/**
 * Time guard. Trips when the cumulative compute-time spent inside the
 * guarded scope exceeds `timeLimit` (milliseconds). "Compute-time"
 * means wall-clock time while a Runner is actively executing — time
 * spent paused on an interrupt does NOT count. On checkpoint resume,
 * the timer is re-armed with `(timeLimit - elapsedMs)`.
 *
 * Mechanism: install() creates an AbortController and composes its
 * signal into `stack.abortSignal`. A `setTimeout` fires
 * `controller.abort()` when the budget elapses. Smoltalk already
 * honors `stack.abortSignal` via `ctx.getAbortSignal()`, so in-flight
 * LLM calls cancel; `Runner.shouldSkip` already halts on it, so
 * Agency tool bodies stop at the next step boundary. (JS-bodied tool
 * calls cannot be aborted mid-execution in V1 — documented.)
 *
 * Fork/race branches: each branch gets its OWN clone via
 * `cloneForBranch` — remaining budget, parent's guardId, independent
 * pause state and abort controller. runBatch pauses the parent's
 * timer at fork entry (enforcement is delegated to the clones so a
 * branch's input-wait pauses only that branch's clock) and advances
 * the parent by the max clone working time at the final value join.
 * A clone's trip aborts only its branch's composed signal; the trip
 * error carries the parent's guardId, so the outer guard boundary's
 * `try` owns it exactly like a shared CostGuard trip.
 *
 * Idempotency: `pause()` / `resume()` use the `state` field so
 * multiple Runners halting/stepping in the same JS tick don't
 * double-charge `elapsedMs` or double-arm the timer.
 */
export class TimeGuard implements Guard {
  /** Cumulative compute-time ms charged across all (pause, resume) windows. */
  private elapsedMs: number = 0;
  /** Lifecycle state. Pause/resume use this for idempotency so
   *  multiple Runners halting/stepping in the same JS tick don't
   *  double-charge or double-arm. Starts paused — install() flips to
   *  running via startWindow(). */
  private state: "running" | "paused" = "paused";
  /** performance.now() stamp of the current window's start. Only
   *  valid when state === "running". */
  private windowStart: number | undefined = undefined;
  /** AbortController whose .abort() fires when the timer expires. */
  private controller: AbortController | undefined = undefined;
  /** The `stack.abortSignal` that existed before install — restored
   *  by uninstall so the outer abort plumbing comes back unchanged. */
  private previousSignal: AbortSignal | undefined = undefined;
  /** Node setTimeout handle for the in-process timer. */
  private timerHandle: ReturnType<typeof setTimeout> | undefined = undefined;
  /** Set when the abort signal fires. Read by check() to convert the
   *  silent abort into a typed throw at the next sync point. */
  private tripped: boolean = false;
  /** Set after `check()` returns the trip error once. Subsequent
   *  `check()` calls return null so the trip propagates exactly once
   *  to the stdlib `guard`'s `try`. `isTripped()` keeps returning
   *  true so `Runner.shouldSkip` knows the still-aborted signal is
   *  ours (already-consumed) and doesn't silent-halt the cleanup
   *  steps (popGuard) on its way out. */
  private consumed: boolean = false;

  /** Stable id threaded into the emitted `guardTrip` cause. Not `readonly`
   *  so `fromJSON` can restore the serialized id across interrupt/resume
   *  (see GuardJSON — the id must outlive a checkpoint or ownedGuardIds
   *  matching breaks). */
  guardId: string = nextGuardId();

  constructor(public readonly timeLimit: number) {}

  install(stack: StateStack): void {
    this.installAbortPlumbing(stack);
    this.startWindow();
  }

  uninstall(stack: StateStack): void {
    // Pop-race fix: clear timer FIRST so a late-fire can't trip the
    // outer scope. Then restore the signal so the outer abort
    // plumbing is back in place before the next sync point. Even if
    // setTimeout's callback is already queued, abortController is
    // about to be released and stack.abortSignal no longer references
    // our composed signal.
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
    if (this.state === "paused") return;
    this.elapsedMs += performance.now() - this.windowStart!;
    this.windowStart = undefined;
    this.cancelTimer();
    this.state = "paused";
  }

  resume(stack: StateStack): void {
    if (this.state === "running") return;
    // After deserialization, controller is undefined — re-establish
    // plumbing. (toJSON only serializes elapsedMs + timeLimit.)
    if (!this.controller) this.installAbortPlumbing(stack);
    this.startWindow();
  }

  charge(_amount: number): void {
    /* nothing — TimeGuard accumulates wall-clock time, not LLM cost */
  }

  check(_stack: StateStack): GuardExceededError | null {
    if (!this.tripped || this.consumed) return null;
    // currentElapsed() charges any in-flight window delta so `spent`
    // reflects the true elapsed time at the moment of the trip. Without
    // this, checking inside an active window (the common case — abort
    // fires during a sleep / LLM call, runner steps next) would
    // report `elapsedMs === 0` because no pause has happened.
    this.consumed = true;
    return new GuardExceededError(
      "time",
      this.timeLimit,
      this.currentElapsed(),
      this.guardId,
    );
  }

  isTripped(): boolean {
    return this.tripped;
  }

  /** Accrued working time plus any in-flight running window, in ms. */
  private currentElapsed(): number {
    return (
      this.elapsedMs +
      (this.state === "running" && this.windowStart !== undefined
        ? performance.now() - this.windowStart
        : 0)
    );
  }

  /** Public read of currentElapsed() for the runBatch join accounting:
   *  the parent advances by the max of its branch clones' snapshots. */
  snapshotElapsed(): number {
    return this.currentElapsed();
  }

  /** Advance the accumulator without a running window. runBatch calls
   *  this on the PARENT guard at a fork's final value join, with the
   *  max of the branch clones' working time — the parallel region's
   *  contribution to this causal path. */
  addElapsed(ms: number): void {
    this.elapsedMs += ms;
  }

  cloneForBranch(
    _parentStack: StateStack,
    _childStack: StateStack,
  ): Guard {
    // Wall-clock time is not cumulative across parallel branches, so each
    // branch gets its OWN timer. It inherits the parent's REMAINING budget
    // at fork time (floored at 1ms, so "parent work, then branch" cannot
    // exceed the original budget) and the parent's guardId, so a trip
    // inside the branch is owned by the same guard boundary's try —
    // mirroring how a shared CostGuard's trips match ownedGuardIds. Each
    // branch pauses/resumes independently; resume() on the child stack
    // arms the fresh timer at the branch's first runner step.
    const remaining = Math.max(1, this.timeLimit - this.currentElapsed());
    const clone = new TimeGuard(remaining);
    clone.guardId = this.guardId;
    return clone;
  }

  toJSON(): GuardJSON {
    // currentElapsed() charges the in-flight window if we're called
    // while running, so the snapshot reflects all elapsed time.
    return {
      kind: "time",
      timeLimit: this.timeLimit,
      elapsedMs: this.currentElapsed(),
      guardId: this.guardId,
    };
  }

  static fromJSON(j: { timeLimit: number; elapsedMs: number; guardId?: string }): TimeGuard {
    const g = new TimeGuard(j.timeLimit);
    g.elapsedMs = j.elapsedMs;
    // Restore the serialized id so ownedGuardIds matching survives resume.
    if (j.guardId !== undefined) g.guardId = j.guardId;
    // state stays "paused"; resume() at first runner step re-arms.
    return g;
  }

  private installAbortPlumbing(stack: StateStack): void {
    this.controller = new AbortController();
    this.previousSignal = stack.abortSignal;
    stack.abortSignal = stack.abortSignal
      ? AbortSignal.any([stack.abortSignal, this.controller.signal])
      : this.controller.signal;
    this.controller.signal.addEventListener("abort", () => {
      this.tripped = true;
    });
  }

  private startWindow(): void {
    const remaining = this.timeLimit - this.elapsedMs;
    const delay = remaining > 0 ? remaining : 0;
    this.timerHandle = setTimeout(() => {
      // Abort WITH a structured cause so any in-flight leaf op (sleep,
      // fetch, …) listening on the composed signal rejects carrying the
      // guard trip — not a bare cancel that the guard's `try` boundary
      // can't recognize and would let escape as an unhandled rejection.
      const spent = this.elapsedMs +
        (this.windowStart !== undefined
          ? performance.now() - this.windowStart
          : 0);
      // Abort with an AgencyCancelledError that CARRIES the structured
      // cause. Keeping `signal.reason` an Error (not a bare object) means
      // a `throw signal.reason` site — e.g. runBatch's race-loser path —
      // still throws an Error; `readCause` digs the cause back out.
      this.controller?.abort(
        new AgencyCancelledError(
          `guard exceeded: time limit ${this.timeLimit}`,
          makeAbortCause({
            kind: "guardTrip",
            dimension: "time",
            limit: this.timeLimit,
            spent,
            guardId: this.guardId,
          }),
        ),
      );
    }, delay);
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

/** Dispatch a serialized guard back to its class instance. Add a case
 *  per new guard variant. */
export function guardFromJSON(json: GuardJSON): Guard {
  switch (json.kind) {
    case "cost":
      return CostGuard.fromJSON(json);
    case "time":
      return TimeGuard.fromJSON(json);
    default: {
      // Fail loudly rather than returning undefined (which would
      // surface as a downstream "cannot read properties of undefined"
      // far from the source). Hit if a checkpoint serialized a guard
      // kind that the current binary doesn't know how to deserialize
      // (e.g. forward-compat with a future "depth" guard).
      const k: string = (json as { kind: string }).kind;
      throw new Error(`Unknown guard kind in checkpoint: ${k}`);
    }
  }
}

/**
 * Thrown by `prompt.ts` immediately after an LLM call's cost is
 * accumulated, and by `Runner.shouldSkip` when a time guard's abort
 * signal has fired. Propagates as a normal JS error through the call
 * stack; the `guard` stdlib function's `try` catches it and returns a
 * Failure with the structured `GuardFailureData` shape.
 *
 * Deliberately not an interrupt — see
 * `docs/superpowers/specs/2026-05-20-cost-and-guard-tracking-design.md`
 * sections "Mechanism" and "Layer 2: stdlib function".
 */
export class GuardExceededError extends AgencyAbort {
  constructor(
    public readonly type: "cost" | "time",
    public readonly limit: number,
    public readonly spent: number,
    // A real guardId is load-bearing for Increment-2 ownedGuardIds matching:
    // a GuardExceededError built WITHOUT one carries guardId === "" and, once
    // __tryCall filters on ownedGuardIds, would fail the membership check and
    // escape its own guard. CostGuard.check / TimeGuard.check pass their id.
    guardId: string = "",
  ) {
    super(
      `guard exceeded: ${type} limit ${limit}, spent ${spent}`,
      makeAbortCause({ kind: "guardTrip", dimension: type, limit, spent, guardId }),
    );
    this.name = "GuardExceededError";
  }
}

export function isGuardExceededError(e: unknown): e is GuardExceededError {
  return e instanceof GuardExceededError;
}
