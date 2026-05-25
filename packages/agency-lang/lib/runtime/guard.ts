import type { StateStack } from "./state/stateStack.js";

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
 *   - `TimeGuard` returns `undefined` — the parent's timer is the
 *     single source of truth; abort cascade via the composed
 *     `stack.abortSignal` propagates the trip to every branch's
 *     Runner.shouldSkip without an independent guard entry.
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
   *  enforcement). TimeGuard returns `undefined` (abort cascades via
   *  stack.abortSignal — no per-branch guard needed). Future guards
   *  may return a fresh clone if they want per-branch isolation. */
  cloneForBranch(
    parentStack: StateStack,
    childStack: StateStack,
  ): Guard | undefined;
  toJSON(): GuardJSON;
};

/** Discriminated-union JSON shape. `guardFromJSON` dispatches on `kind`. */
export type GuardJSON =
  | { kind: "cost"; costLimit: number; spent: number }
  | { kind: "time"; timeLimit: number; elapsedMs: number };

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
    return new GuardExceededError("cost", this.costLimit, this.spent);
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
    };
  }

  static fromJSON(j: { costLimit: number; spent: number }): CostGuard {
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
 * Fork/race branches: NOT cloned (`cloneForBranch` returns
 * `undefined`). The parent's timer is the single source of truth; the
 * abort cascade from `composeBranchAbortSignal` propagates the trip
 * to every branch's `stack.abortSignal`. Branches halt silently in
 * their own `Runner.shouldSkip` (no guard present → no throw), and
 * the parent's next sync point sees its own TimeGuard's
 * `tripped === true` and throws `GuardExceededError("time", ...)`.
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
    // Charge any in-flight window delta so `spent` reflects the
    // true elapsed time at the moment of the trip. Without this,
    // checking inside an active window (the common case — abort
    // fires during a sleep / LLM call, runner steps next) would
    // report `elapsedMs === 0` because no pause has happened.
    const inFlight =
      this.state === "running"
        ? performance.now() - this.windowStart!
        : 0;
    this.consumed = true;
    return new GuardExceededError(
      "time",
      this.timeLimit,
      this.elapsedMs + inFlight,
    );
  }

  isTripped(): boolean {
    return this.tripped;
  }

  cloneForBranch(
    _parentStack: StateStack,
    _childStack: StateStack,
  ): undefined {
    return undefined;
  }

  toJSON(): GuardJSON {
    // If we're called while running, charge the in-flight window
    // before serializing so the snapshot reflects all elapsed time.
    const inFlight =
      this.state === "running"
        ? performance.now() - this.windowStart!
        : 0;
    return {
      kind: "time",
      timeLimit: this.timeLimit,
      elapsedMs: this.elapsedMs + inFlight,
    };
  }

  static fromJSON(j: { timeLimit: number; elapsedMs: number }): TimeGuard {
    const g = new TimeGuard(j.timeLimit);
    g.elapsedMs = j.elapsedMs;
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
    this.timerHandle = setTimeout(
      () => this.controller?.abort(),
      delay,
    );
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
export class GuardExceededError extends Error {
  constructor(
    public readonly type: "cost" | "time",
    public readonly limit: number,
    public readonly spent: number,
  ) {
    super(`guard exceeded: ${type} limit ${limit}, spent ${spent}`);
    this.name = "GuardExceededError";
  }
}

export function isGuardExceededError(e: unknown): e is GuardExceededError {
  return e instanceof GuardExceededError;
}
