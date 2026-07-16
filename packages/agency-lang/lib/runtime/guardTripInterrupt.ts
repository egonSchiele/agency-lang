import type { Guard, GuardExceededError } from "./guard.js";
import { GuardScope } from "./guardScope.js";
import type { StateStack } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import {
  interruptWithHandlers,
  isApproved,
  isRejected,
  type Interrupt,
  type InterruptResponse,
} from "./interrupts.js";

/**
 * Cost-guard trips as interrupts (resumable-guards PR 2).
 *
 * The raising site is a dedicated idempotent gate step in `runPrompt`
 * (`pr.step("…guardGate…", () => raiseGuardTripsUntilClear(...))`),
 * placed immediately before each LLM request step. The gate LOOPS until
 * the stack is clear: one answered question does not mean the gate is
 * clear — approving the inner guard's trip can leave (or push) an OUTER
 * guard over its own limit, and each budget is owed its own question.
 * Because the gate runs before the request step and nothing paid happens
 * between them, not a cent can leak while a question is out.
 *
 * The gate body is idempotent by construction, which is what lets it
 * live in a PromptRunner step: on resume it re-detects, finds the
 * persisted interrupt id for the still-open trip in `stack.other`, and
 * applies the recorded answer instead of re-asking.
 *
 * Contract per trip: RESOLVING (approve applied, or someone else's
 * answer landed while we were parked) continues the loop — the caller
 * must never treat one resolution as clearance. REJECTING throws the
 * original GuardExceededError from the gate, and everything downstream —
 * AbortedResult, the level rule, finalize, the guard boundary's
 * conversion to success(draft)/failure — runs exactly as it always has.
 * UNANSWERED returns the Interrupt[] so PromptRunner.step's bailout
 * machinery (message snapshot, checkpoint, PromptBailout) surfaces it.
 */
export async function raiseGuardTripsUntilClear(
  ctx: RuntimeContext<any>,
  stack: StateStack,
): Promise<Interrupt[] | void> {
  let err: GuardExceededError | null;
  while ((err = stack.detectTrippedGuard()) !== null) {
    const tripped = innermostGuardById(stack, err.guardId);
    if (!tripped || tripped.isRootBudget) {
      // Root budgets never ask permission — the operator's ceiling keeps
      // today's hard throw (spawn path exits 3). A trip whose guard is
      // somehow gone from the stack also falls back to the throw.
      throw err;
    }

    // Dedupe (cost guards are SHARED objects across fork branches): if
    // another branch's question for this guard is already out, park on
    // it, then RE-DETECT — the answer may have refilled the budget, or a
    // different guard may be over now, or a third branch may have opened
    // a new question in the gap. The loop handles all three. Time clones
    // are per-branch objects, so for them this check never fires — that
    // is the "by construction" in cost-only dedupe; do not "fix" it.
    if (tripped.pendingTrip) {
      await tripped.pendingTrip.settled;
      continue;
    }

    const outcome = await raiseOneTrip(ctx, stack, tripped, err);
    if (outcome !== undefined) return outcome; // unanswered: surface
  }
}

/** Ask one guard's question. Returns undefined when the trip was
 *  RESOLVED in-process (the gate loop re-detects), the Interrupt[] when
 *  it must surface, and throws on reject (the original trip error) or a
 *  defective answer (GuardApproveError). */
async function raiseOneTrip(
  ctx: RuntimeContext<any>,
  stack: StateStack,
  tripped: Guard,
  err: GuardExceededError,
): Promise<Interrupt[] | undefined> {
  const scope = GuardScope.resolve(stack, tripped)!;
  const key = guardTripKey(tripped);

  // Resume path FIRST: an answered question must never re-ask. The key
  // is derived from guard state (see guardTripKey), so a replay of THIS
  // trip recomputes the same key, while the NEXT trip — possible only
  // after an approve changed the limit or a disarm — gets a fresh one.
  const persistedId = stack.other[key] as string | undefined;
  if (persistedId !== undefined) {
    const recorded = ctx.getInterruptResponse(persistedId);
    if (recorded) {
      delete stack.other[key];
      applyVerdict(recorded, scope, tripped, err);
      return undefined;
    }
  }

  // Mark the question open BEFORE the first await (an async body runs
  // synchronously to its first await, so set-before-await is real mutual
  // exclusion against sibling branches). NOTHING between the set and the
  // try: a throw in a gap would leak the record and park every future
  // branch forever — the exact deadlock the finally exists to prevent.
  tripped.pendingTrip = makePendingTrip();
  try {
    // Freeze the scope (and everything deeper) on THIS branch while the
    // question is out: no gating, no charging, no clock. Branch-scoped
    // via the stack bracket — sibling branches sharing the guard keep
    // metering (see the PR 1 deviation note in the plan).
    const suspensionToken = scope.suspendForDecision(stack);
    try {
      const snapshot = scope.snapshot(tripped.dimension);
      const verdict = await interruptWithHandlers(
        "std::guard",
        buildTripMessage(snapshot),
        { ...snapshot, draftValue: draftPreview(stack) },
        "std::guard",
        ctx,
        stack,
        {
          // Decision 3's visibility half: a handler registered INSIDE
          // this guard cannot adjudicate it.
          eligible: (entry) =>
            !entry.liveGuardIds.includes(tripped.guardId),
        },
      );
      if (isApproved(verdict) || isRejected(verdict)) {
        applyVerdict(verdict, scope, tripped, err);
        return undefined;
      }
      // Unanswered: persist the id so the resumed gate finds the answer,
      // then hand the batch to the PromptRunner step for its snapshot +
      // checkpoint + bailout machinery.
      const interrupts = verdict as Interrupt[];
      stack.other[key] = interrupts[0].interruptId;
      return interrupts;
    } finally {
      stack.endSuspension(suspensionToken);
    }
  } finally {
    // Settle on EVERY exit — resolve, surface, reject-throw, defective-
    // answer-throw. Three of the four leave by a throw or a bailout, and
    // a parked sibling waiting on anything rarer would hang the fork
    // join (`await Promise.allSettled`, runBatch). Clear the record
    // BEFORE settling so woken branches see it empty.
    const pending = tripped.pendingTrip;
    tripped.pendingTrip = undefined;
    pending?.settle();
  }
}

function applyVerdict(
  verdict: InterruptResponse,
  scope: GuardScope,
  tripped: Guard,
  err: GuardExceededError,
): void {
  if (isApproved(verdict)) {
    // GuardScope.extend enforces the whole answer contract: additive
    // grants, negative clamps, disarm, root refusal, and the useless-
    // approval error (leaves the tripped dimension over budget and
    // armed → would re-trip forever).
    scope.extend(
      ((verdict as { value?: unknown }).value ?? {}) as Parameters<
        GuardScope["extend"]
      >[0],
      tripped.dimension,
    );
    return;
  }
  // Rejected: the trip stands. Deliver the ORIGINAL error; from here the
  // carry-on-abort pipeline runs unmodified.
  throw err;
}

/** The trip interrupt's resume-idempotency key — DERIVED from guard
 *  state, never counted (resumable-guards decision 14; replay skips
 *  completed work, so counters count different events on replay). The
 *  five cases: (1) an approve strictly raises the tripped limit past
 *  `spent`, so limits strictly increase and the next trip's key differs;
 *  (2) a clamped-to-zero grant errors (decision 8) before the key could
 *  be reused; (3) disarm repeats the key, but a disarmed dimension never
 *  trips again; (4) a reject aborts the scope — no next trip; (5) the
 *  other dimension differs in the `#dimension` segment. */
function guardTripKey(g: Guard): string {
  const scopeIds = g.scopeIds.length > 0 ? g.scopeIds : [g.guardId];
  return `__guardTrip_${scopeIds.join(",")}#${g.dimension}@${g.currentLimit()}`;
}

function buildTripMessage(s: {
  label: string | null;
  dimension: "cost" | "time";
  limit: number;
  spent: number;
}): string {
  const name = s.label ? `Guard "${s.label}"` : "A guard";
  const unit =
    s.dimension === "cost"
      ? `$${s.spent.toFixed(6)} spent (limit $${s.limit})`
      : `${Math.round(s.spent)}ms elapsed (limit ${s.limit}ms)`;
  return `${name} exceeded its ${s.dimension} budget: ${unit}. Approve more budget, or reject to stop this work and salvage its draft.`;
}

/** Best-so-far preview for the handler: the innermost saved draft on the
 *  branch. A PREVIEW only — the authoritative salvage is computed by the
 *  unwind (level rule + finalize) if the trip is rejected; finalizes are
 *  one-shot and must not run speculatively for a maybe-approved trip. */
function draftPreview(stack: StateStack): unknown {
  for (let i = stack.stack.length - 1; i >= 0; i--) {
    const draft = stack.stack[i]?.savedDraft;
    if (draft !== undefined) return draft.value;
  }
  return null;
}

function innermostGuardById(stack: StateStack, guardId: string | undefined): Guard | null {
  if (!guardId) return null;
  for (let i = stack.guards.length - 1; i >= 0; i--) {
    if (stack.guards[i].guardId === guardId) return stack.guards[i];
  }
  return null;
}

function makePendingTrip(): { settled: Promise<void>; settle: () => void } {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}
