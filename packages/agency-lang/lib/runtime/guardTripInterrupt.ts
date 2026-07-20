import type { Guard, GuardExceededError } from "./guard.js";
import { GuardScope } from "./guardScope.js";
import type { StateStack } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import {
  interrupt,
  interruptWithHandlers,
  isApproved,
  isRejected,
  type Interrupt,
  type InterruptResponse,
} from "./interrupts.js";
import renderGuardTripMessage from "../templates/runtime/guardTripMessage.js";
import type { SourceLocationOpts } from "./state/checkpointStore.js";

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
  detect: () => GuardExceededError | null = () => stack.detectTrippedGuard(),
): Promise<Interrupt[] | void> {
  let err: GuardExceededError | null;
  while ((err = detect()) !== null) {
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
  // Reads the STACK mark, not the executing-handlers ALS: the pause
  // refusals must survive the ALS coming up empty (issue #616), and the
  // stack is reachable here as a plain parameter.
  const inHandler = stack.executingHandlerEntries.length > 0;

  // Resume path FIRST: an answered question must never re-ask. The key
  // is derived from guard state (see guardTripKey), so a replay of THIS
  // trip recomputes the same key, while the NEXT trip — possible only
  // after an approve changed the limit or a disarm — gets a fresh one.
  const persistedId = stack.other[key] as string | undefined;
  if (persistedId !== undefined) {
    const recorded = ctx.getInterruptResponse(persistedId);
    if (recorded) {
      delete stack.other[key];
      applyVerdict(recorded, scope, tripped, err, stack);
      return undefined;
    }
    // A persisted open question must not re-surface from inside a
    // handler: re-surfacing pauses, and a handler cannot pause. The
    // trip stands as a rejection; the guard boundary converts it. The
    // stale key is dropped so a later out-of-handler replay does not
    // resurrect a question whose trip already resolved as a rejection.
    if (inHandler) {
      delete stack.other[key];
      throw err;
    }
    // The question is already OPEN (persisted, no answer yet — e.g. a
    // resume triggered by answering a DIFFERENT interrupt in the same
    // batch replays this gate). Re-surface the SAME interrupt id rather
    // than re-running the chain and minting a fresh one: a fresh id
    // would orphan the pending answer and ask the user twice.
    const snapshot = scope.snapshot(tripped.dimension);
    return [
      interrupt({
        effect: "std::guard",
        message: buildTripMessage(snapshot),
        data: { ...snapshot, draftValue: draftPreview(stack) },
        origin: "std::guard",
        runId: ctx.getRunId(),
        interruptId: persistedId,
      }),
    ];
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
        applyVerdict(verdict, scope, tripped, err, stack);
        return undefined;
      }
      // Unanswered: persist the id so the resumed gate finds the answer,
      // then hand the batch to the PromptRunner step for its snapshot +
      // checkpoint + bailout machinery.
      const interrupts = verdict as Interrupt[];
      // Inside a handler, renderVerdict already refuses unanswered
      // raises when its ALS is intact — this stack-read check is the
      // one that holds when the ALS is not. Reaching it means a pause
      // was about to be persisted from inside a handler; fail as the
      // rejection it must be, never as serialized state.
      if (inHandler) {
        throw err;
      }
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
  stack: StateStack,
): void {
  if (isApproved(verdict)) {
    const payload = ((verdict as { value?: unknown }).value ?? {}) as Parameters<
      GuardScope["extend"]
    >[0];
    // GuardScope.extend enforces the whole answer contract: additive
    // grants, negative clamps, disarm, root refusal, and the useless-
    // approval error (leaves the tripped dimension over budget and
    // armed → would re-trip forever).
    scope.extend(payload, tripped.dimension);
    // approve({message}) is the feedback channel (PR 4): the merged
    // message (effectMerge newline-joins multiple handlers') queues on
    // the raising branch and rides into the thread as a labeled
    // user-role message before the branch's next model request. Queued
    // AFTER extend so a defective answer (GuardApproveError) never
    // leaves its message behind.
    //
    // NOTE: this is the runtime INTERPRETING one field of the approve
    // payload — `message` has channel semantics the way `maxCost` has
    // grant semantics, but nothing declares that; a payload key either
    // does something magical here or nothing at all. When approve
    // payloads become typed per effect (#555), how a payload gets USED
    // should be declared alongside its shape.
    //
    // The typeof guard is the trust boundary: payloads arrive from
    // untyped JS handlers and from IPC, and a non-string `message`
    // must not reach the serialized queue or userMessage().
    if (typeof payload.message === "string" && payload.message !== "") {
      // Truthy label check, not `??`: an empty-string label means
      // unlabeled everywhere else, and must not produce `guard:`.
      stack.queueGuardFeedback(
        payload.message,
        `guard:${tripped.label ? tripped.label : tripped.dimension}`,
      );
    }
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
  const cost = s.dimension === "cost";
  return renderGuardTripMessage({
    name: s.label ? `Guard "${s.label}"` : "A guard",
    dimension: s.dimension,
    spentText: cost ? `$${s.spent.toFixed(6)} spent` : `${Math.round(s.spent)}ms elapsed`,
    limitText: cost ? `$${s.limit}` : `${s.limit}ms`,
  });
}

/** Best-so-far preview for the handler: the innermost saved draft on the
 *  branch. A PREVIEW only — the authoritative salvage is computed by the
 *  unwind (level rule + finalize) if the trip is rejected; finalizes are
 *  one-shot and must not run speculatively for a maybe-approved trip. */
function draftPreview(stack: StateStack): unknown {
  const innermostDraft = [...stack.stack]
    .reverse()
    .find((frame) => frame?.savedDraft !== undefined);
  return innermostDraft?.savedDraft?.value ?? null;
}

function innermostGuardById(stack: StateStack, guardId: string | undefined): Guard | null {
  if (!guardId) return null;
  return (
    [...stack.guards].reverse().find((g) => g.guardId === guardId) ?? null
  );
}

function makePendingTrip(): { settled: Promise<void>; settle: () => void } {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}


/** Control-flow signal thrown by _runPrompt's cancellation classifier
 *  when an in-flight request died to a NON-ROOT guard trip on this
 *  stack: the surrounding request-step wrapper in runPrompt catches it,
 *  runs a retry gate (which raises the trip resumably), and — on
 *  approve — re-issues the request from the current thread state. The
 *  cancelled generation is honestly gone; the retry is a fresh request.
 *  Never escapes runPrompt. */
export class GuardTripRetry extends Error {
  constructor(public readonly guardId: string) {
    super("GuardTripRetry");
    this.name = "GuardTripRetry";
  }
}

/** The RUNNER surface for the same question the prompt gates ask: called
 *  at step entry (before shouldSkip's consuming walk) when
 *  `stack.firstRaisableTrip()` found an over-budget armed guard —
 *  PR 3's time trips, which unlike cost trips become detectable at
 *  arbitrary step boundaries. Approve applies and execution continues
 *  into the step; reject throws the trip (identical unwind to the old
 *  shouldSkip throw); unanswered checkpoints at THIS step and halts the
 *  runner (the agency.interrupt dance — the caller returns without
 *  running the step body, and Runner.step's halt handling does the
 *  rest). Returns true iff the runner halted. */
export async function raiseGuardTripsAtStep(args: {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  location: SourceLocationOpts;
  isNodeContext: boolean;
  threads: unknown;
  halt: (payload: unknown) => void;
}): Promise<boolean> {
  const { ctx, stack } = args;
  // Step-scoped detection: converse only about trips the step probe
  // admits (time guards with a live, unhandled trip). The gates' full
  // detectTrippedGuard walk would also check() cost guards here — and a
  // cost guard left over budget by a REJECTED gate question would be
  // re-asked at every following step, delivering its reject outside the
  // owning guard boundary.
  const outcome = await raiseGuardTripsUntilClear(ctx, stack, () =>
    stack.detectStepRaisableTrip(),
  );
  if (outcome === undefined) return false; // clear — run the step
  // Unanswered: surface through the runner. The interrupt id is already
  // persisted in stack.other (raiseOneTrip did it); stamp the checkpoint
  // at this step so the resumed replay re-enters HERE, re-detects, and
  // applies the recorded answer before the step body ever runs — which
  // is what makes this raise point replay-safe by construction.
  stack.assertNoExecutingHandlers();
  const checkpointId = ctx.checkpoints.create(stack, ctx, args.location);
  const checkpoint = ctx.checkpoints.get(checkpointId);
  outcome.forEach((intr) => {
    intr.checkpointId = checkpointId;
    intr.checkpoint = checkpoint;
  });
  ctx.statelogClient.checkpointCreated({
    checkpointId,
    reason: "interrupt",
    sourceLocation: args.location,
  });
  args.halt(
    args.isNodeContext
      ? { messages: args.threads, data: outcome }
      : outcome,
  );
  return true;
}
