import type { StateStack } from "./state/stateStack.js";
import { AgencyAbort, AgencyCancelledError, makeAbortCause, readCause } from "./errors.js";
import { Clock, realClock, TimerHandle } from "./clock.js";
import { __ctx } from "./asyncContext.js";

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

/** Clamp a budget grant at zero, warning on negatives. A handler that
 *  computes `approve({maxCost: budget - spent})` and goes negative must
 *  not silently REMOVE metering (negative-as-disable is a construction-
 *  time convention only; in the additive approve channel it would be
 *  fail-open on a cost-control feature). Disarming is explicit:
 *  `approve({disarm: ["cost"]})`. */
function clampGrant(
  delta: number,
  g: { dimension: "cost" | "time"; label?: string },
): number {
  if (delta >= 0) return delta;
  console.warn(
    `guard grant clamped to 0: a negative ${g.dimension} grant` +
      `${g.label ? ` for guard "${g.label}"` : ""} (${delta}) does not ` +
      `disarm the guard — use approve({disarm: ["${g.dimension}"]}) to ` +
      `stop metering explicitly.`,
  );
  return 0;
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
 * (AbortControllers, timer handles, monotonic clock stamps)
 * are NOT included. They're re-established by `resume()` at the first
 * runner step after deserialization.
 */
export type Guard = {
  /** Stable serialized identity — see GuardJSON. Both variants carry it;
   *  it is on the interface because handler scoping and ownedGuardIds
   *  matching are identity-based (indices do not survive resume/fork). */
  guardId: string;
  /** Which budget dimension this guard meters. On the interface so call
   *  sites never need instanceof or a JSON round-trip (the interface
   *  contract above forbids variant branching at call sites). Mirrors
   *  GuardJSON's `kind` discriminator. */
  readonly dimension: "cost" | "time";
  /** The guardIds of every member of this guard's SCOPE — the pair (or
   *  singleton) one Agency-level `guard(...)` call pushed. `guard(cost:,
   *  time:)` is TWO runtime guards; the scope array is how either member
   *  finds its sibling. Stamped by `_pushGuard`; serialized (a trip's
   *  interrupt data carries it across checkpoints); hand-copied in
   *  TimeGuard.cloneForBranch (serialization and cloning are different
   *  paths). Empty for guards pushed outside `_pushGuard` (root budgets,
   *  `agency.withCostGuard`) — GuardScope.resolve treats an empty array
   *  as a single-member scope. */
  scopeIds: string[];
  /** True for the operator's --max-cost/--max-time guards. Root budgets
   *  never raise interrupts (they keep throwing at detection sites) and
   *  a GuardScope containing one refuses extension: user code cannot
   *  approve its way past the operator. Serialized — if it dropped on
   *  resume, root budgets would become approvable after a checkpoint. */
  isRootBudget: boolean;
  /** Grant additional budget: limit += max(0, delta). A NEGATIVE delta
   *  clamps to zero with a runtime warning — a computed grant that goes
   *  negative must never silently remove metering (that is what disarm
   *  is for, and it is explicit). Re-arms the tripped latches so the
   *  guard can trip again at the new limit; missing that reset is
   *  fail-open (a guard that never trips again), the worse direction. */
  extendBudget(delta: number): void;
  /** Stop metering this dimension permanently. Serialized. A disarmed
   *  guard's check() never trips and isTripped() reports false even if
   *  it tripped before disarming. */
  disarm(): void;
  /** True while the guard is over budget AND still armed — the state a
   *  useless approval leaves behind. GuardScope's livelock check reads
   *  it after applying an answer: an answer that leaves the tripped
   *  dimension in this state would re-trip forever and is a runtime
   *  error attributed to the answering handler. */
  overBudgetAndArmed(): boolean;
  /** True when this guard's trip was already DELIVERED through the
   *  leaf path (an in-flight op rejected with the cause and __tryCall
   *  converted it to a Failure the user saw). A delivered trip is
   *  handled — the step-boundary raise must not turn it into a second
   *  question, and shouldSkip already lets cleanup steps run past it. */
  deliveredTrip(): boolean;
  /** True when this guard has a live, unhandled trip the runner's
   *  step-boundary raise should ask about right now. Stack-level
   *  suspension is the stack's business (firstRaisableTrip consults
   *  suspendedGuardIds); everything the guard itself knows — armed,
   *  over budget, not yet consumed by a check() walk, not yet
   *  delivered to a boundary — lives here. CostGuard always declines:
   *  cost only ripens at paid actions, and every paid action already
   *  sits behind a PromptRunner guard gate. Raising cost at arbitrary
   *  step boundaries would re-ask questions the gates settled and,
   *  worse, deliver a reject at a step OUTSIDE the owning guard
   *  boundary, where nothing converts it to a Failure. */
  raisableTripAtStep(): boolean;
  /** An open trip question for this guard, while one is being decided.
   *  LIVE-ONLY (never serialized) and meaningful only for guards shared
   *  across branches (cost): a sibling branch detecting the same guard
   *  over budget parks on `settled` instead of asking its own question.
   *  Time clones are per-branch objects, so for them this is always
   *  undefined — cost-only dedupe, by construction, on purpose. Set
   *  and cleared exclusively by guardTripInterrupt.ts. */
  pendingTrip?: { settled: Promise<void>; settle: () => void };
  /** The current limit and spend in this guard's own unit (dollars /
   *  ms). On the interface for the trip interrupt's snapshot and the
   *  derived trip key — both must read them without variant branching. */
  currentLimit(): number;
  spentAmount(): number;
  /** User-facing name from guard(label:). */
  readonly label?: string;
  /** This guard's own cancellation signal, when it is armed. The stack
   *  DERIVES its composed abortSignal from these (rebuildAbortSignal) —
   *  guards never mutate stack.abortSignal directly. Undefined for
   *  guards with no abort plumbing (cost), disarmed guards, and a
   *  fired-then-approved guard whose dead controller awaits its re-mint
   *  (an aborted controller must not poison the fresh composite). A
   *  TRIPPED-and-unanswered guard still returns its (aborted) signal:
   *  the trip is live and the composite must reflect it. */
  armedSignal(): AbortSignal | undefined;
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
  /** While suspended, a guard is invisible to enforcement: `check()`
   *  returns null, `charge()` is a no-op, and (TimeGuard) the working-
   *  time clock is paused. Used while an interrupt HANDLER runs: a
   *  handler's own work is metered by its registration site's guards,
   *  never by guards installed deeper (see HandlerEntry.liveGuardIds).
   *  `resume()` DOES NOT clear suspension — `Runner.beforeStep`
   *  resumes every guard at every step entry, and a handler body
   *  executes steps; without this rule the handler's first step would
   *  silently un-suspend the guard and restart its clock. Only
   *  `unsuspend()` clears it. NEVER serialized: a handler that
   *  propagates gets checkpointed mid-suspension, and a suspended
   *  flag riding the snapshot would resume the run permanently
   *  unmetered. */
  suspend(): void;
  unsuspend(): void;
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
type GuardJSONBase = {
  guardId?: string;
  label?: string;
  /** See Guard.scopeIds. */
  scopeIds?: string[];
  /** See Guard.disarm — MUST serialize (a disarmed dimension staying
   *  disarmed across resume is the user's explicit decision). Contrast
   *  with suspension, which must NEVER serialize; the two fail in
   *  opposite directions. */
  disarmed?: boolean;
  /** See Guard.isRootBudget — MUST serialize (a root budget that became
   *  approvable after a checkpoint would be a hole in the operator's
   *  ceiling). */
  isRootBudget?: boolean;
};

export type GuardJSON =
  | (GuardJSONBase & { kind: "cost"; costLimit: number; spent: number })
  | (GuardJSONBase & {
      kind: "time";
      timeLimit: number;
      elapsedMs: number;
      /** Optional: absent in checkpoints written before the join rule
       *  (decision 15); fromJSON reads absence as zero. */
      grantedMs?: number;
    });

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
  readonly dimension = "cost" as const;

  /** Cumulative cost charged since install. Serialized; survives
   *  interrupt/resume cycles. */
  private spent: number = 0;

  /** Stable id threaded into the emitted `guardTrip` cause so a boundary
   *  can identify which guard tripped (C2 ownedGuardIds matching). Not
   *  `readonly` so `fromJSON` can restore the serialized id (the id must
   *  survive interrupt/resume — see GuardJSON). */
  guardId: string = nextGuardId();

  /** See the Guard interface. All three serialized. `disarmed` is
   *  public for GuardScope's livelock check; mutate only via disarm(). */
  scopeIds: string[] = [];
  isRootBudget: boolean = false;
  disarmed: boolean = false;

  /** `label` is the user-facing name from `guard(label: "...")`. It rides
   *  the trip cause and the guard failure so users can tell WHICH guard
   *  tripped; guardId stays the internal identity for ownedGuardIds.
   *  `costLimit` is mutable ONLY through extendBudget. */
  constructor(
    public costLimit: number,
    public readonly label?: string,
  ) {}

  armedSignal(): AbortSignal | undefined {
    return undefined; // no abort plumbing — cost is checked at sync points
  }

  deliveredTrip(): boolean {
    return false; // cost trips are never leaf-delivered (no signal)
  }

  raisableTripAtStep(): boolean {
    return false; // see the Guard interface: cost belongs to the gates
  }

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
    if (this.disarmed) return null;
    if (this.spent <= this.costLimit) return null;
    return new GuardExceededError(
      "cost",
      this.costLimit,
      this.spent,
      this.guardId,
      this.label,
    );
  }

  extendBudget(delta: number): void {
    this.costLimit += clampGrant(delta, this);
    // No latch to reset: cost trips re-derive from spent > costLimit on
    // every check, so raising the limit is the whole re-arm.
  }

  disarm(): void {
    this.disarmed = true;
  }

  /** True while the guard is over budget AND still armed — the state a
   *  useless approval leaves behind (resumable-guards decision 8: an
   *  answer that leaves this true would re-trip forever and is a
   *  runtime error attributed to the answering handler). */
  overBudgetAndArmed(): boolean {
    return !this.disarmed && this.spent > this.costLimit;
  }

  currentLimit(): number {
    return this.costLimit;
  }

  spentAmount(): number {
    return this.spent;
  }

  /** Deliberately no-ops. A CostGuard can be SHARED across fork branches
   *  (cloneForBranch returns `this`), so an object-level suspended flag
   *  would blind SIBLING branches too: their charges would drop and
   *  their gates would open while one branch's handler deliberates —
   *  fail-open on the shared budget. Cost suspension is therefore
   *  branch-scoped, on the StateStack (`suspendedGuardIds`), where the
   *  enforce/charge walks consult it. Only per-branch-object state
   *  belongs here, which for cost is nothing.
   *
   *  CONSEQUENCE: because this is a no-op, this object cannot decline a
   *  check() on its own — every cost-suspension decision lives in
   *  StateStack.suspendedGuardIds, and any check() call site that does
   *  not go through the stack's suspension-aware walk
   *  (detectTrippedGuard / enforceGuards / chargeGuards) DOES NOT honor
   *  suspension. Do not add a direct check() walk; route through the
   *  stack. */
  suspend(): void {
    /* nothing — see above */
  }

  unsuspend(): void {
    /* nothing — see above */
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
    const json: GuardJSON = {
      kind: "cost",
      costLimit: this.costLimit,
      spent: this.spent,
      guardId: this.guardId,
    };
    if (this.label !== undefined) {
      json.label = this.label;
    }
    writeSharedGuardJSON(json, this);
    return json;
  }

  static fromJSON(j: { costLimit: number; spent: number; guardId?: string; label?: string } & SharedGuardJSONFields): CostGuard {
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
    const g = new CostGuard(j.costLimit, j.label);
    g.spent = j.spent;
    // Restore the serialized id so ownedGuardIds matching survives resume.
    // (Absent only in pre-Increment-2 checkpoints; keep the freshly-minted
    // id in that case.)
    if (j.guardId !== undefined) g.guardId = j.guardId;
    readSharedGuardJSON(j, g);
    return g;
  }
}

/** The GuardJSONBase fields both variants serialize identically. One
 *  writer/reader pair so a field added to one variant cannot silently
 *  miss the other (scopeIds nearly did, in review). `suspended`-style
 *  transient state deliberately has no place here. */
type SharedGuardJSONFields = {
  scopeIds?: string[];
  disarmed?: boolean;
  isRootBudget?: boolean;
};

function writeSharedGuardJSON(
  json: GuardJSON,
  g: { scopeIds: string[]; disarmed: boolean; isRootBudget: boolean },
): void {
  if (g.scopeIds.length > 0) json.scopeIds = g.scopeIds;
  if (g.disarmed) json.disarmed = true;
  if (g.isRootBudget) json.isRootBudget = true;
}

function readSharedGuardJSON(
  j: SharedGuardJSONFields,
  g: Guard,
): void {
  if (j.scopeIds !== undefined) g.scopeIds = j.scopeIds;
  if (j.disarmed) g.disarm();
  if (j.isRootBudget) g.isRootBudget = true;
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
  /** Monotonic clock stamp of the current window's start (via clock()).
   *  Only valid when state === "running". */
  private windowStart: number | undefined = undefined;
  /** AbortController whose .abort() fires when the timer expires. */
  private controller: AbortController | undefined = undefined;
  /** Node setTimeout handle for the in-process timer. */
  private timerHandle: TimerHandle | undefined = undefined;
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

  /** See the Guard interface. Object-level suspension is CORRECT for
   *  time (unlike cost): time clones are per-branch objects, so pausing
   *  this object's clock affects exactly one branch. Deliberately NOT
   *  in toJSON — a snapshot taken mid-suspension (a handler that
   *  propagates to the user) must revive a guard that meters. */
  private suspended: boolean = false;

  /** Total budget granted to THIS object by approvals (extendBudget),
   *  in ms. The runBatch join rule (resumable-guards decision 15, "the
   *  grant follows the budget") reads it off the CHARGED branch clone:
   *  when a branch's working time advances the parent's clock, the
   *  grants that funded that time widen the parent's limit by the same
   *  amount, so a legitimately approved branch cannot trip the parent
   *  at the join. Serialized (a granted clone must keep its grant
   *  across a checkpoint) but NOT copied by cloneForBranch — it means
   *  "granted during this branch", and starts at zero in every child. */
  private grantedMs: number = 0;

  /** Stable id threaded into the emitted `guardTrip` cause. Not `readonly`
   *  so `fromJSON` can restore the serialized id across interrupt/resume
   *  (see GuardJSON — the id must outlive a checkpoint or ownedGuardIds
   *  matching breaks). */
  guardId: string = nextGuardId();

  /** See CostGuard's label docstring — same contract. */
  readonly dimension = "time" as const;

  /** See the Guard interface. All three serialized. `disarmed` is
   *  public for GuardScope's livelock check; mutate only via disarm(). */
  scopeIds: string[] = [];
  isRootBudget: boolean = false;
  disarmed: boolean = false;

  /** `timeLimit` is mutable ONLY through extendBudget. */
  constructor(
    public timeLimit: number,
    public readonly label?: string,
  ) {}

  install(stack: StateStack): void {
    this.ensureFreshController(stack);
    this.startWindow();
  }

  uninstall(_stack: StateStack): void {
    // Pop-race fix: clear timer FIRST so a late-fire can't trip the
    // outer scope. Dropping the controller is all the signal cleanup
    // needed — the stack derives its composite from armed guards, and
    // popGuard rebuilds without this one.
    this.cancelTimer();
    if (this.state === "running") {
      this.elapsedMs += this.clock().now() - this.windowStart!;
      this.windowStart = undefined;
      this.state = "paused";
    }
    this.controller = undefined;
  }

  armedSignal(): AbortSignal | undefined {
    if (this.disarmed) return undefined;
    // While SUSPENDED (a handler is deliberating), this guard's signal —
    // aborted or not — leaves the composite: the deliberation must run
    // on a live stack even though the guard is tripped, and the
    // suspension brackets rebuild the composite on entry/exit.
    if (this.suspended) return undefined;
    // A fired controller whose trip has been ANSWERED (approve reset the
    // latches) is dead plumbing awaiting its re-mint at the next resume;
    // it must not poison the fresh composite. While the trip is LIVE
    // (tripped, unanswered) the aborted signal is the truth.
    if (this.controller?.signal.aborted && !this.tripped) return undefined;
    return this.controller?.signal;
  }

  deliveredTrip(): boolean {
    if (!this.controller?.signal.aborted) return false;
    const cause = readCause(this.controller.signal);
    return cause?.kind === "guardTrip" && !!(cause as { delivered?: boolean }).delivered;
  }

  raisableTripAtStep(): boolean {
    // Mirrors check()'s refusals (suspended / disarmed / consumed)
    // WITHOUT consuming the latch, plus the delivered exclusion. The
    // `consumed` term is what stops a REJECTED step-boundary trip from
    // being asked again at every following step: check() flipped it
    // when it produced the error the reject delivered, and only an
    // approve (extendBudget) resets it.
    if (this.suspended || this.disarmed || this.consumed) return false;
    if (this.deliveredTrip()) return false;
    return this.tripped || this.currentElapsed() >= this.timeLimit;
  }

  pause(): void {
    if (this.state === "paused") return;
    this.elapsedMs += this.clock().now() - this.windowStart!;
    this.windowStart = undefined;
    this.cancelTimer();
    this.state = "paused";
  }

  resume(stack: StateStack): void {
    // While suspended, resume() must NOT restart the clock:
    // Runner.beforeStep resumes every guard at every step entry, and an
    // interrupt handler's body executes steps — without this gate the
    // handler's first step would silently un-suspend the guard it is
    // adjudicating and its deliberation time would be billed. Only
    // unsuspend() re-enables resumption.
    if (this.suspended) return;
    if (this.state === "running") return;
    // Re-establish plumbing when it is missing (after deserialization —
    // toJSON only serializes elapsedMs + timeLimit) or DEAD (the
    // controller fired, the trip was approved, and the latches were
    // reset: an aborted controller cannot be reused, so re-arm mints a
    // fresh one and the stack recomposes).
    if (!this.controller || (this.controller.signal.aborted && !this.tripped)) {
      this.ensureFreshController(stack);
    }
    this.startWindow();
  }

  /** Pause the clock and pin it paused across beforeStep's resume-all.
   *  See resume() and the Guard interface. */
  suspend(): void {
    this.pause();
    this.suspended = true;
  }

  unsuspend(): void {
    // The clock restarts at the next beforeStep resume, not here — the
    // suspension bracket sits in runtime code, outside any step.
    this.suspended = false;
  }

  charge(_amount: number): void {
    /* nothing — TimeGuard accumulates wall-clock time, not LLM cost */
  }

  check(_stack: StateStack): GuardExceededError | null {
    if (this.suspended || this.disarmed) return null;
    if (this.consumed) return null;
    // The timer is an eager NOTIFIER (it cancels in-flight leaf ops);
    // the truth is elapsed working time versus the limit. A tight
    // Agency loop is an unbroken microtask chain that starves the
    // setTimeout macrotask, so `tripped` may still be false while the
    // budget is long gone — check the clock directly, or busy loops
    // escape time guards entirely (they used to). The latch is kept for
    // the signal-driven paths.
    if (!this.tripped && this.currentElapsed() < this.timeLimit) return null;
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
      this.label,
    );
  }

  isTripped(): boolean {
    return !this.disarmed && this.tripped;
  }

  extendBudget(deltaMs: number): void {
    const grant = clampGrant(deltaMs, this);
    this.timeLimit += grant;
    this.grantedMs += grant;
    // Reset BOTH latches — they are two fields with different jobs, and
    // missing either is wrong in a different direction. `tripped` is set
    // by the abort listener; leaving it set would re-trip at the next
    // check despite the new budget. `consumed` marks "check() already
    // returned this trip once"; leaving it set produces a guard that
    // NEVER trips again — fail-open, the worse direction.
    this.tripped = false;
    this.consumed = false;
    // If the clock is running, the armed timer still fires at the OLD
    // deadline; re-arm it against the new limit. (Paused/suspended
    // guards re-arm at their next resume, which reads timeLimit fresh.)
    if (this.state === "running") {
      this.cancelTimer();
      this.state = "paused";
      this.elapsedMs += this.clock().now() - this.windowStart!;
      this.windowStart = undefined;
      this.startWindow();
    }
  }

  disarm(): void {
    this.disarmed = true;
    // A disarmed dimension never trips: kill the armed timer so a late
    // fire cannot abort the branch (startWindow also refuses to arm a
    // new one while disarmed).
    this.cancelTimer();
  }

  /** See CostGuard.overBudgetAndArmed — same contract, time dimension. */
  overBudgetAndArmed(): boolean {
    return !this.disarmed && this.currentElapsed() >= this.timeLimit;
  }

  currentLimit(): number {
    return this.timeLimit;
  }

  spentAmount(): number {
    return this.currentElapsed();
  }

  /** Accrued working time plus any in-flight running window, in ms. */
  private currentElapsed(): number {
    return (
      this.elapsedMs +
      (this.state === "running" && this.windowStart !== undefined
        ? this.clock().now() - this.windowStart
        : 0)
    );
  }

  /** Public read of currentElapsed() for the runBatch join accounting:
   *  the parent advances by the max of its branch clones' snapshots. */
  snapshotElapsed(): number {
    return this.currentElapsed();
  }

  /** Public read of grantedMs for the runBatch join rule — see the
   *  field's docstring. */
  grantedTotal(): number {
    return this.grantedMs;
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
    const clone = new TimeGuard(remaining, this.label);
    clone.guardId = this.guardId;
    // Hand-copied: cloning and serialization are DIFFERENT paths, and a
    // field added to toJSON alone silently misses branches (rev-3 plan
    // review). scopeIds is how a branch trip finds its scope siblings;
    // root/disarmed state must follow the budget into the branch.
    // grantedMs is deliberately NOT copied: it means "granted during
    // this branch" and starts at zero in every child (the parent's own
    // past grants are already inside timeLimit, which `remaining` was
    // computed from).
    clone.scopeIds = this.scopeIds;
    clone.isRootBudget = this.isRootBudget;
    clone.disarmed = this.disarmed;
    return clone;
  }

  toJSON(): GuardJSON {
    // currentElapsed() charges the in-flight window if we're called
    // while running, so the snapshot reflects all elapsed time.
    const json: GuardJSON = {
      kind: "time",
      timeLimit: this.timeLimit,
      elapsedMs: this.currentElapsed(),
      grantedMs: this.grantedMs,
      guardId: this.guardId,
    };
    if (this.label !== undefined) {
      json.label = this.label;
    }
    writeSharedGuardJSON(json, this);
    return json;
  }

  static fromJSON(j: { timeLimit: number; elapsedMs: number; grantedMs?: number; guardId?: string; label?: string } & SharedGuardJSONFields): TimeGuard {
    const g = new TimeGuard(j.timeLimit, j.label);
    g.elapsedMs = j.elapsedMs;
    // Optional with a zero default: checkpoints written before the join
    // rule existed have no grantedMs, and "no recorded grants" is the
    // correct reading of them.
    g.grantedMs = j.grantedMs ?? 0;
    // Restore the serialized id so ownedGuardIds matching survives resume.
    if (j.guardId !== undefined) g.guardId = j.guardId;
    readSharedGuardJSON(j, g);
    // state stays "paused"; resume() at first runner step re-arms.
    return g;
  }

  /** Mint this guard's own controller and let the stack recompose. The
   *  guard never touches stack.abortSignal itself — the stack derives
   *  the composite from armedSignal() across its guards. */
  private ensureFreshController(stack: StateStack): void {
    this.controller = new AbortController();
    this.controller.signal.addEventListener("abort", () => {
      this.tripped = true;
    });
    stack.rebuildAbortSignal();
  }

  /** The time source. Reads the run's clock when a frame is present; a
   *  guard revived from a checkpoint runs frameless and meters against the
   *  real clock, exactly as before this seam existed. `__ctx()` is the
   *  canonical lax accessor; do not use `agency.ctxMaybe()` here (agency.ts
   *  imports TimeGuard, so that would be a circular import). */
  private clock(): Clock {
    return __ctx()?.clock ?? realClock;
  }

  private startWindow(): void {
    // A disarmed guard must never arm its abort timer: check() already
    // reports nothing, but a live timer would still fire the branch's
    // abort signal and cancel work the user explicitly un-metered. This
    // gate covers every arming path at once — install, resume, and a
    // cloneForBranch'd disarmed guard being installed on its branch.
    if (this.disarmed) return;
    const remaining = this.timeLimit - this.elapsedMs;
    const delay = remaining > 0 ? remaining : 0;
    this.timerHandle = this.clock().setTimer(() => {
      // Abort WITH a structured cause so any in-flight leaf op (sleep,
      // fetch, …) listening on the composed signal rejects carrying the
      // guard trip — not a bare cancel that the guard's `try` boundary
      // can't recognize and would let escape as an unhandled rejection.
      const spent = this.elapsedMs +
        (this.windowStart !== undefined
          ? this.clock().now() - this.windowStart
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
            label: this.label,
          }),
        ),
      );
    }, delay);
    this.windowStart = this.clock().now();
    this.state = "running";
  }

  private cancelTimer(): void {
    if (this.timerHandle) {
      this.clock().clearTimer(this.timerHandle);
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
    // Public: the trip-raise loop (guardTripInterrupt.ts) resolves the
    // tripped guard object from it.
    public readonly guardId: string = "",
    label?: string,
  ) {
    super(
      label !== undefined
        ? `guard "${label}" exceeded: ${type} limit ${limit}, spent ${spent}`
        : `guard exceeded: ${type} limit ${limit}, spent ${spent}`,
      makeAbortCause({ kind: "guardTrip", dimension: type, limit, spent, guardId, label }),
    );
    this.name = "GuardExceededError";
  }
}

export function isGuardExceededError(e: unknown): e is GuardExceededError {
  return e instanceof GuardExceededError;
}
