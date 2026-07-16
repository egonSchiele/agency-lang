import {
  AgencyAbort,
  describeAbortCause,
  type AbortCause,
} from "./errors.js";
import type { State } from "./state/stateStack.js";
import { agencyStore } from "./asyncContext.js";
import { hasInterrupts } from "./interrupts.js";
import type { StatelogClient } from "../statelogClient.js";

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

/**
 * The value a function returns when an abort stops it.
 *
 * An aborted function does not throw past its own frame. The frame catches
 * the abort and returns one of these instead. It holds three things: the
 * cause of the abort, the frame's best-so-far value (its saved draft, if
 * it saved one), and a marker so callers can recognize it. The generated
 * check after each call spots the marker and returns the caller's own
 * AbortedResult in turn. So an abort travels up the stack as a plain
 * return value, the same way interrupts do.
 *
 * Exceptions still exist, but only inside a single frame: a cancelled
 * llm() call rejects, and the frame that was running converts that
 * rejection into this value at its own catch. Above node level (the graph
 * engine, the CLI entry) aborts are converted back to exceptions, so
 * everything outside compiled code behaves exactly as before.
 *
 * Instances are immutable. Every hop up the stack creates a new one, so
 * there is no shared object to mutate and no ordering to get wrong.
 */
export class AbortedResult {
  readonly __type = "abortedResult" as const;
  /** Why the run stopped (guard trip, cancel, kill, ...). This is the
   *  SAME object the abort signal carries, so its `delivered` flag keeps
   *  working across both delivery paths. */
  readonly cause: AbortCause;
  /** The aborted frame's best-so-far value. Wrapped so a saved null is
   *  distinct from "no partial". */
  readonly partial?: { value: unknown };
  /** Statelog span covering this abort's travel. Opened by the first hop
   *  that has a partial to report; closed at delivery. */
  readonly unwindSpanId?: string;

  private constructor(
    cause: AbortCause,
    partial: { value: unknown } | undefined,
    unwindSpanId: string | undefined,
  ) {
    this.cause = cause;
    this.partial = partial;
    this.unwindSpanId = unwindSpanId;
  }

  /** A frame caught an abort exception. The frame stops here and returns
   *  its saved draft as its partial — or nothing, if it never saved one.
   *  This is the only place an abort exception becomes a value. */
  static fromError(
    error: AgencyAbort,
    frame: State,
    scopeName: string,
  ): AbortedResult {
    const result = new AbortedResult(
      error.agencyCause,
      frame.savedDraft,
      undefined,
    );
    return result.logged("carried", frame, scopeName);
  }

  /** A callee handed this frame an aborted result outside return
   *  position. This frame stops too, and returns ITS OWN saved draft.
   *  The callee's partial is dropped here: salvage is opt-in per level.
   *  (In return position no code runs at all — `return f()` simply
   *  returns f's AbortedResult, which is what passes a partial through.) */
  carryThrough(frame: State, scopeName: string): AbortedResult {
    const next = new AbortedResult(
      this.cause,
      frame.savedDraft,
      this.unwindSpanId,
    );
    return next.logged("carried", frame, scopeName, this.partial);
  }

  /** An aborted value tried to enter a call as an ARGUMENT (`f(g())`
   *  where g aborted). The call never runs; the abort continues without
   *  the partial, because an argument-position partial has no type-sound
   *  place to land — g's partial is g-typed, not f-return-typed. */
  droppedAtArgPosition(): AbortedResult {
    return this.dropped("droppedAtArgPosition");
  }

  /** A branch's abort is crossing the fork boundary. The partial stays
   *  in the branch: which branch fails first is a race, and one branch's
   *  value has the wrong shape for the fork. */
  atForkBoundary(): AbortedResult {
    return this.dropped("clearedAtFork");
  }

  /** The partial's value, or null when there is no partial. The ONLY way
   *  generated code reads a partial: the `{ value }` wrapper (which keeps
   *  a saved null distinct from no-partial) is internal to this class. */
  partialValueOrNull(): unknown {
    return this.partial !== undefined ? this.partial.value : null;
  }

  /** A finalize-bearing scope is stopping: run its finalize, and its
   *  return becomes the scope's partial. A finalize failure never masks
   *  the trip — the abort continues with the partial this instance
   *  already holds (the saved draft, or nothing) and the failure is
   *  logged. Two extra failure shapes are backstops: a finalize that
   *  resolves to interrupts (the checker forbids what it can see, but an
   *  IMPORTED interrupting callee is invisible to it), and one that
   *  resolves to an aborted result of its own (the tripped guard's
   *  signal is still firing, so a callee inside the finalize can be
   *  stopped). */
  async withFinalize(
    finalize: () => Promise<unknown>,
    scopeName: string,
  ): Promise<AbortedResult> {
    let value: unknown;
    try {
      value = await finalize();
    } catch (finalizeError) {
      this.logFinalizeFailure(scopeName, finalizeError);
      return this;
    }
    if (hasInterrupts(value) || isAborted(value)) {
      this.logFinalizeFailure(scopeName, value);
      return this;
    }
    return new AbortedResult(this.cause, { value }, this.unwindSpanId).logged(
      "carried",
      undefined,
      scopeName,
    );
  }

  /** A failed finalize is a footnote to the trip, never its replacement:
   *  log it and keep the abort's existing story. */
  private logFinalizeFailure(scopeName: string, failure: unknown): void {
    const client = statelogClient();
    client?.error?.({
      errorType: "finalizeError",
      message:
        failure instanceof Error ? failure.message : previewForLog(failure),
      functionName: scopeName,
    });
  }

  /** The guard that owns this trip is converting it into a Result.
   *  Emits the closing statelog event and ends the unwind span. Returns
   *  the partial to salvage, or undefined for no salvage. */
  deliver(): { value: unknown } | undefined {
    const client = statelogClient();
    if (this.unwindSpanId !== undefined) {
      client?.abortSalvage({
        action: "delivered",
        spanId: this.unwindSpanId,
        partial:
          this.partial !== undefined
            ? previewForLog(this.partial.value)
            : undefined,
      });
      client?.endSpan(this.unwindSpanId);
    }
    return this.partial;
  }

  /** Rebuild the exception form, for the places that still speak
   *  exceptions: the graph engine above nodes, and runBatch's join
   *  points. The cause object is passed through by identity, so the
   *  `delivered` de-dup flag keeps working. */
  toError(): AgencyAbort {
    return new AgencyAbort(describeAbortCause(this.cause), this.cause);
  }

  /** Drop the partial, emit the reason, close the span (the partial's
   *  story ends where it is dropped). */
  private dropped(
    action: "droppedAtArgPosition" | "clearedAtFork",
  ): AbortedResult {
    if (this.partial === undefined) {
      return this;
    }
    const client = statelogClient();
    client?.abortSalvage({
      action,
      spanId: this.unwindSpanId,
      partial: previewForLog(this.partial.value),
    });
    client?.endSpan(this.unwindSpanId);
    return new AbortedResult(this.cause, undefined, undefined);
  }

  /** Emit one statelog event for a hop, opening the unwind span lazily.
   *  Silent when no partial is involved on either side, so an abort
   *  through undrafted code logs nothing. Returns the instance to log
   *  (with the span id filled in), keeping construction declarative. */
  private logged(
    action: "carried",
    frame: State | undefined,
    scopeName: string,
    droppedPartial?: { value: unknown },
  ): AbortedResult {
    const gained = this.partial;
    if (gained === undefined && droppedPartial === undefined) {
      return this;
    }
    const client = statelogClient();
    if (!client) {
      return this;
    }
    const spanId = this.unwindSpanId ?? client.startSpan("abortUnwind");
    const shown = gained ?? droppedPartial;
    client.abortSalvage({
      action: gained !== undefined ? action : "erased",
      scopeName,
      spanId,
      functionArgs: frame !== undefined ? previewForLog(frame.args) : undefined,
      partial: shown !== undefined ? previewForLog(shown.value) : undefined,
    });
    if (spanId === this.unwindSpanId) {
      return this;
    }
    return new AbortedResult(this.cause, this.partial, spanId);
  }
}

/** True when a value is a callee's aborted return. Generated code calls
 *  this after every Agency call, next to its hasInterrupts check. */
export function isAborted(value: unknown): value is AbortedResult {
  return value instanceof AbortedResult;
}

/** Statelog access without requiring an ALS frame: aborts can surface
 *  outside any Agency execution frame (e.g. at process teardown), and
 *  telemetry must never crash the unwind. */
function statelogClient(): StatelogClient | undefined {
  return agencyStore.getStore()?.ctx?.statelogClient;
}
