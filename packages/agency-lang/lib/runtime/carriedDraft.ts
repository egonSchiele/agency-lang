import { AgencyAbort } from "./errors.js";
import type { State } from "./state/stateStack.js";
import type { RuntimeContext } from "./state/context.js";
import { getRuntimeContext } from "./asyncContext.js";

const TRUNCATE_AT = 500;

/** Stringify a value for a statelog payload, capped so a large partial
 *  cannot bloat an event. */
export function previewForLog(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > TRUNCATE_AT ? s.slice(0, TRUNCATE_AT) + "…(truncated)" : s;
}

/** The level rule (FOUR rungs), applied by every generated catch rung:
 *  replace the unwinding abort's carried draft with THIS frame's partial —
 *  the finalize result when one is passed (future), else the frame's
 *  savedDraft, else the callee's partial passed through unchanged when the
 *  trip escaped a return-position call (returnCarry, consume-once), else
 *  nothing (erase). Also the single statelog point for salvage tracking:
 *  the first call that touches a partial opens the abortUnwind span
 *  (stored on the abort), and every transition involving a partial emits
 *  one abortSalvage event. Empty-to-empty transitions are silent. */
export function __stampCarriedDraft(
  error: unknown,
  frame: State,
  scopeName: string,
  ctx: RuntimeContext<any>,
  finalizeResult?: { value: unknown },
): void {
  if (!(error instanceof AgencyAbort)) return;
  const prev = error.carriedDraft;
  const passThrough = error.returnCarry === true ? prev : undefined;
  error.returnCarry = false;
  const next = finalizeResult ?? frame.savedDraft ?? passThrough;
  error.carriedDraft = next;
  if (prev === undefined && next === undefined) return;
  const client = ctx?.statelogClient;
  if (!client) return;
  if (error.unwindSpanId === undefined) {
    error.unwindSpanId = client.startSpan("abortUnwind");
  }
  const action =
    next === undefined
      ? "erased"
      : finalizeResult === undefined && frame.savedDraft === undefined
        ? "passedThrough"
        : "carried";
  client.abortSalvage({
    action,
    scopeName,
    spanId: error.unwindSpanId,
    functionArgs: previewForLog(frame.args),
    partial: previewForLog(next !== undefined ? next.value : prev?.value),
  });
}

/** Return-position marker (level-rule rung 3). The compiler wraps the
 *  OUTERMOST call of every `return <call>(...)` statement (and the block
 *  equivalent that lowers to runner.halt) in try/catch and calls this
 *  before rethrowing. Argument subexpressions are evaluated BEFORE the
 *  wrapped call, so `return f(g())` with g tripping stays unmarked —
 *  only f's own trip (f-return-typed = this scope's return type) may
 *  pass through. */
export function __markReturnCarry(error: unknown): void {
  if (error instanceof AgencyAbort) {
    error.returnCarry = true;
  }
}

/** Delivery point: the guard (or any owned-trip consumer) is about to
 *  turn this abort into a value. Emit the closing event and end the
 *  unwind span. No-op when the unwind never touched a partial. Reads the
 *  statelog client via ALS because result.ts's __tryCall has no ctx
 *  parameter; null-safe so a trip surfacing outside any runtime frame
 *  never crashes on telemetry. */
export function closeUnwindSpan(abort: AgencyAbort): void {
  if (abort.unwindSpanId === undefined) return;
  let client;
  try {
    client = getRuntimeContext()?.ctx?.statelogClient;
  } catch {
    client = undefined;
  }
  client?.abortSalvage({
    action: "delivered",
    spanId: abort.unwindSpanId,
    partial:
      abort.carriedDraft !== undefined
        ? previewForLog(abort.carriedDraft.value)
        : undefined,
  });
  client?.endSpan(abort.unwindSpanId);
  abort.unwindSpanId = undefined;
}
