/**
 * `agency.interrupt` — user-facing TS encapsulation of the codegen
 * `interrupt(...)` dance.
 *
 * Generated Agency code today emits ~35 lines per `interrupt(...)`
 * call site (see lib/templates/backends/typescriptGenerator/
 * interruptAssignment.mustache and interruptReturn.mustache). This
 * helper mirrors that emission so TS code can raise interrupts the
 * same way an Agency `interrupt` statement would, fully participating
 * in handlers, checkpointing, and the resume protocol.
 *
 * # Mechanism
 *
 * Per call:
 *  1. Read the persisted interrupt id off the active state frame's
 *     `locals` (keyed by the surrounding step's path). If a response
 *     for that id is already recorded on the context, we are on the
 *     resume side — return it immediately. This is the resume-
 *     idempotency mechanism: the second execution of the same step
 *     body sees the stamp and short-circuits without re-firing
 *     handlers or creating a duplicate checkpoint.
 *  2. Otherwise, consult `interruptWithHandlers` (the same routine the
 *     codegen path uses). Approved / rejected outcomes flow straight
 *     back to the caller. This routes through `ctx.handlers`, which is
 *     a single stack shared with generated Agency code — so a TS
 *     function called from Agency code can have its
 *     `agency.interrupt(...)` caught by a `handle` block defined in the
 *     calling Agency code, and conversely an Agency `interrupt`
 *     statement nested inside a TS-installed `agency.withHandler(...)`
 *     can be caught by that TS handler. The two surfaces are equal
 *     participants in the same handler stack.
 *  3. If no handler intercepts, this is a brand-new propagation:
 *     - Persist the new interrupt id on `frame.locals` BEFORE
 *       creating the checkpoint so the id is captured in the
 *       snapshot. (Same ordering as the codegen template — the post-
 *       restore replay relies on reading the id from the restored
 *       frame.)
 *     - Create a checkpoint via `ctx.checkpoints.create` with the
 *       location attached to the active ALS callsite, attach the
 *       resulting id + checkpoint object onto the propagated
 *       interrupt, and `runner.halt(...)` with the interrupt array.
 *     - Throw `HaltSignal`, which the surrounding `Runner.step`
 *       absorbs once the runner is halted. This stops the caller
 *       from executing post-interrupt code on the first pass; on
 *       resume the same call site reaches step 1 and returns the
 *       user's response without re-tripping.
 *
 * # Interrupt-id key allocation
 *
 * The codegen path keys persisted ids off a compile-time-stable N per
 * call site (`__interruptId_${N}`). At runtime we don't have N, so
 * we key off the active callsite's `stepPath` instead:
 * `__interrupt_${stepPath}`. This makes the constraint explicit:
 *
 *   **One `agency.interrupt(...)` per step body.**
 *
 * Inside `agency.withResumableScope`, each `s.step(...)` body gets its
 * own substep path, so the natural pattern is "wrap each interrupt in
 * its own `s.step(...)`". When called from a TS function invoked from
 * generated code, the surrounding generated step's `stepPath` is the
 * key — so likewise, raise at most one interrupt per generated step
 * call site. Code that needs multiple sequential interrupts should
 * split them across multiple `s.step(...)` calls.
 *
 * What happens if you violate this: two `agency.interrupt(...)` calls
 * sharing the same `stepPath` write to the same `frame.locals` key.
 * The second call overwrites the first's persisted id, so the resume
 * path will only ever look up a response for the second interrupt. The
 * first interrupt's response (if any) is silently dropped, and the
 * resume re-runs the first interrupt's handlers from scratch instead of
 * short-circuiting. There is no thrown error today; the symptom is
 * "handlers fire twice on resume / first interrupt never resolves".
 * Splitting interrupts across `s.step(...)` calls is the only safe
 * pattern.
 *
 * # Halting and HaltSignal
 *
 * After `runner.halt(...)`, this function throws `HaltSignal` rather
 * than returning a synthetic "halted" value. The codegen template
 * stops execution with an explicit `return` after `runner.halt`; from
 * inside a TS helper we cannot force the caller to return, so the
 * throw is the only way to keep post-interrupt code from running on
 * the first pass. `Runner.step` catches `HaltSignal` when
 * `this.halted` is set; the user never sees it.
 *
 * # Required ALS frame
 *
 * Throws if called outside a frame seeded with a `Runner`. In practice
 * this means: inside `s.step(...)` of `agency.withResumableScope`, or
 * inside a TS function called from a generated Agency step body. Calls
 * from the top-level `withResumableScope` body (outside any
 * `s.step(...)`) intentionally have no runner in the ALS frame and
 * will throw — wrap the interrupt in `s.step(async () => { ... })`.
 */
import { getRuntimeContext } from "./asyncContext.js";
import { HaltSignal } from "./haltSignal.js";
import {
  interruptWithHandlers,
  isApproved,
  isRejected,
  type Interrupt,
  type InterruptResponse,
} from "./interrupts.js";

export type InterruptOpts<T = unknown> = {
  /** Stable identifier for the interrupt kind. Mirrors the kind a
   *  generated `interrupt foo` statement would emit. Used by handlers
   *  to decide whether to intercept. Optional — defaults to
   *  `"unknown"` so quick TS scripts can call `agency.interrupt({message:...})`
   *  without inventing a kind name. */
  kind?: string;
  /** Human-readable description shown to the user / dashboards when
   *  the interrupt propagates. */
  message: string;
  /** Arbitrary structured data attached to the interrupt. Forwarded
   *  to handlers and persisted on the propagated `Interrupt`.
   *  Optional — interrupts that carry no payload (e.g. a bare
   *  "needs user attention") can omit it. */
  data?: T;
};

export async function interrupt<T = unknown>(
  opts: InterruptOpts<T>,
): Promise<InterruptResponse> {
  const rt = getRuntimeContext();
  const { ctx, callsite, runner, stack } = rt;
  if (!runner) {
    throw new Error(
      "agency.interrupt() called without an active Runner. " +
        "Wrap the call in agency.withResumableScope's s.step(...) " +
        "or invoke it from a TS function called by generated Agency code.",
    );
  }
  if (!callsite) {
    throw new Error(
      "agency.interrupt() called without an active callsite. " +
        "This usually means the helper was invoked outside a step body.",
    );
  }
  const frame = stack.lastFrame();
  if (!frame) {
    throw new Error(
      "agency.interrupt() called with an empty state stack — no frame " +
        "is available to persist the interrupt id for resume.",
    );
  }

  const key = `__interrupt_${callsite.stepPath}`;

  // Resume path: if we already persisted an interrupt id at this
  // location AND the user has responded, return the response without
  // re-running the handler chain or creating another checkpoint. The
  // codegen template does exactly this with `__self.__interruptId_N`.
  const persistedId = frame.locals[key];
  if (persistedId !== undefined) {
    const resp = ctx.getInterruptResponse(persistedId);
    if (resp) return resp;
  }

  // First-time propagation: consult handlers.
  const kind = opts.kind ?? "unknown";
  const data = opts.data;
  const origin = callsite.moduleId;
  const handlerResult = await interruptWithHandlers(
    kind,
    opts.message,
    data,
    origin,
    ctx,
    stack,
  );

  if (isRejected(handlerResult)) return handlerResult;
  if (isApproved(handlerResult)) return handlerResult;

  // No handler responded — propagate. handlerResult is Interrupt[].
  const interrupts = handlerResult as Interrupt[];
  const intr = interrupts[0];

  // Persist id BEFORE checkpoint so the snapshot captures it. On
  // resume, the replay sees the id and short-circuits via the lookup
  // above.
  frame.locals[key] = intr.interruptId;
  const checkpointId = ctx.checkpoints.create(stack, ctx, {
    moduleId: callsite.moduleId,
    scopeName: callsite.scopeName,
    stepPath: callsite.stepPath,
  });
  intr.checkpointId = checkpointId;
  intr.checkpoint = ctx.checkpoints.get(checkpointId);

  // Halt shape mirrors the codegen template: `{messages, data}` in a
  // node body, raw `data` in a function/scope body. The graph engine
  // unwraps the former; the function-call path consumes the latter.
  const haltPayload = runner.isNodeContext
    ? { messages: rt.threads, data: interrupts }
    : interrupts;
  runner.halt(haltPayload);

  // Unwind the rest of the step body. `Runner.step` absorbs this
  // signal once `runner.halted` is true.
  throw new HaltSignal();
}
